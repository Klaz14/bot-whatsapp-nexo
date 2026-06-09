# CLAUDE.md

## 1. Propósito

Este archivo complementa a `AGENTS.md` con la identidad del proyecto, el mapa arquitectónico y recomendaciones de uso específicas para Claude Code. No reemplaza ni duplica `AGENTS.md`.

**En caso de conflicto entre CLAUDE.md y AGENTS.md, prevalece AGENTS.md.** Leer AGENTS.md antes de cualquier tarea.

---

## 2. Identidad del proyecto

- **Codename:** `ruben-botta-el-renacido`
- **Versión actual:** V0.6 + PDF→JPG conversion + 54 grupos productivos + patch whatsapp-web.js (incidente ready_timeout 04-05/06/2026)
- **WhatsApp profile name:** Rubén Botta LA RESURRECCIÓN
- **Relación con el bot anterior:** reemplazo completo del bot `bot-whatsapp-drive` original. Mismo repositorio, misma estructura de código. Las credenciales Google y el token OAuth se renuevan por completo (nuevos `credentials.json` y `token.json`).
- **Carpeta Drive raíz:** se reutiliza la carpeta `Entrantes` existente (`GOOGLE_DRIVE_FOLDER_ID` se mantiene sin cambios).

---

## 3. Visión general

El bot escucha grupos de WhatsApp configurados y sube imágenes y PDFs a Google Drive, organizando los archivos en `PULL TRANSFERENCIAS/` (raíz, sin subcarpetas por grupo) con naming secuencial `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>`, donde el TAG identifica el grupo. No realiza OCR, IA ni validación semántica: cualquier imagen o PDF recibido en un grupo permitido se considera comprobante.

Dentro del horario operativo (configurable vía `business-calendar.json`), los comprobantes se suben directamente a `Entrantes`. Fuera de horario, se encolan en una carpeta de pendientes en Drive con metadata en `appProperties`. Un procesador periódico, activo solo dentro de horario, mueve esos archivos a su destino final una vez que el bot retoma operación.

La idempotencia se garantiza con un store local (`processed-messages.json`) que registra un SHA-256 de `chatId|messageId` después de cada subida exitosa. Los pendientes también se deduplicán consultando Drive por `appProperties.messageKey`. El bot envía notificaciones de estado y alertas operativas a grupos administradores de WhatsApp configurados.

---

## 4. Stack y dependencias clave

