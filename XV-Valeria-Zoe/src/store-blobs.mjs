// Almacenamiento en producción: Netlify Blobs (incluido en Netlify, sin configurar nada).
import { getStore } from '@netlify/blobs';

export function createBlobsStore() {
  const inv = getStore({ name: 'invitations', consistency: 'strong' });
  const evs = getStore({ name: 'events', consistency: 'strong' });
  const pushStore = getStore({ name: 'push', consistency: 'strong' });
  const cfg = getStore({ name: 'config', consistency: 'strong' });

  async function listAllKeys(store, prefix) {
    const keys = [];
    for await (const page of store.list({ paginate: true, ...(prefix ? { prefix } : {}) })) {
      for (const b of page.blobs) keys.push(b.key);
    }
    return keys;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
          const idx = i++;
          out[idx] = await fn(items[idx]);
        }
      }),
    );
    return out;
  }

  return {
    getInvitation: (id) => inv.get(id, { type: 'json', consistency: 'strong' }),
    putInvitation: (id, data) => inv.setJSON(id, data),
    deleteInvitation: (id) => inv.delete(id),
    async listInvitations() {
      const keys = await listAllKeys(inv);
      const all = await mapLimit(keys, 15, (k) => inv.get(k, { type: 'json', consistency: 'strong' }));
      return all.filter(Boolean);
    },
    addEvent: (key, ev) => evs.setJSON(key, ev),
    async listEvents({ after, limit }) {
      let keys = (await listAllKeys(evs)).sort();
      keys = after ? keys.filter((k) => k > after).slice(0, limit) : keys.slice(-limit);
      const list = await mapLimit(keys, 15, (k) => evs.get(k, { type: 'json', consistency: 'strong' }));
      return list.filter(Boolean);
    },
    async trimEvents(olderThanTs) {
      const limitKey = String(olderThanTs).padStart(13, '0');
      const keys = (await listAllKeys(evs)).filter((k) => k < limitKey);
      await mapLimit(keys, 15, (k) => evs.delete(k));
    },
    getVapid: () => cfg.get('vapid', { type: 'json', consistency: 'strong' }),
    async putVapid(v) {
      await cfg.setJSON('vapid', v, { onlyIfNew: true }); // no pisa claves ya creadas
    },
    putSubscription: (id, sub) => pushStore.setJSON(id, sub),
    deleteSubscription: (id) => pushStore.delete(id),
    async listSubscriptions() {
      const keys = await listAllKeys(pushStore);
      const all = await mapLimit(keys, 10, (k) => pushStore.get(k, { type: 'json', consistency: 'strong' }));
      return all.filter(Boolean);
    },
  };
}
