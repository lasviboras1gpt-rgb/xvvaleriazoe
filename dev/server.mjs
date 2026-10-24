// Servidor local para probar TODO sin Netlify: node dev/server.mjs
// Variables: PORT (8888), ADMIN_TOKEN (opcional), DATA_DIR (./.data)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/core.mjs';
import { createFileStore } from '../src/store-file.mjs';
import { renderInvitePage } from '../src/page.mjs';
import { createPush } from '../src/push.mjs';
import { corsHeaders } from '../src/cors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const port = Number(process.env.PORT || 8888);
const store = createFileStore(process.env.DATA_DIR || path.join(root, '.data'));
const api = createApi({ store, adminToken: process.env.ADMIN_TOKEN || undefined, push: createPush({ store, allowInsecure: true }) });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const cors = corsHeaders(url.pathname);
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      let body;
      if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
        const chunks = [];
        for await (const c of req.stream ?? req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          res.writeHead(400, { 'content-type': 'application/json', ...cors });
          return res.end('{"error":"invalid_json"}');
        }
      }
      const out = await api.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: req.headers,
      });
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
      return res.end(JSON.stringify(out.body));
    }

    if (url.pathname.startsWith('/i/')) {
      const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '');
      const template = await fs.readFile(path.join(pub, 'invite.html'), 'utf8');
      const event = JSON.parse(await fs.readFile(path.join(pub, 'event.json'), 'utf8'));
      const html = await renderInvitePage({ template, origin: `http://${req.headers.host}`, id, event, store });
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }

    let rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const file = path.normalize(path.join(pub, rel));
    if (!file.startsWith(pub)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('No encontrado');
    }
    console.error(e);
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(port, () => {
  console.log(`Servidor local: http://localhost:${port}   (${process.env.ADMIN_TOKEN ? 'con clave de administración' : 'sin clave de administración'})`);
});
