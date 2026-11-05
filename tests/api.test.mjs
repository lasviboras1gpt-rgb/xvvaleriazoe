import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../src/core.mjs';
import { createFileStore } from '../src/store-file.mjs';

const PW = 'clave-de-prueba-0123456789-abcdef';
const admin = { authorization: `Bearer ${PW}` };

async function setup(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-test-'));
  let t = Date.parse("2026-11-04T12:00:00-06:00");
  const clock = { now: () => (t += 1000), advance: (ms) => (t += ms) };
  const api = createApi({ store: createFileStore(dir), adminToken: PW, now: clock.now, ...extra });
  const call = (method, p, body, headers = {}, query = {}) => api.handle({ method, path: p, body, headers, query });
  const create = async (guest = 'Familia Pérez', seats = 4, table = '7') =>
    (await call('POST', '/api/admin/invitations', { guest, seats, table }, admin)).body.invitation;
  return { call, create, clock, dir };
}

test('crea invitaciones y la vista pública solo expone lo necesario', async () => {
  const { call, create } = await setup();
  const inv = await create();
  assert.equal(inv.seats, 4);
  assert.match(inv.id, /^[a-z0-9]{10}$/);
  const pub = await call('GET', `/api/invitation/${inv.id}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.body).sort(), ['guest', 'id', 'rsvp', 'rsvpOpen', 'rsvpUntil', 'seats', 'table']);
  assert.equal(pub.body.guest, 'Familia Pérez');
});

test('NO permite confirmar más lugares de los asignados', async () => {
  const { call, create } = await setup();
  const inv = await create('Ana', 3);
  const r = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 4 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'count_exceeds_seats');
  const ok = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rsvp.count, 3);
  for (const bad of [0, -1, 1.5, 'x', null]) {
    const r2 = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: bad });
    assert.equal(r2.status, 400, `count=${bad}`);
  }
});

test('genera eventos: confirmación, modificación, y nada si no hay cambios', async () => {
  const { call, create } = await setup();
  const inv = await create('Luis', 5);
  const rsvp = (b) => call('POST', `/api/invitation/${inv.id}/rsvp`, b);
  await rsvp({ attending: true, count: 4 });
  await rsvp({ attending: true, count: 4 }); // igual: sin evento
  await rsvp({ attending: true, count: 2 });
  await rsvp({ attending: false });
  const ev = (await call('GET', '/api/admin/events', undefined, admin)).body.events;
  assert.deepEqual(ev.map((e) => e.type), ['confirm', 'modify', 'modify']);
  assert.equal(ev[1].previousCount, 4);
  assert.equal(ev[1].count, 2);
  assert.equal(ev[2].status, 'declined');
});

test('un rechazo inicial genera evento "decline"', async () => {
  const { call, create } = await setup();
  const inv = await create();
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: false });
  const ev = (await call('GET', '/api/admin/events', undefined, admin)).body.events;
  assert.deepEqual(ev.map((e) => e.type), ['decline']);
});

test('aperturas: notifica la primera y limita las siguientes a 1 aviso cada 30 min', async () => {
  const { call, create, clock } = await setup();
  const inv = await create();
  await call('POST', `/api/invitation/${inv.id}/open`);
  await call('POST', `/api/invitation/${inv.id}/open`);
  clock.advance(31 * 60 * 1000);
  await call('POST', `/api/invitation/${inv.id}/open`);
  const ev = (await call('GET', '/api/admin/events', undefined, admin)).body.events;
  assert.equal(ev.filter((e) => e.type === 'open').length, 2);
  assert.equal(ev[0].firstOpen, true);
  const list = (await call('GET', '/api/admin/invitations', undefined, admin)).body;
  assert.equal(list.invitations[0].openCount, 3);
});

test('estadísticas del panel', async () => {
  const { call, create } = await setup();
  const a = await create('A', 4);
  const b = await create('B', 2);
  await create('C', 3);
  await call('POST', `/api/invitation/${a.id}/open`);
  await call('POST', `/api/invitation/${a.id}/rsvp`, { attending: true, count: 3 });
  await call('POST', `/api/invitation/${b.id}/rsvp`, { attending: false });
  const { stats } = (await call('GET', '/api/admin/invitations', undefined, admin)).body;
  assert.deepEqual(stats, {
    generated: 3, opened: 1, confirmed: 1, declined: 1, pending: 1, seatsAssigned: 9, seatsConfirmed: 3,
    attended: 0, arrived: 0, attendedOfConfirmed: 0, pendingArrival: 3, attendedUnconfirmed: 0,
  });
});

test('editar: cambia datos y si se reducen los lugares ajusta la confirmación', async () => {
  const { call, create } = await setup();
  const inv = await create('Marta', 5, '2');
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 5 });
  const r = await call('PUT', `/api/admin/invitations/${inv.id}`, { seats: 3, table: '9', guest: 'Marta y familia' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.warning, 'rsvp_count_reduced');
  assert.equal(r.body.invitation.rsvp.count, 3);
  const pub = (await call('GET', `/api/invitation/${inv.id}`)).body;
  assert.equal(pub.table, '9');
  assert.equal(pub.guest, 'Marta y familia');
  assert.equal(pub.rsvp.count, 3);
});

test('eliminar: el enlace deja de funcionar y no se puede confirmar', async () => {
  const { call, create } = await setup();
  const inv = await create();
  assert.equal((await call('DELETE', `/api/admin/invitations/${inv.id}`, undefined, admin)).status, 200);
  assert.equal((await call('GET', `/api/invitation/${inv.id}`)).status, 404);
  assert.equal((await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 })).status, 404);
  assert.equal((await call('POST', `/api/invitation/${inv.id}/open`)).status, 404);
  assert.equal((await call('DELETE', `/api/admin/invitations/${inv.id}`, undefined, admin)).status, 404);
});

test('seguridad: el panel exige contraseña y los ids inválidos dan 404', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/api/admin/invitations')).status, 401);
  assert.equal((await call('GET', '/api/admin/invitations', undefined, { authorization: 'Bearer mala' })).status, 401);
  assert.equal((await call('POST', '/api/admin/invitations', { guest: 'x', seats: 1 })).status, 401);
  assert.equal((await call('GET', '/api/admin/ping', undefined, admin)).status, 200);
  assert.equal((await call('GET', '/api/invitation/..%2f..%2fetc')).status, 404);
  assert.equal((await call('GET', '/api/invitation/A')).status, 404);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-test-'));
  const sinClave = createApi({ store: createFileStore(dir), adminToken: undefined });
  const r = await sinClave.handle({ method: 'GET', path: '/api/admin/invitations', headers: {} });
  assert.equal(r.status, 200); // sin ADMIN_TOKEN el generador no necesita contraseña
  const c = await sinClave.handle({ method: 'POST', path: '/api/admin/invitations', body: { guest: 'Ana', seats: 2 }, headers: {} });
  assert.equal(c.status, 201);
  const pub = await sinClave.handle({ method: 'GET', path: `/api/invitation/${c.body.invitation.id}`, headers: {} });
  assert.equal(pub.status, 200);
});

test('validación de datos al crear', async () => {
  const { call } = await setup();
  const post = (b) => call('POST', '/api/admin/invitations', b, admin);
  assert.equal((await post({ guest: '', seats: 2 })).status, 400);
  assert.equal((await post({ guest: 'X', seats: 0 })).status, 400);
  assert.equal((await post({ guest: 'X', seats: 99 })).status, 400);
  assert.equal((await post({ guest: 'X', seats: 'dos' })).status, 400);
  assert.equal((await post({ guest: 'x'.repeat(81), seats: 2 })).status, 400);
  const ok = await post({ guest: '  Familia   López\n', seats: 2 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.invitation.guest, 'Familia López');
  assert.equal(ok.body.invitation.table, '');
});

test('eventos con cursor: solo devuelve lo nuevo', async () => {
  const { call, create } = await setup();
  const inv = await create();
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 });
  const first = (await call('GET', '/api/admin/events', undefined, admin)).body;
  assert.equal(first.events.length, 1);
  const none = (await call('GET', '/api/admin/events', undefined, admin, { after: first.cursor })).body;
  assert.equal(none.events.length, 0);
  assert.equal(none.cursor, first.cursor);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 }); // igual
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: false });
  const next = (await call('GET', '/api/admin/events', undefined, admin, { after: first.cursor })).body;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, 'modify');
});

import { renderInvitePage } from '../src/page.mjs';

test('vista previa de WhatsApp: título, imagen absoluta y nombre del invitado', async () => {
  const { create, dir } = await setup();
  const inv = await create('Familia <Pérez> & "Co"', 2);
  const store = createFileStore(dir);
  const template = (await fs.readFile(new URL('../public/invite.html', import.meta.url), 'utf8'));
  const event = JSON.parse(await fs.readFile(new URL('../public/event.json', import.meta.url), 'utf8'));
  const html = await renderInvitePage({ template, origin: 'https://xv.example.com', id: inv.id, event, store });
  assert.match(html, /<meta property="og:title" content="Mis XV años, Valeria Zoe">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/xv\.example\.com\/og-image\.jpg">/);
  assert.match(html, new RegExp(`og:url" content="https://xv.example.com/i/${inv.id}"`));
  assert.match(html, /Invitación para Familia &lt;Pérez&gt; &amp; &quot;Co&quot;\./); // sin inyección de HTML
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.ok(!html.includes('__OG_'));
  // id desconocido o ausente: texto genérico, sin romper
  const g = await renderInvitePage({ template, origin: 'https://xv.example.com', id: 'zzzzzzzzzz', event, store });
  assert.match(g, /og:title" content="Mis XV años, Valeria Zoe"/);
  // la página estática (si la función fallara) ya trae título correcto
  assert.match(template, /<meta property="og:title" content="Mis XV años, Valeria Zoe">/);
  assert.ok(!template.includes('__OG_'));
});

test('una clave de administración débil (corta) se rechaza: el panel queda desactivado (solo si alguien puso una clave)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-test-'));
  const api = createApi({ store: createFileStore(dir), adminToken: 'corta' });
  const r = await api.handle({ method: 'GET', path: '/api/admin/invitations', headers: { authorization: 'Bearer corta' } });
  assert.equal(r.status, 503);
});

