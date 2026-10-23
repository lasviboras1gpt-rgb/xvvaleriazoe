import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApi } from '../src/core.mjs';
import { createPush, validateSubscription } from '../src/push.mjs';
import { createFileStore } from '../src/store-file.mjs';

const PW = 'clave-de-prueba-0123456789-abcdef';
const admin = { authorization: `Bearer ${PW}`, host: 'xv.example.com' };
const guestH = { host: 'xv.example.com' };

const subFor = (n) => ({
  endpoint: `https://push.example.com/send/${n}`,
  keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
});

async function setup({ senderImpl } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-push-'));
  const store = createFileStore(dir);
  const calls = [];
  const sender = {
    generateVAPIDKeys: () => ({ publicKey: 'PUB-KEY', privateKey: 'PRIV-KEY' }),
    sendNotification: async (sub, body, opts) => {
      calls.push({ sub, payload: JSON.parse(body), opts });
      if (senderImpl) return senderImpl(sub);
    },
  };
  const push = createPush({ store, sender, log: { error() {} } });
  let t = 1_800_000_000_000;
  const api = createApi({ store, adminToken: PW, now: () => (t += 1000), push });
  const call = (m, p, body, headers = guestH) => api.handle({ method: m, path: p, body, headers });
  const create = async (guest = 'Familia Pérez', seats = 4) =>
    (await call('POST', '/api/admin/invitations', { guest, seats, table: '3' }, admin)).body.invitation;
  return { call, create, calls, store, push, dir };
}

test('la clave pública se crea sola, se conserva y exige contraseña', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/api/admin/push/key')).status, 401);
  const a = await call('GET', '/api/admin/push/key', undefined, admin);
  const b = await call('GET', '/api/admin/push/key', undefined, admin);
  assert.equal(a.body.publicKey, 'PUB-KEY');
  assert.equal(b.body.publicKey, 'PUB-KEY');
});

test('suscribir: valida el formato, es idempotente y se puede cancelar', async () => {
  const { call, store } = await setup();
  const sub = subFor(1);
  assert.equal((await call('POST', '/api/admin/push/subscribe', { subscription: sub }, admin)).status, 200);
  assert.equal((await call('POST', '/api/admin/push/subscribe', { subscription: sub, label: 'Mi Android' }, admin)).status, 200);
  assert.equal((await store.listSubscriptions()).length, 1);
  for (const bad of [null, {}, { endpoint: 'http://x.com/a', keys: sub.keys }, { endpoint: 'https://x.com', keys: {} }, { endpoint: 'no-url', keys: sub.keys }]) {
    assert.equal((await call('POST', '/api/admin/push/subscribe', { subscription: bad }, admin)).status, 400);
  }
  assert.equal((await call('POST', '/api/admin/push/subscribe', { subscription: sub })).status, 401);
  await call('POST', '/api/admin/push/unsubscribe', { endpoint: sub.endpoint }, admin);
  assert.equal((await store.listSubscriptions()).length, 0);
});

test('envía push al abrir, confirmar, modificar y rechazar (a cada teléfono)', async () => {
  const { call, create, calls } = await setup();
  await call('POST', '/api/admin/push/subscribe', { subscription: subFor(1) }, admin);
  await call('POST', '/api/admin/push/subscribe', { subscription: subFor(2) }, admin);
  const inv = await create('Marta', 4);
  await call('POST', `/api/invitation/${inv.id}/open`);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 4 });
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 });
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: false });
  const texts = calls.filter((c) => c.sub.endpoint.endsWith('/1')).map((c) => c.payload.body);
  assert.deepEqual(texts, [
    'Marta abrió su invitación por primera vez',
    'Marta confirmó 4 lugares de 4 asignados',
    'Marta cambió de 4 lugares a 2 lugares',
    'Marta cambió su respuesta: ya no podrá asistir',
  ]);
  assert.equal(calls.length, 8); // 4 avisos × 2 teléfonos
  assert.equal(calls[0].payload.title, 'Invitación abierta');
  assert.equal(calls[0].payload.url, '/admin/#actividad');
  assert.equal(calls[0].opts.vapidDetails.subject, 'https://xv.example.com');
  assert.equal(calls[0].opts.vapidDetails.publicKey, 'PUB-KEY');
});

test('no envía push cuando no hay cambios ni dentro del enfriamiento de aperturas', async () => {
  const { call, create, calls } = await setup();
  await call('POST', '/api/admin/push/subscribe', { subscription: subFor(1) }, admin);
  const inv = await create('Luis', 3);
  await call('POST', `/api/invitation/${inv.id}/open`);
  await call('POST', `/api/invitation/${inv.id}/open`);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 });
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 });
  assert.equal(calls.length, 2); // 1 apertura + 1 confirmación
  const rej = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 9 });
  assert.equal(rej.status, 400);
  assert.equal(calls.length, 2); // un intento rechazado no avisa
});

test('un teléfono caducado (410) se elimina; un error de push no rompe la confirmación', async () => {
  const dead = subFor(1), alive = subFor(2), flaky = subFor(3);
  const { call, create, store } = await setup({
    senderImpl: (sub) => {
      if (sub.endpoint === dead.endpoint) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (sub.endpoint === flaky.endpoint) throw new Error('red caída');
    },
  });
  for (const s of [dead, alive, flaky]) await call('POST', '/api/admin/push/subscribe', { subscription: s }, admin);
  const inv = await create('Ana', 2);
  const r = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.rsvp.status, 'confirmed');
  const left = (await store.listSubscriptions()).map((s) => s.endpoint).sort();
  assert.deepEqual(left, [alive.endpoint, flaky.endpoint].sort()); // solo se borra el 410
});

test('sin push configurado, la invitación funciona igual y el panel recibe 503', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-nopush-'));
  const api = createApi({ store: createFileStore(dir), adminToken: PW });
  const call = (m, p, body, h = guestH) => api.handle({ method: m, path: p, body, headers: h });
  const inv = (await call('POST', '/api/admin/invitations', { guest: 'X', seats: 2 }, admin)).body.invitation;
  assert.equal((await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 })).status, 200);
  assert.equal((await call('GET', '/api/admin/push/key', undefined, admin)).status, 503);
});

test('el aviso de prueba llega a los teléfonos suscritos', async () => {
  const { call, calls } = await setup();
  await call('POST', '/api/admin/push/subscribe', { subscription: subFor(1) }, admin);
  const r = await call('POST', '/api/admin/push/test', {}, admin);
  assert.equal(r.body.sent, 1);
  assert.equal(calls[0].payload.title, 'Notificaciones activadas');
});

test('validateSubscription', () => {
  assert.ok(validateSubscription(subFor(1)));
  assert.equal(validateSubscription({ endpoint: 'https://' + 'a'.repeat(800), keys: subFor(1).keys }), null);
});
