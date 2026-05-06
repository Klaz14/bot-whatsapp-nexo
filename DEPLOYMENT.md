# Deploy y Operacion Single-Instance

Runbook operativo para desplegar `bot-whatsapp-drive` en un entorno persistente y controlado.

Este bot debe correr como una sola instancia activa. No usar cluster, multiples workers ni escala horizontal en la version actual.

## Alcance

Este documento cubre:

- deploy controlado single-instance;
- layout de persistencia;
- variables y archivos locales;
- supervisor de proceso;
- backups y restore;
- checklist pre-deploy;
- checklist de recuperacion;
- continuidad operativa futura con numeros de WhatsApp de reserva.

No cubre deploy automatico, contenedores productivos, migracion a WhatsApp Business Cloud API ni cambios de arquitectura.

## Principios de Operacion

- Ejecutar una sola instancia del bot.
- Mantener persistentes sesion WhatsApp, OAuth Google, store de idempotencia, configuracion local y logs.
- No ejecutar `npm update` en produccion.
- Instalar dependencias con `npm ci` usando `package-lock.json`.
- No borrar `.wwebjs_auth/`, `.wwebjs_cache/`, `token.json` ni `processed-messages.json` sin backup.
- No correr `npm run auth` salvo operacion OAuth manual aprobada.
- No correr mas de un supervisor apuntando al mismo directorio de trabajo.

## Runtime Recomendado

- Node.js LTS usado en validacion: `v22.22.2`.
- npm usado en validacion: `10.9.7`.
- Dependencia WhatsApp: `whatsapp-web.js@1.34.7` instalada desde `package-lock.json`.
- Sistema operativo: Windows/PowerShell esta contemplado; Linux/systemd queda como opcion futura o alternativa controlada.

Instalacion de dependencias:

```powershell
npm ci
```

No usar:

```powershell
npm update
```

en produccion, porque puede mover dependencias sin una fase de compatibilidad.

## Chrome y Puppeteer

`whatsapp-web.js` usa Puppeteer para abrir WhatsApp Web.

Opciones:

- Usar navegador instalado por Puppeteer.
- Usar Chrome/Chromium instalado localmente con `PUPPETEER_EXECUTABLE_PATH`.

Preparacion local posible, solo con autorizacion:

```powershell
npm run setup:chrome
```

No ejecutar ese comando automaticamente en deploy si el host no tiene politica clara de instalacion de navegador.

Variables relacionadas:

```env
PUPPETEER_EXECUTABLE_PATH=
PUPPETEER_HEADLESS=
PUPPETEER_BROWSER_ARGS=
```

## Layout de Persistencia

Estos archivos y carpetas deben vivir en almacenamiento persistente del host:

```text
.env
config.json
business-calendar.json
blocked-senders.json
credentials.json
token.json
.wwebjs_auth/
processed-messages.json
uploads.log
errors.log
```

Opcionalmente persistir:

```text
.wwebjs_cache/
```

### Riesgo si se pierde cada elemento

| Elemento | Criticidad | Riesgo |
| --- | --- | --- |
| `.wwebjs_auth/` | Critico | Puede requerir escanear QR nuevamente y cortar operacion. |
| `token.json` | Critico | Drive puede dejar de funcionar hasta reautorizar OAuth. |
| `credentials.json` | Critico | No se puede crear cliente OAuth local. |
| `.env` | Critico | El bot puede arrancar con defaults incorrectos o no arrancar. |
| `config.json` | Critico si se usa como fuente de grupos/Drive | Sin grupos o carpeta raiz, no procesa correctamente. |
| `business-calendar.json` | Recuperable con riesgo operativo | Si falta o es invalido, se usan defaults y pueden ignorarse feriados. |
| `blocked-senders.json` | Recuperable con riesgo operativo | No se bloquean remitentes esperados. |
| `processed-messages.json` | Importante | Puede haber duplicados si WhatsApp reentrega mensajes. |
| `uploads.log` / `errors.log` | Importante para auditoria | Se pierde trazabilidad local. |
| `.wwebjs_cache/` | Recuperable | Puede afectar diagnostico/cache, pero no debe ser primer recurso borrarla. |

## Variables Clave

No incluir valores reales en documentacion versionada.

