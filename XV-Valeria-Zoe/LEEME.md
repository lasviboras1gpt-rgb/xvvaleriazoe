# Invitación digital XV años · Valeria Zoe

| Pieza | Qué es |
|---|---|
| **Invitación** (`public/`) | Lo que abre cada invitado desde su enlace de WhatsApp: sobre con sello dorado, pergamino, lirios, mariposas, confirmación, cuenta regresiva, mapas y código de vestimenta. Funciona en cualquier navegador. |
| **API** (`netlify/functions/`, `src/`) | Guarda invitados y confirmaciones. Nadie puede confirmar más lugares de los asignados (se valida en el servidor). |
| **Programa para Windows** (`Panel-XV-Valeria-Zoe.exe`, se entrega aparte) | La **única** forma de crear, consultar, editar y eliminar invitaciones. No pide contraseña. |

**Los invitados solo pueden entrar con su enlace personal.** Si abren la dirección del sitio sin enlace (o con uno inventado o eliminado) ven un aviso y no se abre nada.

---

## 1. Publicar la invitación (una sola vez, ~10 minutos)

1. Crea una cuenta gratuita en <https://app.netlify.com>.
2. Sube esta carpeta a un repositorio de GitHub (privado) y en Netlify elige **Add new site → Import an existing project**. Netlify detecta `netlify.toml` solo.
   *(Alternativa: `npm install` y `npx netlify-cli deploy --prod`.)*
3. En Netlify: **Site configuration → Environment variables → Add a variable**
   - Nombre: `ADMIN_TOKEN`
   - Valor: el que viene en **`CLAVE-NETLIFY.txt`** (se entrega aparte; cópialo tal cual).
4. **Deploys → Trigger deploy** para que tome la variable.
5. Anota la dirección del sitio (por ejemplo `xvvaleriazoe.netlify.app`).

> Sin `ADMIN_TOKEN` (o con una clave de menos de 20 caracteres) la administración queda **desactivada**: nadie puede crear invitaciones. Es a propósito.

## 2. Usar el programa (.exe)

1. Copia `Panel-XV-Valeria-Zoe.exe` a una computadora con Windows 10 u 11 y dale doble clic. No requiere instalar nada.
2. Windows puede mostrar “Windows protegió su PC” porque el programa no está firmado. Pulsa **Más información → Ejecutar de todas formas**.
3. **Primera vez:** escribe solo la **dirección de tu sitio** (por ejemplo `xvvaleriazoe.netlify.app`). No hay contraseña: el programa trae la clave incrustada. Si la dirección es incorrecta o `ADMIN_TOKEN` no coincide, te lo dice con un mensaje claro.

Tiene **dos menús** (barra izquierda):

- **Invitaciones** — consulta de todo lo realizado. Arriba, el resumen (generadas, abiertas, confirmadas, lugares confirmados contra asignados, sin responder, no asistirán). Cada invitación muestra su **enlace completo** con **Copiar enlace** y **Abrir enlace**, además de enviar por WhatsApp, **editar** y **eliminar**. Hay búsqueda (por nombre, mesa o código del enlace), filtros y exportación a Excel (CSV).
- **Crear invitación** — nombre del invitado, lugares y mesa → **Generar invitación** → te entrega el enlace para copiar o enviar por WhatsApp.

**Abrir enlace** muestra la invitación como la verá el invitado, pero en *modo vista previa*: no cuenta como apertura, no te genera avisos y no cambia ninguna confirmación. El enlace que debes enviar es el que se copia (sin `?preview`).

**Avisos:** mientras el programa esté abierto (puede estar minimizado) recibes una notificación de Windows y una línea en **Actividad** cuando alguien **abre** su invitación (primera vez; después, máximo un aviso cada 30 min), **confirma**, **modifica** o **rechaza**. Si estuvo cerrado, al abrirlo te resume lo ocurrido. Al cerrar la ventana, el programa termina.

## 3. Cambiar datos del evento
Edita `public/event.json` (fecha, nombres, direcciones, horarios, código de vestimenta) y vuelve a publicar. Los enlaces de Google Maps se arman solos.

## 4. Probar en tu computadora (opcional)
```
npm install
npm test                 # pruebas de la API
npm run dev              # servidor local en http://localhost:8888
```
La clave de pruebas del servidor local se muestra al iniciar. La invitación solo se ve con un enlace real `http://localhost:8888/i/<código>`.

**Reconstruir el .exe** (requiere Go 1.22+; la clave se inyecta al compilar y **no** está en el código):
```
cd panel
GOOS=windows GOARCH=amd64 go build -ldflags "-H=windowsgui -s -w -X main.adminToken=LA_CLAVE" -o Panel-XV-Valeria-Zoe.exe .
```
**Regenerar la imagen de WhatsApp:** con `npm run dev` activo, `node scripts/build-preview.mjs`.

## 5. Seguridad: qué protege qué
- Para que **solo el programa** pueda administrar, el servidor exige una clave en cada orden de administración. Esa clave va incrustada en el `.exe`, así que **quien tenga el .exe puede administrar la lista**. Guárdalo como guardarías una contraseña: no lo compartas ni lo subas a GitHub (ya está en `.gitignore`).
- Si el `.exe` o `CLAVE-NETLIFY.txt` llegaran a manos equivocadas: cambia `ADMIN_TOKEN` en Netlify por otro valor largo (≥ 20 caracteres) y pide un `.exe` nuevo compilado con esa clave. El anterior deja de funcionar al instante.
- Los invitados solo ven su nombre, lugares, mesa y estado. Cada enlace es un código aleatorio de 10 caracteres, muy difícil de adivinar. Una invitación eliminada deja de abrir.
- El programa guarda solo la dirección del sitio en `%AppData%\XV-Valeria-Zoe`.

> El proyecto conserva código de notificaciones push para una posible app de Android; hoy no se usa ni afecta nada.
