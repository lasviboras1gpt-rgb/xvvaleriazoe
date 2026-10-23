// Personaliza la vista previa (Open Graph) que ve WhatsApp al pegar el enlace.
// El archivo invite.html ya trae valores correctos por defecto entre <!--OG:start--> y <!--OG:end-->;
// aquí solo se reemplaza ese bloque para poner la dirección absoluta de la imagen y el nombre del invitado.
import { isValidId } from './core.mjs';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BLOCK = /<!--OG:start-->[\s\S]*?<!--OG:end-->/;

export async function renderInvitePage({ template, origin, id, event, store }) {
  const title = `${event.title}, ${event.name}`; // "Mis XV años, Valeria Zoe"
  let description = 'Con la bendición de Dios, te invito a celebrar conmigo este día tan especial. Toca para abrir tu invitación.';

  if (store && isValidId(id)) {
    try {
      const inv = await store.getInvitation(id);
      if (inv) description = `Invitación para ${inv.guest}. Toca para abrir y confirmar tu asistencia.`;
    } catch {
      /* si falla la consulta, se usa la descripción genérica */
    }
  }

  const url = `${origin}${id ? `/i/${encodeURIComponent(id)}` : '/'}`;
  const t = esc(title);
  const d = esc(description);
  const block = `<!--OG:start-->
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${t}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${esc(origin)}/og-image.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="es_MX">
<meta name="twitter:card" content="summary_large_image">
<!--OG:end-->`;
  return template.replace(BLOCK, () => block);
}