### Google Drive

```env
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_DRIVE_PENDING_FOLDER_ID=
GOOGLE_CREDENTIALS_PATH=credentials.json
GOOGLE_TOKEN_PATH=token.json
GOOGLE_OAUTH_SCOPE=https://www.googleapis.com/auth/drive.file
```

`GOOGLE_DRIVE_FOLDER_ID` debe apuntar a la carpeta raiz operativa `Entrantes`.

`GOOGLE_DRIVE_PENDING_FOLDER_ID`, si se define, debe apuntar a la carpeta raiz de pendientes. Si no se define, el bot busca/crea `Archivos Pendientes por Fuera de Horario` bajo la raiz controlada.

### WhatsApp

```env
WHATSAPP_AUTH_DATA_PATH=.wwebjs_auth
WHATSAPP_CLIENT_ID=
WHATSAPP_GROUPS_CONFIG_PATH=config.json
WHATSAPP_READY_TIMEOUT_SECONDS=120
WHATSAPP_WEB_VERSION=
WHATSAPP_WEB_VERSION_CACHE_TYPE=none
WHATSAPP_WEB_CACHE_PATH=.wwebjs_cache
```

Mantener `WHATSAPP_WEB_VERSION_CACHE_TYPE=none` salvo fase especifica de compatibilidad.

### Calendario y Horario Operativo

```env
BOT_TIME_ZONE=America/Argentina/Buenos_Aires
BUSINESS_CALENDAR_PATH=business-calendar.json
PENDING_PROCESSOR_INTERVAL_MINUTES=5
PENDING_PROCESSOR_MAX_ATTEMPTS=3
```

Actualizar `business-calendar.json` anualmente con feriados y dias no habiles.

### Notificaciones Operativas

```env
WHATSAPP_ALERT_GROUP_NAME=
WHATSAPP_ALERT_GROUPS_JSON=[]
OPERATIONAL_NOTIFICATIONS_ENABLED=true
OPERATIONAL_NOTIFY_ON_READY=true
OPERATIONAL_NOTIFY_ON_OFF_HOURS=true
OPERATIONAL_NOTIFY_ON_SHUTDOWN=false
OPERATIONAL_STATUS_CHECK_INTERVAL_SECONDS=60
```

Para varios grupos:

```env
WHATSAPP_ALERT_GROUPS_JSON=["BOT ALERTAS","ADMIN TRANSFERENCIAS"]
```

Si `OPERATIONAL_NOTIFY_ON_SHUTDOWN=true`, el aviso de apagado es best-effort. No hay garantia si el proceso muere abruptamente.

### Logs y Store Local

```env
LOG_UPLOADS_PATH=uploads.log
LOG_ERRORS_PATH=errors.log
LOG_MASK_PHONE_NUMBERS=true
LOG_STORE_DRIVE_LINKS=false
LOG_MAX_FIELD_LENGTH=120
PROCESSED_STORE_PATH=processed-messages.json
PROCESSED_STORE_TTL_HOURS=720
PROCESSED_STORE_MAX_ITEMS=5000
```

## Permisos Drive

La cuenta OAuth autorizada debe poder:

- listar/crear carpetas dentro de `Entrantes`;
- subir archivos;
- copiar pendientes a `Entrantes`;
- listar y actualizar `appProperties` de pendientes;
- borrar pendientes ya procesados;
- borrar subcarpetas pendientes vacias.

Revisar permisos sobre:

- carpeta `Entrantes`;
- carpeta `Archivos Pendientes por Fuera de Horario`, si se usa ID explicito;
- cualquier carpeta compartida relacionada.

Riesgo con `drive.file`: el scope suele limitarse a archivos que la app puede ver/crear o a los que se le dio acceso. Si una carpeta fue creada por otra cuenta o movida manualmente, validar permisos antes del deploy.

## WhatsApp

Antes de operar:

- el numero del bot debe estar vinculado a WhatsApp Web;
- el numero debe pertenecer a todos los grupos monitoreados;
- el numero debe pertenecer a los grupos de alertas;
- `.wwebjs_auth/` debe estar persistido y respaldado;
- no borrar sesion/cache para diagnosticar `ready` sin backup.

Si pide QR:

1. Confirmar que se esta usando el `WHATSAPP_AUTH_DATA_PATH` correcto.
2. Confirmar que `.wwebjs_auth/` existe y pertenece a ese perfil.
3. Si la sesion se perdio, restaurar backup.
4. Si no hay backup valido, escanear QR manualmente y crear backup nuevo.

Si queda autenticado pero no llega a `ready`:

1. Observar eventos `loading_screen`, `authenticated`, `change_state`.
2. Esperar la advertencia de `WHATSAPP_READY_TIMEOUT_SECONDS`.
3. No borrar `.wwebjs_auth/` ni `.wwebjs_cache/` como primera accion.
4. Revisar version de `whatsapp-web.js`, cache/version y estado de sesion.
5. Restaurar `.wwebjs_auth/` desde backup solo como operacion controlada.

## Supervisor de Proceso

El supervisor debe garantizar una sola instancia.

### Opcion PM2 en Windows/VM

Uso conceptual:

```powershell
pm2 start index.js --name bot-whatsapp-drive
pm2 save
```

Requisitos:

- no usar cluster mode;
- no configurar mas de una replica;
- usar el directorio correcto del repo;
- conservar variables de entorno;
- redirigir logs a ubicacion persistente;
- configurar restart automatico del host si aplica.

### Opcion NSSM / Servicio Windows

Uso conceptual:

- Application path: ruta a `node.exe`.
- Arguments: `index.js`.
- Startup directory: raiz del repo.
- Environment: variables necesarias o `.env` en raiz.
- Logs stdout/stderr: rutas persistentes.

Requisitos:

- una sola instancia del servicio;
- usuario Windows con permisos sobre repo, archivos persistentes y Chrome;
- no iniciar otro `npm start` manual mientras el servicio esta vivo.

### Opcion systemd en Linux

Uso conceptual:

```ini
[Service]
WorkingDirectory=/opt/bot-whatsapp-drive
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
```

Requisitos:

- un solo servicio activo;
- volumen persistente para sesiones, tokens y stores;
- Chrome/Chromium instalado o `PUPPETEER_EXECUTABLE_PATH`.

### Docker / Compose

Dejar para fase futura. Requiere disenar volumenes persistentes, Chrome, señales, usuario, permisos y backup de sesiones.

## Railway con Dockerfile y Volume `/data`

Railway queda aprobado como objetivo de deploy PaaS controlado siempre que se respete single-instance y todo estado operativo viva en un Railway Volume montado en `/data`.

Layout esperado:

```text
/app
  codigo del repo

/data
  .wwebjs_auth/
  .wwebjs_cache/
  credentials.json
  token.json
  config.json
  business-calendar.json
  blocked-senders.json
  processed-messages.json
  logs/
    uploads.log
    errors.log
    alerts.log
```

Variables Railway recomendadas:

```env
BOT_ENV=railway
BOT_TIME_ZONE=America/Argentina/Buenos_Aires

GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_DRIVE_PENDING_FOLDER_ID=
GOOGLE_CREDENTIALS_PATH=/data/credentials.json
GOOGLE_TOKEN_PATH=/data/token.json

WHATSAPP_AUTH_DATA_PATH=/data/.wwebjs_auth
WHATSAPP_WEB_CACHE_PATH=/data/.wwebjs_cache
WHATSAPP_GROUPS_CONFIG_PATH=/data/config.json
WHATSAPP_WEB_VERSION_CACHE_TYPE=none
WHATSAPP_READY_TIMEOUT_SECONDS=120

BUSINESS_CALENDAR_PATH=/data/business-calendar.json
BLOCKED_SENDERS_PATH=/data/blocked-senders.json
PROCESSED_STORE_PATH=/data/processed-messages.json
LOG_UPLOADS_PATH=/data/logs/uploads.log
LOG_ERRORS_PATH=/data/logs/errors.log
ALERTS_LOG_PATH=/data/logs/alerts.log

PENDING_PROCESSOR_INTERVAL_MINUTES=5
PENDING_PROCESSOR_MAX_ATTEMPTS=3

PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_HEADLESS=true
PUPPETEER_BROWSER_ARGS=[]

WHATSAPP_ALERT_GROUP_NAME=
WHATSAPP_ALERT_GROUPS_JSON=[]
OPERATIONAL_NOTIFICATIONS_ENABLED=true
OPERATIONAL_NOTIFY_ON_READY=true
OPERATIONAL_NOTIFY_ON_OFF_HOURS=true
OPERATIONAL_NOTIFY_ON_SHUTDOWN=false
OPERATIONAL_STATUS_CHECK_INTERVAL_SECONDS=60
```

