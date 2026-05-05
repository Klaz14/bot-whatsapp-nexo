# AGENTS.md

## Rol del proyecto

Este proyecto es un bot Node.js standalone que escucha grupos permitidos de WhatsApp mediante `whatsapp-web.js` y sube imagenes/PDFs a Google Drive mediante OAuth y `googleapis`.

## Reglas para Codex

- Trabajar de forma incremental y mantener la funcionalidad actual salvo instruccion explicita.
- No cambiar proveedor de WhatsApp sin una fase aprobada.
- No ejecutar `npm start` ni `npm run auth` salvo instruccion explicita del usuario.
- No hacer deploy desde este repositorio.
- No enviar mensajes reales ni activar pruebas contra servicios reales sin aprobacion.
- No mostrar valores reales de tokens, credenciales, numeros telefonicos, links completos de Drive ni datos personales.
- Actualizar `README.md`, `.env.example` y este archivo cuando cambien flujos, variables de entorno, comandos o deploy.
- No introducir logs con telefonos completos, links completos de Drive, tokens, credenciales, payloads completos ni paths sensibles.
- Sanitizar todo dato usado en filenames o persistencia.
- Si se cambia logging, masking, envs o privacidad, actualizar documentacion en la misma fase.
- No versionar `processed-messages.json` ni derivados.
- No guardar telefonos, links de Drive, IDs crudos ni payloads completos en el store de idempotencia.
- No marcar mensajes como procesados antes de una subida exitosa salvo diseno explicito aprobado.
- Si cambia la estrategia de idempotencia, actualizar `README.md`, `.env.example` y este archivo.
- No asumir que Chrome/Chromium esta instalado para Puppeteer.
- No hardcodear rutas locales de Chrome/Chromium; usar `PUPPETEER_EXECUTABLE_PATH`.
- No ejecutar `npm run setup:chrome` ni instalaciones de navegador sin autorizacion del usuario.
- Mantener UTC para calculos tecnicos y agregar hora local explicita para auditoria humana.
- No depender del timezone del sistema operativo; usar `BOT_TIME_ZONE`.
- Si cambia el formato de timestamps, actualizar `README.md` y `.env.example`.
- No imprimir codigos OAuth, tokens, secrets, query params completos ni URLs de callback con parametros sensibles.
- Mantener el servidor OAuth local ligado a `127.0.0.1` por defecto.
- Mantener validacion de `state` en el flujo OAuth local.
- No cambiar scopes OAuth sin una fase explicita y documentada.
- Si cambia OAuth o sus envs, actualizar `README.md` y `.env.example`.

## Archivos y carpetas sensibles

No tocar, borrar, imprimir ni mover sin aprobacion explicita:

- `credentials.json`
- `token.json`
- `credentials.service-account.json.bak`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `uploads.log`
- `errors.log`
- `.env`
- `.env.*` excepto `.env.example`
- `processed-messages.json`
- `processed-messages*.json`

## Politica de secretos

Los secretos deben vivir fuera del codigo versionable. Usar variables de entorno o archivos locales ignorados por Git. Los ejemplos deben contener solo placeholders.

## Comandos permitidos sin aprobacion especial

- `node --check index.js`
- `node --check auth.js`
- `node --check` sobre archivos en `src/`
- `npm ls --depth=0 --no-audit --fund=false`
- comandos de lectura como `rg`, `Get-Content` o listados de estructura
- `npm exec -- puppeteer --help`

## Comandos prohibidos salvo aprobacion explicita

- `npm start`
- `npm run auth`
- cualquier comando que conecte WhatsApp
- cualquier comando que conecte Google Drive
- comandos de deploy
- comandos que roten, regeneren o escriban tokens
- `npm run setup:chrome` salvo autorizacion explicita, porque puede descargar navegador

## Advertencias operativas

`whatsapp-web.js` usa una sesion tipo WhatsApp Web guardada localmente. Perder `.wwebjs_auth/` puede requerir escanear QR nuevamente. Google Drive usa OAuth Client ID y `token.json`; perder o modificar ese token puede requerir reautorizar manualmente.

## Flujo de trabajo

1. Auditar y planificar.
2. Implementar cambios chicos.
3. Validar con comandos no destructivos.
4. Documentar lo cambiado.
5. Solicitar aprobacion antes de conectar servicios reales.