- **Runtime:** Node.js 22 LTS (CommonJS)
- **WhatsApp Web:** `whatsapp-web.js` con `LocalAuth` y Puppeteer/Chromium
- **Google Drive:** `googleapis` v3, OAuth Client ID (no Service Account)
- **QR terminal:** `qrcode-terminal`
- **PDF→JPG conversion:** `node-poppler@^9.1.2` para convertir primera página de PDFs a JPEG (DPI 200). Requiere `poppler-utils` y `poppler-data` instalados en imagen Docker (para Railway/Linux)
- **Gestor de paquetes:** npm — instalar siempre con `npm ci`
- **Patch local de whatsapp-web.js:** `patches/Client.js` sobrescribe `node_modules/whatsapp-web.js/src/Client.js` en el build Docker (ver `Dockerfile`). Activo desde 05/06/2026 para compatibilidad con WhatsApp Web familia 2.3000.x (incidente ready_timeout / issue #3971). Ver sección 11 y NEKO_LOG.md.

---

## 5. Documentación relacionada

| Archivo | Qué cubre |
|---|---|
| **AGENTS.md** | **LEER PRIMERO.** Fuente primaria de reglas para agentes IA: permitidos, prohibidos, flujo de trabajo, política de secretos, archivos sensibles y advertencias operativas. |
| **README.md** | Documentación operativa central: variables de entorno, flujo OAuth, sesión WhatsApp, calendario laboral, cola de pendientes, notificaciones, blacklist, logs y recuperación. |
| **DEPLOYMENT.md** | Runbook formal: deploy Railway con Volume `/data`, layout de persistencia, backups manuales, restore, checklists pre/post-deploy y continuidad operativa. |

---

## 6. Reglas operativas críticas

1. **PROHIBIDO HACER PRUEBAS EN PRODUCCIÓN.** Producción es SOLO LECTURA. Cualquier dato necesario debe extraerse sin ejecutar escrituras, mutaciones, deploys ni migraciones.

2. **Archivos sensibles son SOLO LECTURA PARA CONTEXTO.** Nunca escribir, modificar, copiar, loguear ni incluir en respuestas el contenido de `.env*`, `credentials*.json`, `token.json`, service-account JSONs ni ningún archivo con tokens o secretos.

3. **Operaciones destructivas requieren APROBACIÓN EXPLÍCITA** antes de ejecutarse. Incluye (no exhaustivo): `rm -rf`, `git push --force`, `git reset --hard`, `firebase deploy`, `firestore:delete`, `DROP`, `TRUNCATE`, migraciones de datos, comandos que reescriban lockfiles sin razón clara.

4. **Claude Code NO hace commits ni push sin permiso explícito del usuario.** Puede hacer `git pull`, investigar ramas y obtener información sin modificar estado del repositorio ni producción.

5. **Documentación viva:** mantener actualizados CLAUDE.md, AGENTS.md, README.md y DEPLOYMENT.md ante cualquier cambio relevante de flujo, variables de entorno, deploy o arquitectura.

---

## 7. Comandos disponibles

| Script | Qué hace | Restricciones |
|---|---|---|
| `npm start` | Inicia el bot completo (WhatsApp + Drive) | **Requiere aprobación explícita.** Conecta servicios reales. |
| `npm run auth` | Flujo OAuth manual para obtener/renovar `token.json` | **Requiere aprobación explícita.** Escribe `token.json`. No usar en automatizaciones. |
| `npm run setup:chrome` | Instala Chromium local para Puppeteer | **Requiere aprobación explícita.** Puede descargar binario grande. |

**Comandos seguros sin aprobación especial:**

```powershell
node --check index.js
node --check auth.js
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
npm ls --depth=0 --no-audit --fund=false
node scripts/checkRailwayData.js        # valida estructura de /data, sin escribir
node scripts/auditPendingTransfers.js   # auditoría read-only de pendientes en Drive
```

---

## 8. Modelo recomendado por tipo de tarea

| Tipo de tarea | Modelo |
|---|---|
| Renombrar, formatear, boilerplate, lectura/resumen de archivos | Haiku |
| Implementación mediana, refactor, debugging común, escribir tests, conectar funciones | Sonnet |
| Decisiones arquitectónicas, refactor grande, debugging complejo (concurrencia, race conditions), auditorías de seguridad | Opus |

---

## 9. Flujo de trabajo recomendado (de AGENTS.md)

1. **Auditar y planificar** — leer el código y documentación afectada antes de tocar nada.
2. **Implementar en cambios chicos** — mantener funcionalidad actual salvo instrucción explícita.
3. **Validar con `node --check`** — nunca con `npm start` ni `npm run auth` salvo autorización.
4. **Documentar lo cambiado** — actualizar los `.md` relevantes en la misma tarea.
5. **Solicitar aprobación antes de conectar servicios reales** — nunca asumir que se puede ejecutar en producción.

---

## 10. Mapa "dónde tocar qué"

| Capability | Archivos candidatos |
|---|---|
| Cambiar lógica de horario operativo / días hábiles | `src/utils/businessCalendar.js`, `business-calendar.json` |
| Cambiar formato o naming del archivo subido a Entrantes | `src/utils/fileNames.js`, `src/utils/mime.js`, `src/utils/sanitize.js`, `src/utils/time.js` |
| Cambiar estructura de carpetas en Drive (estructura flat) | `src/services/driveService.js`, `src/services/pendingDriveService.js` |
| Agregar o cambiar tipos de archivo aceptados | `src/utils/mime.js` (`ALLOWED_MIME`, `extFromMime`) |
| Modificar blacklist de remitentes | `src/services/blockedSenders.js`, `blocked-senders.json` |
| Cambiar política de idempotencia / deduplicación | `src/services/processedStore.js`, `src/handlers/messageHandler.js` |
| Cambiar lógica de cola fuera de horario (encolado) | `src/handlers/messageHandler.js`, `src/services/driveService.js` |
| Cambiar procesamiento de pendientes (reintento, cleanup) | `src/services/pendingProcessor.js`, `src/services/pendingDriveService.js` |
| Cambiar formato o destino de logs | `src/services/logService.js`, `src/utils/mask.js`, `src/utils/sanitize.js` |
| Cambiar notificaciones operativas (canales status/alert) | `src/services/operationalNotifier.js`, variables `WHATSAPP_ALERT_*`, `WHATSAPP_STATUS_*` y `OPERATIONAL_*` |
| Cambiar canal daily (inicio/fin de día hábil) | `src/services/operationalNotifier.js` (`sendToDailyGroups`, `getDailyGroupNames`), `src/config/env.js`, variables `WHATSAPP_DAILY_GROUPS_JSON` y `OPERATIONAL_DAILY_NOTIFY_DELAY_MS` |
| Cambiar configuración de arranque WhatsApp / Puppeteer | `src/services/whatsappClient.js`, variables `PUPPETEER_*` y `WHATSAPP_*` |
| Cambiar flujo OAuth / renovación de token | `src/auth/googleOAuth.js`, `src/services/driveService.js` |
| Agregar grupos monitoreados o cambiar tags | `config.json` o variable `WHATSAPP_ALLOWED_GROUPS_JSON` |
| Cambiar safety flags o dry-run | Variables `BOT_PROCESSING_ENABLED`, `BOT_DRY_RUN`, `ALLOW_REAL_*` |
| Extender auditoría de pendientes | `src/services/pendingAuditService.js`, `scripts/auditPendingTransfers.js` |
| Verificar estructura de Volume en Railway | `scripts/checkRailwayData.js` (extender `REQUIRED_ITEMS`) |
| Cambiar lógica de conversión PDF→JPG | `src/utils/pdfConverter.js`, `src/handlers/messageHandler.js` (bloque conversión), `Dockerfile` (deps poppler) |
| Modificar excepción de blacklist por grupo | `src/services/blockedSenders.js`, `src/config/env.js`, variable `BLACKLIST_EXEMPT_GROUPS_JSON` |
| Actualizar o revisar el patch de whatsapp-web.js | `patches/Client.js`, `Dockerfile` (línea COPY patches/) |

---

## 11. Deuda técnica conocida

- **Sin tests automatizados:** no hay framework de tests configurado. Toda validación es `node --check` y prueba manual. Cambios de lógica llegan a producción sin cobertura automática.
- **Código muerto:** `buildUploadFilename` y `maskSenderForFilename` están exportados pero no se usan en el flujo actual (reemplazados por la versión secuencial).
- **`alerts.log` no implementado:** el path está configurado en `.env.example` y en `config.paths.alertsLog`, pero ningún módulo escribe en él. El notificador usa solo consola.
- **Aliases redundantes en `businessCalendar.js`:** `shouldProcessNow` y `getPendingTargetDateForMessage` son wrappers exportados de funciones existentes, no usados por el código actual.
- **`folderCache` sin TTL:** el cache en memoria de IDs de carpetas Drive no expira. Si una carpeta es movida o eliminada manualmente en Drive durante la operación, el bot puede fallar hasta reiniciar.
- **README.md con estructura desactualizada:** la sección `## Estructura` no refleja los archivos actuales del proyecto (faltan módulos agregados en fases posteriores).
- **Pendientes de días anteriores no procesados automáticamente:** `pendingProcessor` solo revisa la subcarpeta del día operativo actual; días previos quedan sin procesar si el bot estuvo apagado. En V0.6 este comportamiento se simplificó: `listAllPendingFiles()` no asume estructura de carpetas, por lo que pendientes huérfanos pueden quedar sin procesar si están fuera de la carpeta raiz esperada.
- **`folderCache` y `getOrCreateFolder` son código muerto en V0.6 (estructura plana):** desde V0.6 el path de subida usa `driveFolderId` directamente sin crear subcarpetas, por lo que `getOrCreateFolder()` y su cache no se invocan. El código está exportado pero no se usa. Audit del 27/05/2026 confirmó que la sección crítica de subidas SÍ está serializada vía `withFolderLock()` (driveService.js:174), mecanismo que estaba sin documentar. La deuda real es el código muerto a remover, no la falta de lock.
- **logicalPath "//" después de V0.6:** stub functions `buildDriveFolderPath()` y derivadas retornan `logicalPath: '/'` para indicar que no usan subfoldersahora. Algunos logs que intentan formatear esa ruta para debugging pueden mostrar barras dobles `//`. Sin impacto funcional, pero debe limpiarse en próxima fase.
- **Técnica operativa de pausa de servicio (Railway):** durante la era V1, se usaba `tail -f /dev/null` como Custom Start Command en Railway para mantener el container "Online" sin ejecutar el bot. Es útil como técnica de mantenimiento (acceso por SSH al volume sin que el bot interfiera), pero NUNCA debe quedar como default — impide arranque normal. Si se aplica temporalmente, **acordate de limpiarlo antes de hacer redeploy productivo.**
- **Bug operationalNotifier — resolución de grupos pre-ready:** el módulo intenta resolver los nombres de grupos en `WHATSAPP_STATUS_GROUPS_JSON` durante la inicialización del bot, ANTES del evento `ready`. Cuando un grupo configurado no existe físicamente (bot no es miembro), la resolución bloquea indefinidamente y previene el `ready`. **Viola la regla del proyecto**: "las notificaciones operativas no deben bloquear ready". Workaround actual: agregar bot a los grupos FÍSICAMENTE antes de configurarlos en `WHATSAPP_STATUS_GROUPS_JSON`. Fix sugerido: lazy resolution — resolver solo en el momento de enviar; si grupo no existe, loguear warning y continuar.
- **Mensajes durante outage no se procesan retroactivamente:** cuando el bot está autenticado-pero-no-ready, los mensajes entrantes a los grupos no se acumulan en cola interna de whatsapp-web.js. Si el bot vuelve a ready, esos mensajes se pierden y deben reenviarse manualmente. Detectado el 14/05 con `comprobante-207.pdf` que llegó durante outage y no fue procesado al recovery.
- **P5 — Pérdida silenciosa de comprobante si Drive falla 3 reintentos (MEDIA, identificada en audit del 27/05/2026):** dentro de horario operativo, si `uploadWithRetry()` (driveService.js:249) agota los 3 reintentos por error transitorio de Drive (429, 5xx), el handler (messageHandler.js:277) captura el error y alerta a BOT TEST, pero **NO reencola el comprobante a pending**. El mensaje de WhatsApp ya fue consumido (fire-and-forget), por lo que el comprobante se pierde silenciosamente: no se sube, no queda pending, no se marca processed, no se reprocesa. Fix recomendado: en el catch del handler, fallback a pending cuando upload live agota reintentos.
- **P4 — Conversión PDF sin límite de concurrencia (MEDIA, identificada en audit del 27/05/2026):** `pdfConverter.js` no limita la cantidad de conversiones simultáneas. Si llegan 10 PDFs en paralelo, se spawnean 10 procesos `pdftocairo` concurrentes que rasterizan a 200 DPI. Riesgo de pico de RAM/CPU u OOM-kill del container Railway, con pérdida de comprobantes en vuelo. Fix recomendado: semáforo / pool de concurrencia limitando a 2-3 conversiones simultáneas.
- **P6 — Handler fire-and-forget sin cola global (MEDIA, identificada en audit del 27/05/2026):** `client.on('message', handler)` dispara handlers en paralelo sin queue interna ni backpressure. Si llegan N mensajes simultáneos, se procesan N handlers concurrentes. La subida a Drive queda serializada por `withFolderLock`, pero descarga + conversión PDF + dedup corren todas en paralelo sin límite. Amplifica P4. Fix recomendado: cola interna de trabajo con worker pool de N=2-3, que también resuelve P4 con el mismo mecanismo.
- **Retry genérico en `uploadWithRetry` (BAJA, identificada en audit del 27/05/2026):** el retry actual no diferencia errores retryables (429, 5xx) de no retryables (4xx permanentes) y no respeta el header `Retry-After` que Drive envía en 429. Desperdicia reintentos en errores permanentes. Fix recomendado: detección de status code + respeto de Retry-After + jitter.
- **Patch local de whatsapp-web.js — revisión ante updates del paquete:** `patches/Client.js` es una copia modificada de `Client.js` 1.34.7 que resuelve la incompatibilidad con WhatsApp Web 2.3000.x (ready_timeout / issue #3971, incidente 04-05/06/2026). Si se actualiza `whatsapp-web.js` en `package.json`, el patch puede quedar desincronizado con el nuevo `Client.js`. **Antes de cualquier update del paquete, comparar diff entre `patches/Client.js` y el nuevo `Client.js` y decidir si el patch sigue siendo necesario o puede removerse.** Deploy cycle para builds parcheados: (1) pausar con `tail -f /dev/null`; (2) commit+push; (3) SSH: `find /data/.wwebjs_auth/ -name "Singleton*" -delete`; (4) despausar (Custom Start Command vacío); (5) smoke test.
- **Bug operationalNotifier — cachedChats eliminado pero pre-ready sigue pendiente:** el 28/05/2026 se eliminó `cachedChats` (cache que amplificaba el bug). El bug de fondo (resolución de grupos en init, antes de `ready`) permanece como deuda. Fix sugerido: lazy resolution — resolver solo en el momento de enviar; si grupo no existe, loguear warning y continuar.
- **`BLACKLIST_EXEMPT_GROUPS_JSON` desacoplada de blacklist global:** env var agregada el 28/05/2026. Los grupos listados en esta variable ignoran `blocked-senders.json`. Si no se define o está vacía, comportamiento idéntico al anterior. Ver `src/services/blockedSenders.js`.

---

## 12. Convenciones del proyecto

- **Idioma operativo:** español — prompts, mensajes de log, comentarios y respuestas internas en español.
- **Módulos:** CommonJS (`require` / `module.exports`). No usar ES modules.
- **Single-instance:** una sola instancia del bot activa en todo momento. Sin cluster ni workers múltiples.
- **Naming de archivos JS:** camelCase (`driveService.js`, `messageHandler.js`, `businessCalendar.js`).
- **Naming de carpetas:** camelCase (`handlers/`, `services/`, `utils/`, `config/`, `auth/`).
- **Sin rutas hardcodeadas:** todas las rutas configurables vía variables de entorno con fallback relativo a `PROJECT_ROOT` (resuelto en `src/config/paths.js`).
- **Sanitización antes de log, filename y persistencia:** usar `src/utils/mask.js` para masking de datos sensibles, `src/utils/sanitize.js` para filenames y nombres de carpetas.
- **Write atómico para stores locales:** escribir a archivo `.tmp` → `fs.renameSync` al path final (patrón de `processedStore.js`).
- **Metadata de pendientes en Drive:** solo vía `appProperties`; nunca teléfonos, LIDs, links completos ni tokens.
- **Workflow para agregar grupos productivos al bot:** por el bug del operationalNotifier, el orden correcto es: (1) agregar el bot FÍSICAMENTE al grupo en WhatsApp, (2) verificar membresía con smoke test, (3) actualizar `WHATSAPP_STATUS_GROUPS_JSON` para incluir el nuevo grupo. Invertir el orden bloquea el `ready` del bot.
