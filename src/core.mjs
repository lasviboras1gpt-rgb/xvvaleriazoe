// Núcleo de la API de invitaciones. No depende de ningún servidor concreto:
// recibe un "store" (Netlify Blobs en producción, archivos en local/pruebas).
import crypto from 'node:crypto';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sin 0/o/1/l/i para evitar confusiones
const ID_LENGTH = 10;
const MAX_SEATS = 20;
const OPEN_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000; // no notificar cada recarga: 1 aviso cada 30 min
const EVENT_RETENTION_MS = 60 * 24 * 3600 * 1000;

export function newId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

const ID_RE = /^[a-z0-9]{6,32}$/;
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function validateFields(body, { partial = false } = {}) {
  const out = {};
  const errors = [];
  if (!partial || body.guest !== undefined) {
    const guest = clean(body.guest);
    if (!guest) errors.push('guest_required');
    else if (guest.length > 80) errors.push('guest_too_long');
    else out.guest = guest;
  }
  if (!partial || body.seats !== undefined) {
    const seats = Number(body.seats);
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) errors.push('seats_invalid');
    else out.seats = seats;
  }
  if (!partial || body.table !== undefined) {
    const table = clean(body.table);
    if (table.length > 20) errors.push('table_too_long');
    else out.table = table;
  }
  return { out, errors };
}

const publicView = (inv) => ({
  id: inv.id,
  guest: inv.guest,
  seats: inv.seats,
  table: inv.table,
  rsvp: { status: inv.rsvp.status, count: inv.rsvp.count },
});

// Vista para la pantalla de control de acceso (la que abre el QR). Solo lo necesario.
const checkinView = (inv) => ({
  id: inv.id,
  guest: inv.guest,
  seats: inv.seats,
  table: inv.table,
  rsvp: { status: inv.rsvp.status, count: inv.rsvp.count },
  attended: inv.attended || 0,
});