// ---------- Fechas límite, vigencia y mesas ----------
const RULES = { rsvpUntil: Date.parse('2026-11-20T23:59:59-06:00'), viewUntil: Date.parse('2026-12-02T23:59:59-06:00') };

async function setupAt(isoNow) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-rules-'));
  let t = Date.parse(isoNow);
  const api = createApi({ store: createFileStore(dir), adminToken: undefined, now: () => t, rules: RULES });
  const call = (method, p, body) => api.handle({ method, path: p, body, headers: {}, query: {} });
  return { call, set: (iso) => (t = Date.parse(iso)) };
}

test('confirmar/modificar solo hasta el 20 de nov; después la invitación se sigue viendo sin botón', async () => {
  const { call, set } = await setupAt('2026-11-10T12:00:00-06:00');
  const inv = (await call('POST', '/api/admin/invitations', { guest: 'Ana', seats: 4, table: '3' })).body.invitation;
  let v = (await call('GET', `/api/invitation/${inv.id}`)).body;
  assert.equal(v.rsvpOpen, true);
  assert.equal(v.rsvpUntil, '2026-11-21T05:59:59.000Z');
  assert.equal((await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 })).status, 200);
  set('2026-11-20T23:30:00-06:00'); // último día, todavía abierto
  assert.equal((await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 3 })).status, 200);
  set('2026-11-21T00:00:01-06:00'); // ya cerró
  v = (await call('GET', `/api/invitation/${inv.id}`)).body;
  assert.equal(v.rsvpOpen, false);
  assert.equal(v.rsvp.count, 3); // sigue viendo su invitación y su respuesta
  const late = await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 });
  assert.equal(late.status, 403);
  assert.equal(late.body.error, 'rsvp_closed');
  assert.equal((await call('GET', `/api/invitation/${inv.id}`)).body.rsvp.count, 3); // no cambió
});