No subir secretos a GitHub. Railway variables deben contener solo valores de configuracion; archivos sensibles como `token.json`, `credentials.json`, `config.json`, calendario, blacklist y sesion WhatsApp deben cargarse al volumen `/data`.

### Primer deploy Railway

1. Confirmar `git status --short` limpio.
2. Confirmar backup local de `.wwebjs_auth/`, `token.json`, `credentials.json`, `.env`, `config.json`, `business-calendar.json`, `blocked-senders.json` y `processed-messages.json`.
3. Crear proyecto Railway.
4. Conectar el repo GitHub.
5. Crear un servicio long-running desde el repo.
6. Crear un Railway Volume montado en `/data`.
7. Configurar variables Railway con paths absolutos `/data/...`.
8. Mantener una sola replica. No activar escala horizontal.
9. Configurar restart policy segun plan; preferencia operativa: `Always` en plan pago o `On Failure` si no estuviera disponible.
10. Cargar archivos sensibles al volumen `/data` mediante un metodo seguro autorizado. No imprimir contenidos.
11. Verificar estructura sin secretos con:

```bash
node scripts/checkRailwayData.js
```

12. Deployar con el `Dockerfile` del repo.
13. Revisar logs de Railway.
14. Confirmar `Bot listo y escuchando`.
15. Confirmar notificacion operativa en grupo admin.
16. Ejecutar prueba manual controlada dentro/fuera de horario.
17. Activar backups manuales/programados del volumen.

### Carga inicial segura de `/data`

Antes de cargar al volumen, preparar una carpeta local de staging fuera del repo versionable:

```text
railway-data/
  .wwebjs_auth/
  .wwebjs_cache/
  credentials.json
  token.json
  config.json
  business-calendar.json
  blocked-senders.json
  processed-messages.json
  logs/
```

Verificar solo existencia, tamanos y fechas. No imprimir tokens, client secrets, numeros, LID ni IDs completos.

Si falta `processed-messages.json`, puede dejarse que el bot lo cree en `/data`, pero esto aumenta riesgo de duplicados historicos si WhatsApp reentrega mensajes. Si existen logs historicos relevantes, copiarlos a `/data/logs/`.

### Actualizacion de codigo en Railway

- Mantener el volumen `/data` sin cambios.
- Actualizar solo codigo por GitHub/deploy.
- No cambiar variables de paths salvo fase explicita.
- Evitar overlap/multiples instancias durante deploy; este bot no esta disenado para dos procesos activos.
- Confirmar `ready` y notificacion operativa tras cada deploy.
- Ejecutar auditoria read-only de pendientes si hubo cambios en processor/Drive.

### Backups Railway

En el plan actual de Railway no estan disponibles los backups automaticos del volumen. Por eso, el backup externo manual es obligatorio mientras no se cambie de plan o no se habilite otra estrategia equivalente.

No usar `Wipe Volume`, `Delete Volume` ni recrear el volumen como solucion rapida. Esas acciones pueden perder sesion WhatsApp, OAuth, configuracion local, blacklist, store de idempotencia y logs.

Mantener backup externo propio de `.wwebjs_auth/`, `token.json`, `credentials.json`, configuracion local, calendario, blacklist, `processed-messages.json` y logs. Tratar esos backups como material sensible.

Frecuencia minima mientras no haya backups automaticos:

- despues del primer deploy funcional;
- antes de cambios grandes de deploy o variables;
- despues de regenerar `token.json`;
- despues de revincular WhatsApp o restaurar `.wwebjs_auth/`;
- semanalmente como rutina operativa.

Riesgos especificos Railway:

