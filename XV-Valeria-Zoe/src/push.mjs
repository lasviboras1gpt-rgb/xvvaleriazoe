// Notificaciones push (Web Push) para la app de Android.
// - Las claves VAPID se crean solas la primera vez y se guardan en el almacenamiento privado.
// - Las suscripciones (un teléfono = una suscripción) se guardan y se limpian cuando caducan.
import crypto from 'node:crypto';
import webpush from 'web-push';
import { describeEvent } from './events.mjs';

const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export function validateSubscription(sub, { allowInsecure = false } = {}) {
  if (!sub || typeof sub !== 'object') return null;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 700) return null;
  let u;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) return null;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function createPush({ store, sender = webpush, subject, allowInsecure = false, timeoutMs = 3000, log = console }) {
  let vapidPromise;
  const getVapid = () =>
    (vapidPromise ??= (async () => {
      let v = await store.getVapid();
      if (!v) {
        v = sender.generateVAPIDKeys();
        await store.putVapid(v);
        v = (await store.getVapid()) || v; // si otra petición se adelantó, se usa la guardada
      }
      return v;
    })().catch((e) => { vapidPromise = undefined; throw e; }));

  async function publicKey() {
    return (await getVapid()).publicKey;
  }

  async function subscribe(rawSub, label = '') {
    const sub = validateSubscription(rawSub, { allowInsecure });
    if (!sub) return false;
    await store.putSubscription(subId(sub.endpoint), { ...sub, label: String(label).slice(0, 60), createdAt: Date.now() });
    return true;
  }
  async function unsubscribe(endpoint) {
    if (typeof endpoint !== 'string') return;
    await store.deleteSubscription(subId(endpoint));
  }

  // Envía a todos los teléfonos suscritos. Nunca lanza error: un fallo de push no debe afectar al invitado.
  async function send(payload, { host } = {}) {
    try {
      const subs = await store.listSubscriptions();
      if (!subs.length) return { sent: 0, removed: 0 };
      const v = await getVapid();
      const vapidDetails = { subject: subject || (host ? `https://${host}` : 'https://example.com'), publicKey: v.publicKey, privateKey: v.privateKey };
      const body = JSON.stringify(payload);
      let sent = 0, removed = 0;
      await Promise.allSettled(
        subs.map(async (s) => {
          try {
            await sender.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { vapidDetails, TTL: 6 * 3600, urgency: 'high', timeout: timeoutMs });
            sent++;
          } catch (e) {
            if (e?.statusCode === 404 || e?.statusCode === 410) { await store.deleteSubscription(subId(s.endpoint)); removed++; }
            else log.error?.('push falló', e?.statusCode || e?.message);
          }
        }),
      );
      return { sent, removed };
    } catch (e) {
      log.error?.('push error', e?.message);
      return { sent: 0, removed: 0 };
    }
  }

  // Aviso por un evento (abrir, confirmar, modificar, rechazar).
  const notify = (ev, opts) => {
    const d = describeEvent(ev);
    return send({ title: d.title, body: d.text, tag: `${ev.invitationId}-${ev.type}`, type: ev.type, url: '/admin/#actividad', ts: ev.ts }, opts);
  };
  const test = (opts) => send({ title: 'Notificaciones activadas', body: 'Así te avisaremos cuando alguien abra o confirme su invitación.', tag: 'test', type: 'test', url: '/admin/', ts: Date.now() }, opts);

  return { publicKey, subscribe, unsubscribe, notify, test, count: async () => (await store.listSubscriptions()).length };
}