test('la invitación se puede ver hasta el 2 de diciembre; después responde "expired"', async () => {
  const { call, set } = await setupAt('2026-11-10T12:00:00-06:00');
  const inv = (await call('POST', '/api/admin/invitations', { guest: 'Ana', seats: 2 })).body.invitation;
  set('2026-12-02T23:00:00-06:00');
  assert.equal((await call('GET', `/api/invitation/${inv.id}`)).status, 200);
  assert.equal((await call('POST', `/api/invitation/${inv.id}/open`)).status, 200);
  set('2026-12-03T00:00:01-06:00');
  const r = await call('GET', `/api/invitation/${inv.id}`);
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'expired');
  assert.equal((await call('POST', `/api/invitation/${inv.id}/open`)).status, 410);
  assert.equal((await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 1 })).status, 410);
  assert.equal((await call('GET', '/api/admin/invitations')).status, 200); // el panel sigue funcionando
});

test('una invitación eliminada responde 404 (la página muestra "enlace ya no disponible")', async () => {
  const { call } = await setupAt('2026-11-10T12:00:00-06:00');
  const inv = (await call('POST', '/api/admin/invitations', { guest: 'Ana', seats: 2 })).body.invitation;
  await call('DELETE', `/api/admin/invitations/${inv.id}`);
  assert.equal((await call('GET', `/api/invitation/${inv.id}`)).status, 404);
});

