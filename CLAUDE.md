# CLAUDE.md

## 1. Propósito

Este archivo complementa a `AGENTS.md` con la identidad del proyecto, el mapa arquitectónico y recomendaciones de uso específicas para Claude Code. No reemplaza ni duplica `AGENTS.md`.

**En caso de conflicto entre CLAUDE.md y AGENTS.md, prevalece AGENTS.md.** Leer AGENTS.md antes de cualquier tarea.

---

## 2. Identidad del proyecto

- **Codename:** `ruben-botta-el-renacido`
- **Versión actual:** V0.6 (13/05/2026)
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
- **Gestor de paquetes:** npm — instalar siempre con `npm ci`

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
| Cambiar notificaciones operativas | `src/services/operationalNotifier.js`, variables `WHATSAPP_ALERT_*` y `OPERATIONAL_*` |
| Cambiar configuración de arranque WhatsApp / Puppeteer | `src/services/whatsappClient.js`, variables `PUPPETEER_*` y `WHATSAPP_*` |
| Cambiar flujo OAuth / renovación de token | `src/auth/googleOAuth.js`, `src/services/driveService.js` |
| Agregar grupos monitoreados o cambiar tags | `config.json` o variable `WHATSAPP_ALLOWED_GROUPS_JSON` |
| Cambiar safety flags o dry-run | Variables `BOT_PROCESSING_ENABLED`, `BOT_DRY_RUN`, `ALLOW_REAL_*` |
| Extender auditoría de pendientes | `src/services/pendingAuditService.js`, `scripts/auditPendingTransfers.js` |
| Verificar estructura de Volume en Railway | `scripts/checkRailwayData.js` (extender `REQUIRED_ITEMS`) |

---

## 11. Deuda técnica conocida

- **Sin tests automatizados:** no hay framework de tests configurado. Toda validación es `node --check` y prueba manual. Cambios de lógica llegan a producción sin cobertura automática.
- **Código muerto:** `buildUploadFilename` y `maskSenderForFilename` están exportados pero no se usan en el flujo actual (reemplazados por la versión secuencial).
- **`alerts.log` no implementado:** el path está configurado en `.env.example` y en `config.paths.alertsLog`, pero ningún módulo escribe en él. El notificador usa solo consola.
- **Aliases redundantes en `businessCalendar.js`:** `shouldProcessNow` y `getPendingTargetDateForMessage` son wrappers exportados de funciones existentes, no usados por el código actual.
- **`folderCache` sin TTL:** el cache en memoria de IDs de carpetas Drive no expira. Si una carpeta es movida o eliminada manualmente en Drive durante la operación, el bot puede fallar hasta reiniciar.
- **README.md con estructura desactualizada:** la sección `## Estructura` no refleja los archivos actuales del proyecto (faltan módulos agregados en fases posteriores).
- **Pendientes de días anteriores no procesados automáticamente:** `pendingProcessor` solo revisa la subcarpeta del día operativo actual; días previos quedan sin procesar si el bot estuvo apagado. En V0.6 este comportamiento se simplificó: `listAllPendingFiles()` no asume estructura de carpetas, por lo que pendientes huérfanos pueden quedar sin procesar si están fuera de la carpeta raiz esperada.
- **SingletonLock sin protección en operaciones concurrentes:** la cache de IDs de carpetas Drive en `driveService.js` no tiene mecanismo de lock. Si múltiples instancias del bot intenten crear carpetas simultáneamente, el cache puede diverger del estado real en Drive.
- **logicalPath "//" después de V0.6:** stub functions `buildDriveFolderPath()` y derivadas retornan `logicalPath: '/'` para indicar que no usan subfoldersahora. Algunos logs que intentan formatear esa ruta para debugging pueden mostrar barras dobles `//`. Sin impacto funcional, pero debe limpiarse en próxima fase.
- **Técnica operativa de pausa de servicio (Railway):** durante la era V1, se usaba `tail -f /dev/null` como Custom Start Command en Railway para mantener el container "Online" sin ejecutar el bot. Es útil como técnica de mantenimiento (acceso por SSH al volume sin que el bot interfiera), pero NUNCA debe quedar como default — impide arranque normal. Si se aplica temporalmente, **acordate de limpiarlo antes de hacer redeploy productivo.**

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