- el volumen existe en runtime, no durante build/pre-deploy;
- todo archivo fuera de `/data` puede perderse en redeploy;
- Chrome debe venir dentro de la imagen Docker;
- debugging de QR/`ready` es mas incomodo que local;
- un restore de volumen puede redeployar el servicio;
- si se crea mas de una replica puede haber duplicados, locks inutiles entre instancias y conflictos con LocalAuth.

## Estado Post-Deploy Railway

Estado operativo confirmado:

- proyecto Railway creado;
- servicio Railway: `bot-whatsapp-nexo`;
- deploy con `Dockerfile` detectado y funcionando;
- Railway Volume montado en `/data`;
- variables Railway cargadas apuntando a `/data`;
- archivos sensibles y persistentes cargados en `/data`;
- el bot llego a `ready` en Railway;
- WhatsApp autentico usando `/data/.wwebjs_auth`;
- grupo `BOT TEST` detectado;
- notificacion operativa recibida en el grupo de alertas;
- upload normal probado y subido a Drive;
- blacklist probada y funcionando;
- `node scripts/checkRailwayData.js` reporto `missing=0 typeMismatch=0`;
- `node scripts/auditPendingTransfers.js` encontro la raiz de pendientes y no habia carpetas pendientes;
- archivos temporales locales de deploy fueron limpiados/movidos;
- backups automaticos de Railway no disponibles en el plan actual.

El repo no debe contener secretos ni archivos ignorados por Git. El estado operativo real vive en `/data`.

Archivos criticos esperados en `/data`:

```text
/data/.wwebjs_auth/
/data/.wwebjs_cache/
/data/credentials.json
/data/token.json
/data/config.json
/data/business-calendar.json
/data/blocked-senders.json
/data/processed-messages.json
/data/logs/
```

### Checklist Post-Deploy Railway

- [ ] Railway service `Online`/`Active`.
- [ ] Logs muestran `Bot listo y escuchando`.
- [ ] Logs muestran sesion guardada en `/data/.wwebjs_auth`.
- [ ] Grupos configurados detectados.
- [ ] Notificacion operativa recibida.
- [ ] Upload normal probado.
- [ ] Blacklist probada.
- [ ] `node scripts/checkRailwayData.js` OK con `missing=0 typeMismatch=0`.
- [ ] `node scripts/auditPendingTransfers.js` OK.
- [ ] No hay mas de una replica activa.
- [ ] Backup externo manual creado despues del primer deploy funcional.

### Backup Manual Externo de `/data`

Respaldar desde `/data`:

```text
/data/.wwebjs_auth/
/data/credentials.json
/data/token.json
/data/config.json
/data/business-calendar.json
/data/blocked-senders.json
/data/processed-messages.json
/data/logs/
```

Comando conceptual dentro del entorno Railway, si el metodo operativo disponible permite shell seguro:

```bash
tar -czf /tmp/bot-data-backup.tar.gz -C /data .
```

Luego descargar `bot-data-backup.tar.gz` al equipo local por el metodo seguro disponible. No imprimir contenidos, no subir el `.tar.gz` a GitHub, no compartirlo por chat y guardarlo en una ubicacion protegida.

Despues de descargar y verificar el backup externo, eliminar el archivo temporal del contenedor:

```bash
rm -f /tmp/bot-data-backup.tar.gz
```

Si se usa otro metodo de copia/backup, mantener los mismos principios: no imprimir secretos, no versionar dumps y no dejar copias temporales expuestas.

### Restore Manual Railway

Procedimiento conceptual:

1. Detener el servicio o cambiar temporalmente el start command a un proceso inerte, por ejemplo `sleep infinity`, para evitar que el bot use `/data` durante el restore.
2. Restaurar los archivos/directorios respaldados dentro de `/data`.
3. Verificar estructura sin imprimir secretos:

```bash
node scripts/checkRailwayData.js
```

4. Volver al start normal del servicio.
5. Hacer redeploy/restart controlado.
6. Confirmar `Bot listo y escuchando`.
7. Confirmar notificacion operativa.
8. Probar Drive con un comprobante controlado.
9. Ejecutar auditoria read-only de pendientes:

```bash
node scripts/auditPendingTransfers.js
```

No borrar `/data`, no recrear volumen y no restaurar backups viejos sin confirmar impacto sobre `processed-messages.json` y pendientes.

## Backups

Respaldar:

