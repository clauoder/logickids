LOGICKIDS - Cloudflare Pages (modo avanzado)

Archivos:
- index.html
- _worker.js

Configuración del proyecto Pages:
- Build command: vacío
- Build output directory: .
- Binding D1: DB -> logickids-madeg-db
- Secret: ADMIN_PASSWORD

_worker.js atiende /api/* y sirve los archivos estáticos mediante env.ASSETS.
No es necesario ejecutar SQL nuevamente.
