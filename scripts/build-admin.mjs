// Genera el archivo único del generador de invitaciones (HTML independiente).
// Uso:
//   node scripts/build-admin.mjs [direccion-del-sitio] [--con-clave] [--out=ruta.html]
// Por defecto el generador NO usa contraseña (el sitio no necesita ADMIN_TOKEN).
// Solo si en Netlify se puso ADMIN_TOKEN: --con-clave incrusta la clave (de ADMIN_TOKEN o ADMIN_TOKEN_FILE).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const out = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(root, 'dist', 'Generador-de-invitaciones.html');
const siteArg = args.find((a) => !a.startsWith('--')) || '';

let site = '';
if (siteArg) {
  const u = new URL(/^https?:\/\//i.test(siteArg) ? siteArg : `https://${siteArg}`);
  site = u.origin;
}
let token = '';
if (flag('--con-clave')) {
  token = (process.env.ADMIN_TOKEN || '').trim();
  if (!token && process.env.ADMIN_TOKEN_FILE) token = fs.readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8').trim();
  if (token.length < 20) throw new Error('Falta la clave (ADMIN_TOKEN o ADMIN_TOKEN_FILE) o es demasiado corta (mínimo 20 caracteres).');
  if (!/^[\w.~-]+$/.test(token)) throw new Error('La clave solo puede llevar letras, números y . _ ~ -');
}

let html = fs.readFileSync(path.join(root, 'admin', 'admin.template.html'), 'utf8');
html = html.replace(/\{\{FONT:([\w-]+)\}\}/g, (_, n) => fs.readFileSync(path.join(root, 'public', 'fonts', `${n}.woff2`)).toString('base64'));
html = html.replace('"{{SITE}}"', JSON.stringify(site)).replace('"{{TOKEN}}"', JSON.stringify(token));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB  ·  sitio: ${site || '(se pide una vez)'}  ·  clave: ${token ? 'incrustada' : 'sin contraseña'}`);
