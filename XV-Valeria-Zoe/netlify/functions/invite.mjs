// Función de Netlify: /i/<id> entrega la invitación con vista previa personalizada para WhatsApp.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBlobsStore } from '../../src/store-blobs.mjs';
import { renderInvitePage } from '../../src/page.mjs';

export const config = { path: '/i/*' };

// Los archivos viajan dentro de la función (included_files en netlify.toml).
// Si por alguna razón no se encuentran, se piden al propio sitio.
async function loadAsset(name, origin) {
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task'].filter(Boolean);
  for (const root of roots) {
    try {
      return await fs.readFile(path.join(root, 'public', name), 'utf8');
    } catch {
      /* probar la siguiente ruta */
    }
  }
  const r = await fetch(`${origin}/${name}`);
  if (!r.ok) throw new Error(`No se pudo leer ${name}`);
  return r.text();
}

export default async (req) => {
  const url = new URL(req.url);
  const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '');
  try {
    const [template, eventText] = await Promise.all([loadAsset('invite.html', url.origin), loadAsset('event.json', url.origin)]);
    const html = await renderInvitePage({
      template,
      origin: url.origin,
      id,
      event: JSON.parse(eventText),
      store: createBlobsStore(),
    });
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
    });
  } catch (e) {
    console.error('invite render failed, falling back to static page', e);
    return Response.redirect(`${url.origin}/invite.html?id=${encodeURIComponent(id)}`, 302);
  }
};
