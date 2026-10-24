# Invitación digital XV años · Valeria Zoe

| Pieza | Qué es |
|---|---|
| **Invitación** (`public/`) | Lo que abre cada invitado desde su enlace de WhatsApp. **Solo la invitación**: sin menús, sin paneles, sin código de administración. Sobre con sello dorado, pergamino, lirios, hojas y burbujas doradas, confirmación, cuenta regresiva, mapas y código de vestimenta. Funciona en cualquier navegador. |
| **API** (`netlify/functions/`, `src/`) | Guarda invitados y confirmaciones. Nadie puede confirmar más lugares de los asignados (se valida en el servidor). |
| **Generador de invitaciones** (`Generador-de-invitaciones.html`, se entrega aparte) | Un solo archivo HTML, **fuera del sitio publicado**. Dos menús: **Invitaciones** (consulta y panel) y **Crear invitación**. Es la **única** forma de crear, editar y eliminar invitaciones. |

**Los invitados solo pueden entrar con su enlace personal.** Si abren la dirección del sitio sin enlace (o con uno inventado o eliminado) ven un aviso y no se abre nada.

---

## 1. Publicar la invitación (una sola vez)

1. Crea una cuenta gratuita en <https://app.netlify.com>.
2. Sube esta carpeta a un repositorio de GitHub (privado) y en Netlify elige **Add new site → Import an existing project**. Netlify detecta `netlify.toml` solo.
   *(Alternativa: `npm install` y `npx netlify-cli deploy --prod`.)*
3. Listo: **no hay que configurar contraseñas ni variables.** Anota la dirección del sitio (por ejemplo `xvvaleriazoe.netlify.app`).

> Si en Netlify existe una variable `ADMIN_TOKEN` (de un intento anterior), **bórrala** (Project configuration → Environment variables) y vuelve a publicar (Deploys → Trigger deploy). Es lo único que puede hacer que el generador no conecte.

## 2. Usar el generador (HTML)

1. Guarda `Generador-de-invitaciones.html` en tu computadora o teléfono y ábrelo con el navegador (doble clic o desde “Archivos”). No se instala nada.
2. **Primera vez:** escribe solo la **dirección de tu sitio**. No pide contraseña. El navegador recuerda la dirección. Si algo falla, el generador te lo dice con un mensaje claro.

Menús (barra lateral; en el teléfono, arriba):

- **Invitaciones** — resumen (generadas, abiertas, confirmadas, lugares confirmados contra asignados, sin responder, no asistirán) y lista con el **enlace completo** de cada invitación: **Copiar enlace**, **Abrir enlace**, enviar por WhatsApp, **editar** y **eliminar**. Búsqueda, filtros y exportación a Excel (CSV).
- **Crear invitación** — nombre del invitado, lugares y mesa → **Generar invitación** → te da el enlace para copiar o enviar por WhatsApp.

**Abrir enlace** muestra la invitación como la verá el invitado, en *modo vista previa*: no cuenta como apertura ni cambia ninguna confirmación. El enlace que debes enviar es el que se copia (sin `?preview`).

**Avisos:** el botón **Actividad** muestra cuando alguien **abre**, **confirma**, **modifica** o **rechaza** (con sonido, insignia y, si lo permites, aviso del navegador). Las novedades llegan **mientras la página esté abierta**; al volver a abrirla te resume lo ocurrido mientras no estabas.

## 3. Cambiar datos del evento
Edita `public/event.json` (fecha, nombres, direcciones, horarios, código de vestimenta) y vuelve a publicar. Los enlaces de Google Maps se arman solos. El vestido es `public/dress.jpg`.

## 4. Probar en tu computadora (opcional)
```
npm install
npm test                 # pruebas de la API
npm run dev              # servidor local en http://localhost:8888
node scripts/build-admin.mjs [direccion-del-sitio]
```
`build-admin.mjs` genera `dist/Generador-de-invitaciones.html` (sin contraseña; con la dirección del sitio incrustada si la pasas). Para regenerar la imagen de WhatsApp: con `npm run dev` activo, `node scripts/build-preview.mjs`.

## 5. Seguridad: qué hay y qué no
- **Sin contraseña**, como pediste: el generador conecta directo. El archivo del generador **no** se publica en Netlify (no está en `public/`), así que los invitados no lo encuentran, y la invitación no contiene ningún menú ni código de administración.
- Lo que implica: la dirección interna de administración (`tu-sitio.netlify.app/api/admin/...`) no está protegida por clave. Nadie la ve ni está enlazada en ningún lado, pero quien la conociera podría ver la lista o crear invitaciones. Si algún día quieres protegerla, agrega en Netlify la variable `ADMIN_TOKEN` (valor largo, ≥ 20 caracteres) y genera el archivo con `--con-clave`, o pega la clave una vez en el generador.
- Los invitados solo ven su nombre, lugares, mesa y estado. Cada enlace es un código aleatorio de 10 caracteres, muy difícil de adivinar. Una invitación eliminada deja de abrir.
- La confirmación nunca puede superar los lugares asignados (se valida en el servidor).


