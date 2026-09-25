LOGICKIDS - versión final para Cloudflare Pages + D1

Estructura:
- index.html
- functions/api/[[path]].js

Configuración necesaria en Cloudflare Pages:
- Binding D1: DB -> logickids-madeg-db
- Secret: ADMIN_PASSWORD

Esta versión usa las tablas actuales de D1:
- students
- sessions
- progress

No es necesario volver a ejecutar schema-update.sql.
Los usuarios y avances existentes permanecen en la base D1.
