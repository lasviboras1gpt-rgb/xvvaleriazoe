import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../src/core.mjs';
import { createFileStore } from '../src/store-file.mjs';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xv-checkin-'));
  let t = Date.parse("2026-11-04T12:00:00-06:00");
  const api = createApi({ store: createFileStore(dir), adminToken: undefined, now: () => (t += 1000) });
  const call = (method, p, body) => api.handle({ method, path: p, body, headers: {} });
  let n = 0; // cada invitación va a una mesa distinta para no chocar con el límite de 12 por mesa
  const create = async (guest = 'Familia Pérez', seats = 4, table = n++ === 0 ? '7' : String(1 + (n % 15))) => (await call('POST', '/api/admin/invitations', { guest, seats, table })).body.invitation;
  return { call, create };
}

test('el QR abre la pantalla de acceso con nombre, mesa, lugares y confirmación', async () => {
  const { call, create } = await setup();
  const inv = await create();
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 3 });
  const r = await call('GET', `/api/checkin/${inv.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: inv.id, guest: 'Familia Pérez', seats: 4, table: '7', rsvp: { status: 'confirmed', count: 3 }, limit: 3, attended: 0 });
  assert.equal((await call('GET', '/api/checkin/zzzzzzzzzz')).status, 404);
  assert.equal((await call('GET', '/api/checkin/..%2fx')).status, 404);
});

test('se registra el ingreso por partes y nunca pasa de los CONFIRMADOS (no de los asignados)', async () => {
  const { call, create } = await setup();
  const inv = await create('Ana', 10);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 5 }); // 5 de 10 asignados
  assert.equal((await call('POST', `/api/checkin/${inv.id}`, { add: 2 })).body.attended, 2);
  assert.equal((await call('POST', `/api/checkin/${inv.id}`, { add: 2 })).body.attended, 4);
  const over = await call('POST', `/api/checkin/${inv.id}`, { add: 2 });
  assert.equal(over.status, 400);
  assert.equal(over.body.error, 'count_exceeds_confirmed');
  assert.equal(over.body.confirmed, 5);
  assert.equal((await call('GET', `/api/checkin/${inv.id}`)).body.attended, 4); // no cambió
  assert.equal((await call('POST', `/api/checkin/${inv.id}`, { add: 1 })).body.attended, 5);
  assert.equal((await call('POST', `/api/checkin/${inv.id}`, { add: 1 })).status, 400); // ya están los 5
  // quien no confirmó (o dijo que no) no puede registrarse
  const sin = await create('Sin respuesta', 4);
  const r0 = await call('POST', `/api/checkin/${sin.id}`, { add: 1 });
  assert.equal(r0.status, 409);
  assert.equal(r0.body.error, 'not_confirmed');
  const no = await create('Dijo que no', 4);
  await call('POST', `/api/invitation/${no.id}/rsvp`, { attending: false });
  assert.equal((await call('POST', `/api/checkin/${no.id}`, { add: 1 })).status, 409);
  for (const bad of [{ add: 0 }, { add: -1 }, { add: 1.5 }, { add: 'x' }, {}, { total: 9 }, { total: -1 }]) {
    assert.equal((await call('POST', `/api/checkin/${inv.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/api/checkin/zzzzzzzzzz', { add: 1 })).status, 404);
});

test('corregir el total (hacia abajo) y el panel lo refleja en las cifras', async () => {
  const { call, create } = await setup();
  const a = await create('A', 4), b = await create('B', 2), c = await create('C', 3);
  await call('POST', `/api/invitation/${a.id}/rsvp`, { attending: true, count: 4 });
  await call('POST', `/api/invitation/${b.id}/rsvp`, { attending: true, count: 2 });
  await call('POST', `/api/checkin/${a.id}`, { add: 3 });
  assert.equal((await call('POST', `/api/checkin/${c.id}`, { add: 1 })).status, 409); // sin confirmar: no entra
  let s = (await call('GET', '/api/admin/invitations')).body.stats;
  assert.equal(s.seatsConfirmed, 6);
  assert.equal(s.attended, 3);
  assert.equal(s.arrived, 1);
  assert.equal(s.attendedOfConfirmed, 3);
  assert.equal(s.pendingArrival, 3); // 1 de A + 2 de B
  assert.equal(s.attendedUnconfirmed, 0);
  const fix = await call('POST', `/api/admin/invitations/${a.id}/attendance`, { attended: 1 });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.attended, 1);
  s = (await call('GET', '/api/admin/invitations')).body.stats;
  assert.equal(s.attended, 1);
  const tooMany = await call('POST', `/api/admin/invitations/${a.id}/attendance`, { attended: 5 }); // A confirmó 4
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, 'count_exceeds_confirmed');
});

test('cada ingreso genera un aviso y bajar los lugares ajusta lo ingresado', async () => {
  const { call, create } = await setup();
  const inv = await create('Familia Soto', 4);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 4 });
  await call('POST', `/api/checkin/${inv.id}`, { add: 2 });
  const evs = (await call('GET', '/api/admin/events')).body.events;
  const e = evs.find((x) => x.type === 'checkin');
  assert.ok(e); assert.equal(e.attended, 2); assert.equal(e.added, 2); assert.equal(e.seats, 4);
  await call('POST', `/api/checkin/${inv.id}`, { add: 2 });
  await call('PUT', `/api/admin/invitations/${inv.id}`, { seats: 3 });
  assert.equal((await call('GET', `/api/checkin/${inv.id}`)).body.attended, 3);
});

test('el invitado no ve lo ingresado en su invitación y una eliminada no registra', async () => {
  const { call, create } = await setup();
  const inv = await create();
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 2 });
  await call('POST', `/api/checkin/${inv.id}`, { add: 1 });
  assert.deepEqual(Object.keys((await call('GET', `/api/invitation/${inv.id}`)).body).sort(), ['guest', 'id', 'rsvp', 'rsvpOpen', 'rsvpUntil', 'seats', 'table']);
  await call('DELETE', `/api/admin/invitations/${inv.id}`);
  assert.equal((await call('POST', `/api/checkin/${inv.id}`, { add: 1 })).status, 404);
});

test('si se bajan los lugares asignados, lo ingresado nunca los supera', async () => {
  const { call, create } = await setup();
  const inv = await create('Familia Ruiz', 4);
  await call('POST', `/api/invitation/${inv.id}/rsvp`, { attending: true, count: 4 });
  await call('POST', `/api/checkin/${inv.id}`, { add: 4 });
  await call('PUT', `/api/admin/invitations/${inv.id}`, { seats: 2 });
  const v = (await call('GET', `/api/checkin/${inv.id}`)).body;
  assert.equal(v.attended, 2);
  assert.equal(v.limit, 2);
});
