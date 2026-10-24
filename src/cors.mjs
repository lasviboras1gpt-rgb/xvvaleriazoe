// El generador de invitaciones es un archivo HTML independiente (no vive en el sitio publicado),
// así que necesita permiso para llamar a /api/admin/*. Solo esas rutas lo permiten, y aun así
// exigen la clave en la cabecera Authorization: sin ella responden 401.
export const isAdminPath = (p) => /^\/api\/admin(\/|$)/.test(p);

export function corsHeaders(path) {
  if (!isAdminPath(path)) return {};
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  };
}