```text
.wwebjs_auth/
token.json
credentials.json
.env
config.json
business-calendar.json
blocked-senders.json
processed-messages.json
uploads.log
errors.log
```

Frecuencia sugerida:

- despues de vincular WhatsApp por QR;
- despues de regenerar OAuth;
- antes de cada deploy;
- despues de cambiar grupos o calendario;
- periodicamente, al menos semanal si el host es estable;
- inmediatamente antes de tocar `.wwebjs_auth/` o `token.json`.

Buenas practicas:

- guardar backup fuera del directorio del repo;
- no subir backups a Git;
- proteger backups como material sensible;
- probar restore en una copia antes de depender de el.

## Restore

Procedimiento base:

1. Detener supervisor/bot.
2. Verificar que no queda otro proceso `node index.js`.
3. Restaurar archivos persistentes necesarios.
4. Ejecutar:

```powershell
npm ci
```

5. Validar sintaxis:

```powershell
node --check index.js
node --check auth.js
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

6. Iniciar bot manualmente o por supervisor.
7. Confirmar `Bot listo y escuchando`.
8. Confirmar notificacion operativa.
9. Ejecutar auditoria de pendientes si corresponde:

```powershell
node scripts/auditPendingTransfers.js
```

10. Revisar pendientes `failed` antes de borrar cualquier archivo.

## Checklist Pre-Deploy

- [ ] `git status --short` limpio.
- [ ] Rama esperada.
- [ ] `package-lock.json` presente.
- [ ] `npm ci` ejecutado.
- [ ] `node --check index.js`.
- [ ] `node --check auth.js`.
- [ ] `node --check` sobre `src/`.
- [ ] Chrome/Puppeteer disponible.
- [ ] `.env` presente y revisado.
- [ ] `config.json` o `WHATSAPP_ALLOWED_GROUPS_JSON` configurado.
- [ ] `business-calendar.json` actualizado.
- [ ] `blocked-senders.json` revisado.
- [ ] `credentials.json` presente.
- [ ] `token.json` presente.
- [ ] `.wwebjs_auth/` presente.
- [ ] `processed-messages.json` persistente o inicializado.
- [ ] `GOOGLE_DRIVE_FOLDER_ID` apunta a `Entrantes`.
- [ ] `GOOGLE_DRIVE_PENDING_FOLDER_ID` configurado o fallback aceptado.
- [ ] Cuenta OAuth tiene permisos sobre Drive.
- [ ] Numero WhatsApp esta en grupos monitoreados.
- [ ] Numero WhatsApp esta en grupos de alerta.
- [ ] Notificaciones configuradas.
- [ ] Backup previo creado.
- [ ] Supervisor configurado single-instance.
- [ ] No hay otra instancia del bot corriendo.

## Prueba Manual Controlada

Ejecutar solo con aprobacion operativa:

1. Iniciar bot.
2. Confirmar `Bot listo y escuchando`.
3. Confirmar notificacion de ready.
4. Enviar imagen de prueba dentro de horario.
5. Enviar PDF de prueba dentro de horario.
6. Confirmar archivos en `Entrantes/<Grupo>/<MM-YYYY>/<DD>/`.
7. Probar fuera de horario en ventana controlada o ajustando calendario local de prueba.
8. Confirmar pending en `Archivos Pendientes por Fuera de Horario/<DD-MM-YYYY>/`.
9. Volver a horario y confirmar processor.
10. Ejecutar auditoria read-only.

## Operacion Diaria

- Revisar notificaciones operativas.
- Revisar alertas de grupo administrador.
- Si hay sospecha de pendientes, ejecutar auditoria read-only.
- Revisar `errors.log` ante fallas.
- No borrar pendientes manualmente sin confirmar que ya estan en `Entrantes`.
- Actualizar `business-calendar.json` con feriados antes de cada periodo operativo.
- Mantener backups recientes de sesion WhatsApp y token OAuth.

## Alertas Criticas

El bot envia alertas a los grupos configurados cuando detecta eventos que requieren intervencion operativa:

- error subiendo comprobante a `Entrantes`;
- error encolando comprobante fuera de horario;
- pendiente fallido o con intentos agotados;
- metadata invalida en pendiente;
- error general del processor;
- pendiente copiado a `Entrantes` pero no eliminado de temporales;
- fallo escribiendo `processed-messages.json`;
- calendario laboral faltante/invalido y uso de defaults;
- blacklist local invalida;
- carpeta de pendientes sin ID explicito y uso de fallback por nombre;
- `auth_failure`, `disconnected`, timeout de `ready` o error inicializando WhatsApp.

Eventos que no deben generar alerta:

- cada comprobante OK;
- cada duplicado ignorado;
- cada remitente bloqueado;
- cada corrida sin pendientes;
- cada mensaje fuera de horario;
- cada comprobante recibido.

Las alertas se sanitizan: no deben incluir telefonos completos, LID completos, links completos de Drive, IDs completos, tokens, secretos ni payloads de chat.

Las alertas no implementan cupos ni rate limits sobre comprobantes. Los warnings de configuracion repetidos pueden deduplicarse para no generar ruido, pero los errores criticos no deben ocultarse.

## Checklist de Recuperacion

### WhatsApp no llega a ready

- [ ] Confirmar que no hay multiples instancias.
- [ ] Confirmar `WHATSAPP_AUTH_DATA_PATH`.
- [ ] Revisar eventos de consola.
- [ ] No borrar `.wwebjs_auth/` ni `.wwebjs_cache/`.
- [ ] Restaurar `.wwebjs_auth/` desde backup si la sesion local parece corrupta.
- [ ] Reescanear QR solo si no hay backup usable.

### Drive falla

- [ ] Confirmar `GOOGLE_DRIVE_FOLDER_ID`.
- [ ] Confirmar `GOOGLE_DRIVE_PENDING_FOLDER_ID`.
- [ ] Confirmar permisos de la cuenta OAuth.
- [ ] Confirmar existencia de `credentials.json` y `token.json`.
- [ ] Si el token fue revocado, ejecutar OAuth manual controlado.
- [ ] Revisar `errors.log`.

### Pendientes no se procesan

- [ ] Confirmar que el bot esta dentro de horario operativo.
- [ ] Confirmar `business-calendar.json`.
- [ ] Ejecutar `node scripts/auditPendingTransfers.js`.
- [ ] Revisar estados `queued`, `processing`, `failed`.
- [ ] Revisar intentos contra `PENDING_PROCESSOR_MAX_ATTEMPTS`.
- [ ] No borrar pendientes hasta verificar `Entrantes`.

### Duplicados

- [ ] Confirmar que corre una sola instancia.
- [ ] Confirmar que `processed-messages.json` existe y es escribible.
- [ ] Revisar si el store fue borrado/restaurado desde backup viejo.
- [ ] Revisar si hubo reprocesamiento manual de pendientes.

## Siguiente Sprint: Numeros de Reserva

No bloquea el deploy actual.

Objetivo futuro: preparar sesiones de WhatsApp de reserva para cambiar rapido si el numero principal queda inutilizable.

Principios:

- un solo numero activo por vez;
- no correr bots paralelos con distintos numeros;
- cada numero debe estar en los grupos monitoreados y de alertas;
- cada sesion debe tener backup propio;
- `processed-messages.json` puede compartirse para reducir duplicados durante el cambio.

Estructura sugerida:

```text
sessions/
  main/.wwebjs_auth/
  reserva-1/.wwebjs_auth/
  reserva-2/.wwebjs_auth/
```

Cambio rapido conceptual:

1. Detener bot.
2. Cambiar `WHATSAPP_AUTH_DATA_PATH` al perfil reserva.
3. Confirmar que el numero reserva esta en grupos.
4. Iniciar bot.
5. Confirmar `ready`.
6. Confirmar notificacion al grupo admin.
7. Auditar pendientes.

Riesgos:

- dos numeros activos pueden duplicar comprobantes;
- un numero reserva fuera de grupos no sirve para continuidad;
- sesiones pueden caducar;
- se necesita runbook de preparacion y prueba periodica.

## Comandos Seguros de Validacion

```powershell
git status --short
node --check index.js
node --check auth.js
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
npm ls --depth=0 --no-audit --fund=false
```

No ejecutar sin aprobacion:

```powershell
npm start
npm run auth
```
