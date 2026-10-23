// Almacenamiento en archivos JSON: para pruebas y para correr todo en tu propia computadora.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFileStore(dir) {
  const invDir = path.join(dir, 'invitations');
  const evDir = path.join(dir, 'events');
  const pushDir = path.join(dir, 'push');
  const cfgDir = path.join(dir, 'config');
  const ready = Promise.all([invDir, evDir, pushDir, cfgDir].map((d) => fs.mkdir(d, { recursive: true })));

  const readJson = async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  // Escritura atómica: evita archivos a medias si hay dos peticiones a la vez.
  const writeJson = async (file, data) => {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  };

  return {
    async getInvitation(id) {
      await ready;
      return readJson(path.join(invDir, `${id}.json`));
    },
    async putInvitation(id, data) {
      await ready;
      await writeJson(path.join(invDir, `${id}.json`), data);
    },
    async deleteInvitation(id) {
      await ready;
      await fs.rm(path.join(invDir, `${id}.json`), { force: true });
    },
    async listInvitations() {
      await ready;
      const files = (await fs.readdir(invDir)).filter((f) => f.endsWith('.json'));
      const all = await Promise.all(files.map((f) => readJson(path.join(invDir, f))));
      return all.filter(Boolean);
    },
    async addEvent(key, ev) {
      await ready;
      await writeJson(path.join(evDir, `${key}.json`), ev);
    },
    async listEvents({ after, limit }) {
      await ready;
      let keys = (await fs.readdir(evDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
      keys = after ? keys.filter((k) => k > after).slice(0, limit) : keys.slice(-limit);
      const list = await Promise.all(keys.map((k) => readJson(path.join(evDir, `${k}.json`))));
      return list.filter(Boolean);
    },
    async trimEvents(olderThanTs) {
      await ready;
      const limitKey = String(olderThanTs).padStart(13, '0');
      const keys = (await fs.readdir(evDir)).filter((f) => f.endsWith('.json') && f.slice(0, -5) < limitKey);
      await Promise.all(keys.map((f) => fs.rm(path.join(evDir, f), { force: true })));
    },
    async getVapid() {
      await ready;
      return readJson(path.join(cfgDir, 'vapid.json'));
    },
    async putVapid(v) {
      await ready;
      // "wx": solo se crea si no existe (evita que dos peticiones simultáneas generen claves distintas)
      try {
        await fs.writeFile(path.join(cfgDir, 'vapid.json'), JSON.stringify(v), { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    },
    async putSubscription(id, sub) {
      await ready;
      await writeJson(path.join(pushDir, `${id}.json`), sub);
    },
    async deleteSubscription(id) {
      await ready;
      await fs.rm(path.join(pushDir, `${id}.json`), { force: true });
    },
    async listSubscriptions() {
      await ready;
      const files = (await fs.readdir(pushDir)).filter((f) => f.endsWith('.json'));
      return (await Promise.all(files.map((f) => readJson(path.join(pushDir, f))))).filter(Boolean);
    },
  };
}