function computeStats(list) {
  const stats = {
    generated: list.length,
    opened: 0,
    confirmed: 0,
    declined: 0,
    pending: 0,
    seatsAssigned: 0,
    seatsConfirmed: 0,
    attended: 0, // personas que ya ingresaron (todas)
    arrived: 0, // invitaciones con al menos una persona adentro
    attendedOfConfirmed: 0, // de lo confirmado, cuántas personas ya llegaron
    pendingArrival: 0, // confirmadas que aún no llegan
    attendedUnconfirmed: 0, // llegaron sin haber confirmado (o más de lo confirmado)
  };
  for (const inv of list) {
    stats.seatsAssigned += inv.seats;
    const att = inv.attended || 0;
    const conf = inv.rsvp.status === 'confirmed' ? inv.rsvp.count : 0;
    stats.attended += att;
    if (att > 0) stats.arrived++;
    stats.attendedOfConfirmed += Math.min(att, conf);
    stats.pendingArrival += Math.max(0, conf - att);
    stats.attendedUnconfirmed += Math.max(0, att - conf);
    if (inv.openCount > 0) stats.opened++;
    if (inv.rsvp.status === 'confirmed') {
      stats.confirmed++;
      stats.seatsConfirmed += inv.rsvp.count;
    } else if (inv.rsvp.status === 'declined') stats.declined++;
    else stats.pending++;
  }
  return stats;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export const MIN_TOKEN_LENGTH = 20;

export function createApi({ store, adminToken, now = () => Date.now(), push = null }) {
  const res = (status, body) => ({ status, body });
  const err = (status, code, extra = {}) => res(status, { error: code, ...extra });

  function isAdmin(headers) {
    if (!adminToken) return true; // sin clave configurada: el generador funciona sin contraseña
    if (adminToken.length < MIN_TOKEN_LENGTH) return null; // se puso una clave, pero es demasiado débil
    const auth = headers['authorization'] || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : headers['x-admin-password'] || '';
    return crypto.timingSafeEqual(sha(supplied), sha(adminToken));
  }

  async function emit(type, inv, extra = {}, ctx = {}) {
    const ts = now();
    const key = `${String(ts).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
    const ev = {
      key,
      ts,
      type,
      invitationId: inv.id,
      guest: inv.guest,
      table: inv.table,
      seats: inv.seats,
      ...extra,
    };
    await store.addEvent(key, ev);
    if (push) {
      // Se espera un poco para que el aviso salga antes de que termine la función, pero nunca falla la petición del invitado.
      await Promise.race([push.notify(ev, { host: ctx.host }).catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
    }
    return ev;
  }

  // ---------- Rutas públicas (invitado) ----------
  async function getInvitation(id) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    return res(200, publicView(inv));
  }

  async function registerOpen(id, ctx) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    const t = now();
    const first = inv.openCount === 0;
    inv.openCount += 1;
    inv.firstOpenAt = inv.firstOpenAt || t;
    inv.lastOpenAt = t;
    const shouldNotify = first || t - (inv.lastOpenNotifiedAt || 0) > OPEN_NOTIFY_COOLDOWN_MS;
    if (shouldNotify) inv.lastOpenNotifiedAt = t;
    await store.putInvitation(inv.id, inv);
    if (shouldNotify) await emit('open', inv, { firstOpen: first }, ctx);
    return res(200, publicView(inv));
  }

  async function rsvp(id, body, ctx) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    if (typeof body?.attending !== 'boolean') return err(400, 'attending_required');

    let status;
    let count;
    if (body.attending) {
      count = Number(body.count);
      if (!Number.isInteger(count) || count < 1) return err(400, 'count_invalid');
      // Regla clave: nunca más lugares de los asignados.
      if (count > inv.seats) return err(400, 'count_exceeds_seats', { seats: inv.seats });
      status = 'confirmed';
    } else {
      status = 'declined';
      count = 0;
    }

    const prev = { status: inv.rsvp.status, count: inv.rsvp.count };
    if (prev.status === status && prev.count === count) return res(200, publicView(inv)); // sin cambios

    inv.rsvp = { status, count, updatedAt: now() };
    await store.putInvitation(inv.id, inv);
    const type = prev.status === 'pending' ? (status === 'confirmed' ? 'confirm' : 'decline') : 'modify';
    await emit(type, inv, {
      status,
      count,
      previousStatus: prev.status,
      previousCount: prev.count,
    }, ctx);
    return res(200, publicView(inv));
  }

  // ---------- Control de acceso (QR de la invitación) ----------
  async function getCheckin(id) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    return res(200, checkinView(inv));
  }

  // body: { add: n } suma personas que entran ahora; { total: n } fija el total (para corregir).
  // En ambos casos el total nunca puede pasar de los lugares asignados.
  async function setCheckin(id, body, ctx, { corrected = false } = {}) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    const prev = inv.attended || 0;
    let total;
    if (body && body.total !== undefined) total = Number(body.total);
    else if (body && body.attended !== undefined) total = Number(body.attended);
    else if (body && body.add !== undefined) {
      const add = Number(body.add);
      if (!Number.isInteger(add) || add < 1) return err(400, 'count_invalid');
      total = prev + add;
    } else return err(400, 'count_invalid');
    if (!Number.isInteger(total) || total < 0) return err(400, 'count_invalid');
    if (total > inv.seats) return err(400, 'count_exceeds_seats', { seats: inv.seats, attended: prev });
    if (total === prev) return res(200, checkinView(inv));
    inv.attended = total;
    inv.attendedAt = now();
    if (!inv.firstEntryAt && total > 0) inv.firstEntryAt = inv.attendedAt;
    await store.putInvitation(inv.id, inv);
    await emit(total > prev && !corrected ? 'checkin' : 'checkin_fix', inv, { attended: total, previousAttended: prev, added: total - prev }, ctx);
    return res(200, checkinView(inv));
  }

  // ---------- Rutas de administración ----------
  async function adminList() {
    const list = await store.listInvitations();
    list.sort((a, b) => b.createdAt - a.createdAt);
    return res(200, { invitations: list, stats: computeStats(list) });
  }

  async function adminCreate(body) {
    const { out, errors } = validateFields(body || {});
    if (errors.length) return err(400, 'validation', { details: errors });
    const t = now();
    const inv = {
      id: newId(),
      guest: out.guest,
      seats: out.seats,
      table: out.table,
      createdAt: t,
      updatedAt: t,
      openCount: 0,
      firstOpenAt: null,
      lastOpenAt: null,
      lastOpenNotifiedAt: 0,
      attended: 0,
      attendedAt: null,
      rsvp: { status: 'pending', count: 0, updatedAt: null },
    };
    await store.putInvitation(inv.id, inv);
    return res(201, { invitation: inv });
  }

  async function adminUpdate(id, body) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    const { out, errors } = validateFields(body || {}, { partial: true });
    if (errors.length) return err(400, 'validation', { details: errors });
    Object.assign(inv, out);
    if ((inv.attended || 0) > inv.seats) inv.attended = inv.seats; // nunca más adentro que lugares asignados
    let warning;
    if (inv.rsvp.status === 'confirmed' && inv.rsvp.count > inv.seats) {
      inv.rsvp.count = inv.seats; // nunca queda confirmado por encima de lo asignado
      inv.rsvp.updatedAt = now();
      warning = 'rsvp_count_reduced';
    }
    inv.updatedAt = now();
    await store.putInvitation(inv.id, inv);
    return res(200, { invitation: inv, ...(warning ? { warning } : {}) });
  }

  async function adminDelete(id) {
    if (!isValidId(id)) return err(404, 'not_found');
    const inv = await store.getInvitation(id);
    if (!inv) return err(404, 'not_found');
    await store.deleteInvitation(id);
    return res(200, { deleted: id });
  }

  async function adminEvents(query) {
    const after = query.after || '';
    const limit = Math.min(Math.max(parseInt(query.limit || '100', 10) || 100, 1), 500);
    const events = await store.listEvents({ after, limit });
    return res(200, { events, cursor: events.length ? events[events.length - 1].key : after });
  }

  // ---------- Enrutador ----------
  async function handle({ method, path, query = {}, body, headers = {} }) {
    method = method.toUpperCase();
    const parts = path.replace(/^\/+|\/+$/g, '').split('/'); // ['api', ...]
    if (parts[0] !== 'api') return err(404, 'not_found');
    const [, area, id, action, extra] = parts;

    try {
      if (area === 'invitation') {
        if (method === 'GET' && id && !action) return await getInvitation(id);
        if (method === 'POST' && id && action === 'open') return await registerOpen(id, { host: headers.host });
        if (method === 'POST' && id && action === 'rsvp') return await rsvp(id, body, { host: headers.host });
        return err(405, 'method_not_allowed');
      }

      if (area === 'checkin') {
        if (method === 'GET' && id && !action) return await getCheckin(id);
        if (method === 'POST' && id && !action) return await setCheckin(id, body, { host: headers.host });
        return err(405, 'method_not_allowed');
      }

      if (area === 'admin') {
        const ok = isAdmin(headers);
        if (ok === null) return err(503, 'admin_not_configured');
        if (!ok) {
          await new Promise((r) => setTimeout(r, 400)); // frena fuerza bruta
          return err(401, 'unauthorized');
        }
        if (id === 'ping' && method === 'GET') return res(200, { ok: true });
        if (id === 'invitations') {
          const target = action; // /api/admin/invitations/:id
          if (!target) {
            if (method === 'GET') return await adminList();
            if (method === 'POST') return await adminCreate(body);
          } else if (extra === 'attendance') {
            if (method === 'POST' || method === 'PUT') return await setCheckin(target, { total: body?.attended }, {}, { corrected: true });
          } else {
            if (method === 'PUT' || method === 'PATCH') return await adminUpdate(target, body);
            if (method === 'DELETE') return await adminDelete(target);
          }
          return err(405, 'method_not_allowed');
        }
        if (id === 'push') {
          if (!push) return err(503, 'push_not_configured');
          if (action === 'key' && method === 'GET') return res(200, { publicKey: await push.publicKey() });
          if (action === 'subscribe' && method === 'POST') {
            const ok = await push.subscribe(body?.subscription, body?.label);
            return ok ? res(200, { ok: true }) : err(400, 'invalid_subscription');
          }
          if (action === 'unsubscribe' && method === 'POST') {
            await push.unsubscribe(body?.endpoint);
            return res(200, { ok: true });
          }
          if (action === 'test' && method === 'POST') {
            const r = await push.test({ host: headers.host });
            return res(200, r);
          }
          return err(405, 'method_not_allowed');
        }
        if (id === 'events' && method === 'GET') {
          if (Math.random() < 0.02) await store.trimEvents(now() - EVENT_RETENTION_MS).catch(() => {});
          return await adminEvents(query);
        }
      }
      return err(404, 'not_found');
    } catch (e) {
      console.error('API error', e);
      return err(500, 'internal_error');
    }
  }

  return { handle };
}
