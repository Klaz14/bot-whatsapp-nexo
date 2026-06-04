# AGENTS.md

## Rol del proyecto

Este proyecto es un bot Node.js standalone que escucha grupos permitidos de WhatsApp mediante `whatsapp-web.js` y sube imagenes/PDFs a Google Drive mediante OAuth y `googleapis`.

## Reglas para Codex

- Trabajar de forma incremental y mantener la funcionalidad actual salvo instruccion explicita.
- No cambiar proveedor de WhatsApp sin una fase aprobada.
- No ejecutar `npm start` ni `npm run auth` salvo instruccion explicita del usuario.
- No hacer deploy desde este repositorio.
- Mantener `DEPLOYMENT.md` actualizado cuando cambien deploy, supervisor, persistencia, backups, restore o runbooks operativos.
- El deploy operativo aprobado para esta base es single-instance; no configurar cluster, multiples workers ni escala horizontal sin fase explicita.
- Verificación de plataforma antes de proponer librerías npm: cuando se elija una librería con dependencias del sistema (binarios, utilities apt-get), verificar primero en el registro npm que la librería soporte Linux (ambiente productivo). Razón: el 14/05/2026 se propuso `pdf-poppler` sin verificar; resultó que NO soporta Linux. Sonnet detectó la incompatibilidad antes de instalar; cambio a `node-poppler` con misma API.
- En Railway, usar Dockerfile + un solo servicio long-running + Railway Volume montado en `/data`; no guardar estado operativo fuera de `/data`.
- No subir secretos, sesiones, tokens, configs reales ni backups al Docker build context; mantenerlos fuera de Git y fuera de la imagen.
- Para Railway, mantener rutas persistentes por variables (`/data/...`) y verificar estructura con scripts read-only antes de arrancar operacion real.
- Si el plan Railway no tiene backups automaticos de volumen, cualquier cambio de deploy debe recordar backup externo manual previo.
- Nunca sugerir `Wipe Volume`, `Delete Volume` ni recrear `/data` como solucion rapida.
- Nunca versionar ni adjuntar dumps, tarballs o zips de `/data`.
- No borrar, mover ni regenerar archivos persistentes de produccion sin backup y autorizacion explicita.
- No tocar sesiones WhatsApp, tokens OAuth, stores locales ni calendarios reales durante tareas de codigo.
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
- No borrar `.wwebjs_auth/` ni `.wwebjs_cache/` para diagnosticar `ready`; primero agregar/usar logs seguros de eventos.
- Mantener `WHATSAPP_READY_TIMEOUT_SECONDS` como diagnostico: no debe cerrar un bot operativo 24/7.
- No fijar `WHATSAPP_WEB_VERSION` ni cambiar `WHATSAPP_WEB_VERSION_CACHE_TYPE` sin documentar el motivo y la prueba manual.
- Mantener UTC para calculos tecnicos y agregar hora local explicita para auditoria humana.
- No depender del timezone del sistema operativo; usar `BOT_TIME_ZONE`.
- Si cambia el formato de timestamps, actualizar `README.md` y `.env.example`.
- No imprimir codigos OAuth, tokens, secrets, query params completos ni URLs de callback con parametros sensibles.
- Mantener el servidor OAuth local ligado a `127.0.0.1` por defecto.
- Mantener validacion de `state` en el flujo OAuth local.
- No cambiar scopes OAuth sin una fase explicita y documentada.
- Si cambia OAuth o sus envs, actualizar `README.md` y `.env.example`.
- Mantener la organizacion de comprobantes en Drive como archivos planos en `PULL TRANSFERENCIAS/` (sin subcarpetas por grupo ni fecha; grupo identificado por TAG en filename) salvo fase explicita.
- Mantener el naming de comprobantes como `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>` salvo fase explicita; el ID es incremental por día calendario, resetea con cada nuevo día.
- No reemplazar el ID diario por un contador global ni por un contador solo en memoria.
- No ampliar el patron de secuencia a `^\d+_`; contar solo archivos que cumplan el formato completo del bot `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>`.
- No crear carpetas reales en Drive durante auditorias o validaciones automaticas.
- No loguear IDs completos de carpetas, links completos de Drive ni rutas privadas; usar ruta logica sanitizada cuando haga falta.
- No tocar `config.json` real sin autorizacion explicita; la carpeta raiz operativa debe configurarse localmente.
- Para carpetas de mes/dia en Drive, usar fecha local operativa con `BOT_TIME_ZONE`, no UTC.
- No hardcodear feriados o dias no habiles en codigo; usar `business-calendar.json` local y `business-calendar.example.json` como plantilla.
- No consultar APIs externas de feriados sin una fase explicita y documentada.
- No tocar arranque de WhatsApp para logica de horario operativo o calendario laboral.
- No versionar `business-calendar.json` si contiene calendario operativo local.
- En pendientes, preservar idempotencia y no marcar `processed` final hasta que el archivo quede subido a `PULL TRANSFERENCIAS/`.
- La metadata de pendientes en Drive debe usar `appProperties` seguras; no guardar telefonos completos, LID completos, links ni payloads.
- No borrar archivos pendientes hasta confirmar la subida final a `Entrantes`.
- El encolado fuera de horario puede descargar y subir a pendientes, pero no debe subir a `Entrantes` ni marcar `processed` final.
- El processor de pendientes debe correr solo dentro de horario operativo, despues de `ready`, sin bloquear ni alterar la inicializacion de WhatsApp.
- El processor debe copiar a `PULL TRANSFERENCIAS/` con naming `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>` y confirmar exito antes de marcar `processed`, marcar `uploaded` o borrar el pendiente.
- Si falla el procesamiento de un pendiente, conservar el archivo y marcar estado `failed` con error sanitizado.
- El grupo original del pendiente debe conservarse como `groupFolderName` o equivalente seguro; el `tag` no debe ser la unica fuente para decidir carpeta final.
- En pendientes, usar el grupo original sanitizado para la carpeta de `Entrantes` y el `tag` solo para el filename. El `DDMM` del filename se calcula del timestamp original del mensaje.
- Las auditorias de pendientes deben ser read-only salvo fase explicita; no borrar, mover, copiar ni cambiar `appProperties`. Con estructura flat de pendientes, verificar que no queden archivos huérfanos en Drive que no se procesen.
- No imprimir IDs completos de Drive, links, telefonos, LID ni payloads al auditar pendientes.
- No modificar metadata de pendientes manualmente sin instruccion explicita.
- No tocar `ready`, `whatsappClient.js` ni arranque de WhatsApp para tareas de auditoria de pendientes.
- No implementar anti-spam, rate limit ni cupos que limiten, ignoren o supriman comprobantes de clientes por cantidad.
- No ocultar errores criticos por rate limit. Solo se permite deduplicar mensajes de estado operativo identicos dentro de una misma ventana de estado.
- Las notificaciones operativas no deben bloquear `ready`, no deben tocar `whatsappClient.js` y no deben enviar telefonos completos, LID completos, links completos, tokens, IDs crudos ni payloads.
- Las notificaciones a multiples grupos deben manejar errores por grupo: si un destino falta o falla, continuar con los demas y loguear solo datos seguros.
- `WHATSAPP_ALERT_GROUPS_JSON` debe mantener compatibilidad con `WHATSAPP_ALERT_GROUP_NAME` como fallback y no debe romper arranque si el JSON es invalido.
- `WHATSAPP_STATUS_GROUPS_JSON` es separado de alert groups desde V0.5; si no se define, usa alert groups como fallback para mensajes de estado.
- Los mensajes de estado operativo (`✅ ready`, `🌙 fuera de horario`, `🌞 inicio de horario`) se envian a status groups. Las alertas de error se envian a alert groups. Mantener esta separacion.
- El aviso de apagado por `SIGINT`/`SIGTERM` es best-effort; no debe dejar el proceso colgado ni tocar sesion/cache.
- Las alertas criticas deben cubrir errores operativos importantes sin notificar cada OK, duplicado, blacklist ignorado, comprobante recibido o corrida sin pendientes.
- Los errores criticos no deben ocultarse por rate limit. Solo warnings repetidos de configuracion pueden deduplicarse para reducir ruido.
- Las alertas de errores deben emitirse desde capas de orquestacion cuando sea posible, para evitar doble alerta por el mismo fallo.
- No versionar `blocked-senders.json`; mantener solo `blocked-senders.example.json` como ejemplo versionado.
- No loguear telefonos completos al aplicar blacklist de remitentes.
- `BLACKLIST_DEBUG_FULL_SENDER` es solo para diagnostico local temporal; no tratarlo como operacion normal ni copiar salidas con numeros completos o LID reales a reportes o commits.
- Las reglas funcionales como blacklist no deben tocar `src/index.js`, `src/services/whatsappClient.js`, `src/config/env.js`, Puppeteer, cache/version de WhatsApp Web, `LocalAuth` ni flujo de inicializacion.
- Cualquier cambio en arranque/conexion de WhatsApp requiere una fase especifica y prueba manual autorizada de `npm start`.
- Las tareas de deploy/runbook son documentales salvo instruccion explicita; no deben ejecutar servicios reales, auth, WhatsApp ni Drive.
- Workflow para agregar grupos productivos al bot: el orden correcto es (1) agregar bot al grupo en WhatsApp como miembro, (2) verificar membresía con smoke test, (3) actualizar `WHATSAPP_STATUS_GROUPS_JSON`. Invertir el orden bloquea el `ready` del bot. Razón: `operationalNotifier` intenta resolver grupos por nombre en init, antes de `ready`; si grupo no existe fisicamente, bloquea indefinidamente. Ver deuda técnica en `CLAUDE.md`.

## Comportamiento defensivo esperado de agentes IA

- **Verificación de firma de funciones del proyecto**: antes de aceptar snippets de código propuestos por un usuario, Sonnet debe verificar que la firma de funciones sea correcta consultando el código existente del proyecto. El 14/05/2026 el prompt propuesto llamaba `notifyError(string)` pero la firma real es `(eventType, message, details, options)`. Sonnet detectó la discrepancia y aplicó el patrón correcto del proyecto (`notifySafely()` con null-guard). Comportamiento defensivo modelo.

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
- `blocked-senders.json`

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
