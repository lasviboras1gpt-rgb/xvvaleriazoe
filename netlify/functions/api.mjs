// Función de Netlify: toda la API en /api/*
import { createApi } from '../../src/core.mjs';
import { createBlobsStore } from '../../src/store-blobs.mjs';
import { corsHeaders } from '../../src/cors.mjs';

export const config = { path: '/api/*' };

let api;
const getApi = () => {
  if (!api) {
    const store = createBlobsStore();
    api = createApi({ store, adminToken: process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD });
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
  const { status, body: out } = await getApi().handle({
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
