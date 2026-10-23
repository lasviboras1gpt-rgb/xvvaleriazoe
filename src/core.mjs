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

function computeStats(list) {
  const stats = {
    generated: list.length,
    opened: 0,
    confirmed: 0,
    declined: 0,
    pending: 0,
    seatsAssigned: 0,
    seatsConfirmed: 0,
  };
  for (const inv of list) {
    stats.seatsAssigned += inv.seats;
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
    if (!adminToken || adminToken.length < MIN_TOKEN_LENGTH) return null; // no configurado o demasiado débil
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
    const [, area, id, action] = parts;

    try {
      if (area === 'invitation') {
        if (method === 'GET' && id && !action) return await getInvitation(id);
        if (method === 'POST' && id && action === 'open') return await registerOpen(id, { host: headers.host });
        if (method === 'POST' && id && action === 'rsvp') return await rsvp(id, body, { host: headers.host });
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
