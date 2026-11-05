// Función de Netlify: toda la API en /api/*
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApi } from '../../src/core.mjs';
import { rulesFromEvent } from '../../src/rules.mjs';
import { createBlobsStore } from '../../src/store-blobs.mjs';
import { corsHeaders } from '../../src/cors.mjs';

export const config = { path: '/api/*' };

// Fechas límite y mesas salen de public/event.json (viaja con la función por included_files).
// Si no se puede leer, se usan los valores por defecto de src/rules.mjs.
async function loadRules() {
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task'].filter(Boolean);
  for (const root of roots) {
    try {
      return rulesFromEvent(JSON.parse(await fs.readFile(path.join(root, 'public', 'event.json'), 'utf8')));
    } catch {
      /* probar la siguiente ruta */
    }
  }
  return rulesFromEvent({});
}

let api;
const getApi = async () => {
  if (!api) {
    const store = createBlobsStore();
    api = createApi({ store, adminToken: process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD, rules: await loadRules() });
  }
  return api;
};

export default async (req) => {
  const url = new URL(req.url);
  const cors = corsHeaders(url.pathname);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let body;
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    const text = await req.text();
    if (text.length > 10_000) return json(413, { error: 'payload_too_large' }, cors);
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(400, { error: 'invalid_json' }, cors);
    }
  }
  const headers = Object.fromEntries(req.headers);
  const { status, body: out } = await (await getApi()).handle({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body,
    headers,
  });
  return json(status, out, cors);
};

const json = (status, data, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