test('mesas: solo Principal o 1 a 15, y máximo 12 lugares por mesa', async () => {
  const { call } = await setupAt('2026-11-10T12:00:00-06:00');
  const mk = (guest, seats, table) => call('POST', '/api/admin/invitations', { guest, seats, table });
  assert.equal((await mk('A', 5, 'Mesa 4')).body.invitation.table, '4'); // se normaliza
  assert.equal((await mk('B', 2, 'principal')).body.invitation.table, 'Principal');
  assert.equal((await mk('C', 2, '')).body.invitation.table, ''); // sin mesa todavía
  for (const bad of ['0', '16', '99', 'abc', '3.5']) {
    const r = await mk('X', 1, bad);
    assert.equal(r.status, 400, bad);
    assert.ok(r.body.details.includes('table_invalid'), bad);
  }
  assert.equal((await mk('D', 7, '4')).status, 201); // 5 + 7 = 12, justo
  const full = await mk('E', 1, '4');
  assert.equal(full.status, 400);
  assert.equal(full.body.error, 'table_full');
  assert.equal(full.body.used, 12);
  assert.equal(full.body.free, 0);
  assert.equal(full.body.capacity, 12);
  // editar: mover a otra mesa o subir lugares también respeta el límite
  const e = (await mk('F', 3, '5')).body.invitation;
  assert.equal((await call('PUT', `/api/admin/invitations/${e.id}`, { table: '4' })).body.error, 'table_full');
  assert.equal((await call('PUT', `/api/admin/invitations/${e.id}`, { seats: 12 })).status, 200); // 12 solos en la 5
  assert.equal((await call('PUT', `/api/admin/invitations/${e.id}`, { seats: 13 })).status, 400);
  assert.equal((await call('PUT', `/api/admin/invitations/${e.id}`, { guest: 'F2' })).status, 200); // no cuenta contra sí misma
  const cfg = (await call('GET', '/api/admin/invitations')).body.config;
  assert.equal(cfg.tableCount, 15);
  assert.equal(cfg.tableCapacity, 12);
});
