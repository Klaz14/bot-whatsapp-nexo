# bot-whatsapp-drive

Bot Node.js standalone que escucha grupos permitidos de WhatsApp con `whatsapp-web.js` y sube imagenes/PDFs a Google Drive usando OAuth Client ID + `token.json`.

## Estado actual

- Proveedor WhatsApp: `whatsapp-web.js` con sesion local `LocalAuth`.
- Proveedor almacenamiento: Google Drive API via `googleapis`.
- Runtime: Node.js CommonJS.
- Entrada principal: `index.js`, wrapper hacia `src/index.js`.
- Autenticacion Google: `auth.js`, wrapper hacia `src/auth/googleOAuth.js`.
- Configuracion: variables de entorno con compatibilidad hacia `config.json`.

## Estructura

```text
bot-whatsapp-drive/
  index.js
  auth.js
  src/
    index.js
    auth/
      googleOAuth.js
    config/
      env.js
      paths.js
    handlers/
      messageHandler.js
    services/
      blockedSenders.js
      driveService.js
      logService.js
      operationalNotifier.js
      pendingAuditService.js
      pendingDriveService.js
      pendingProcessor.js
      processedStore.js
      whatsappClient.js
    utils/
      businessCalendar.js
      fileNames.js
      mask.js
      mime.js
      pdfConverter.js
      sanitize.js
      time.js
  scripts/
    auditPendingTransfers.js
    checkRailwayData.js
  patches/
    Client.js
  .dockerignore
  .env.example
  .gitignore
  blocked-senders.example.json
  business-calendar.example.json
  config.example.json
  config.json
  AGENTS.md
  CLAUDE.md
  DEPLOYMENT.md
  Dockerfile
  README.md
  package.json
  package-lock.json
```

Archivos locales sensibles como `credentials.json`, `credentials.service-account.json.bak`, `token.json`, `.wwebjs_auth/`, `.wwebjs_cache/`, `uploads.log`, `errors.log`, `start-debug.log`, `blocked-senders.json`, `business-calendar.json`, `processed-messages.json`, `NEKO_LOG.md` y `.env` estan ignorados por Git.

## Instalacion

```bash
npm install
```

La primera instalacion puede tardar porque `whatsapp-web.js` usa Puppeteer/Chromium.

### Dependencias del sistema (Linux/Railway)

Si el bot se ejecuta en Railway (Linux), ademas de `npm install`, se requieren binarios del sistema para la conversión PDF→JPG:

```bash
apt-get update && apt-get install -y --no-install-recommends poppler-utils poppler-data
```

En el Dockerfile del proyecto esta preconfigurado. El paquete npm `node-poppler@^9.1.2` depende de estos binarios para convertir PDFs a imagenes JPEG.

## Configuracion

Copiar `.env.example` a `.env` y completar solo los valores necesarios. No subir `.env` ni credenciales.

Variables principales:

```env
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_DRIVE_PENDING_FOLDER_ID=
BOT_TIME_ZONE=America/Argentina/Buenos_Aires
GOOGLE_CREDENTIALS_PATH=credentials.json
GOOGLE_TOKEN_PATH=token.json
GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1
GOOGLE_OAUTH_REDIRECT_PORT=53682
GOOGLE_OAUTH_TIMEOUT_SECONDS=300
WHATSAPP_AUTH_DATA_PATH=.wwebjs_auth
WHATSAPP_GROUPS_CONFIG_PATH=config.json
WHATSAPP_READY_TIMEOUT_SECONDS=120
WHATSAPP_WEB_VERSION=
WHATSAPP_WEB_VERSION_CACHE_TYPE=none
WHATSAPP_WEB_CACHE_PATH=.wwebjs_cache
PUPPETEER_EXECUTABLE_PATH=
PUPPETEER_HEADLESS=
PUPPETEER_BROWSER_ARGS=
LOG_UPLOADS_PATH=uploads.log
LOG_ERRORS_PATH=errors.log
LOG_MASK_PHONE_NUMBERS=true
LOG_STORE_DRIVE_LINKS=false
LOG_MAX_FIELD_LENGTH=120
PROCESSED_STORE_PATH=processed-messages.json
PROCESSED_STORE_TTL_HOURS=720
PROCESSED_STORE_MAX_ITEMS=5000
WHATSAPP_ALERT_GROUP_NAME=
WHATSAPP_ALERT_GROUPS_JSON=[]
WHATSAPP_STATUS_GROUPS_JSON=[]
OPERATIONAL_NOTIFICATIONS_ENABLED=true
OPERATIONAL_NOTIFY_ON_READY=true
OPERATIONAL_NOTIFY_ON_OFF_HOURS=true
OPERATIONAL_NOTIFY_ON_SHUTDOWN=false
OPERATIONAL_STATUS_CHECK_INTERVAL_SECONDS=60
BOT_PROCESSING_ENABLED=true
ALLOW_REAL_WHATSAPP_CONNECTION=true
ALLOW_REAL_DRIVE_UPLOADS=true
BLACKLIST_EXEMPT_GROUPS_JSON=[]
```

Por compatibilidad, si no se define `GOOGLE_DRIVE_FOLDER_ID` ni `WHATSAPP_ALLOWED_GROUPS_JSON`, el bot lee `config.json`:

```json
{
  "driveFolderId": "YOUR_GOOGLE_DRIVE_FOLDER_ID",
  "groups": {
    "WHATSAPP_GROUP_NAME": "TAG"
  }
}
```

La clave de `groups` debe coincidir exactamente con el nombre del grupo en WhatsApp. El valor se usa como tag en el nombre del archivo subido.

`GOOGLE_DRIVE_FOLDER_ID` o `config.json.driveFolderId` debe apuntar a la carpeta operativa de comprobantes (`PULL TRANSFERENCIAS`), que vive dentro de la carpeta raiz `Entrantes` en Drive. El `driveFolderId` operativo vive en `config.json` (ignorado por Git); no exponer el ID real en archivos versionados.

## Chrome/Puppeteer

`whatsapp-web.js` usa Puppeteer para abrir WhatsApp Web. Si aparece un error como `Could not find Chrome`, significa que Puppeteer no encontro el navegador requerido en su cache local o no tiene una ruta explicita a Chrome/Chromium.

Solucion recomendada para preparar el entorno local:

```bash
npm run setup:chrome
```

Ese comando ejecuta `npx puppeteer browsers install chrome`. Puede descargar un navegador y requiere internet, pero no conecta WhatsApp ni Google Drive.

Alternativa: usar un Chrome/Chromium ya instalado indicando la ruta en `.env`:

```env
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome-or-chromium
```

En Windows, usar una ruta local propia como valor de `PUPPETEER_EXECUTABLE_PATH`. No hardcodear rutas personales en el codigo ni en archivos versionados.

Variables opcionales:

```env
PUPPETEER_EXECUTABLE_PATH=
PUPPETEER_HEADLESS=
PUPPETEER_BROWSER_ARGS=
```

`PUPPETEER_BROWSER_ARGS` acepta una lista separada por comas o un array JSON. Si algun argumento contiene coma, usar array JSON. Si no se definen estas variables, el bot conserva el comportamiento default de Puppeteer/`whatsapp-web.js`.

## Google Drive OAuth

El codigo actual usa OAuth Client ID, no Service Account.

1. Crear un proyecto en Google Cloud.
2. Habilitar Google Drive API.
3. Crear una credencial tipo OAuth Client ID para aplicacion de escritorio.
4. Descargar el JSON y guardarlo como `credentials.json` en la raiz, o indicar otra ruta con `GOOGLE_CREDENTIALS_PATH`.
5. Ejecutar manualmente el flujo OAuth solo cuando sea necesario:

```bash
npm run auth
```

Ese comando levanta un servidor local en el puerto configurado, muestra una URL de Google y guarda `token.json` al finalizar. No ejecutarlo en automatizaciones ni sin autorizacion, porque escribe token local.

El servidor OAuth local escucha por defecto solo en `127.0.0.1` y usa `state` para validar que el callback corresponda a la solicitud iniciada por la terminal. No imprime codigos OAuth, tokens ni query params del callback.

Variables relacionadas:

```env
GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1
GOOGLE_OAUTH_REDIRECT_PORT=53682
GOOGLE_OAUTH_TIMEOUT_SECONDS=300
```

La URL de autorizacion que muestra `npm run auth` permite iniciar sesion en Google y no debe compartirse. Si el puerto esta ocupado, cerrar otra instancia de `auth.js` o cambiar `GOOGLE_OAUTH_REDIRECT_PORT` y asegurarse de que la credencial OAuth permita ese redirect local. `token.json` queda local e ignorado por Git.

## Login WhatsApp

El bot usa WhatsApp Web. La primera vez que se ejecuta muestra un QR en terminal. Escanearlo desde el telefono de la eSIM del bot:

```bash
npm start
```

La sesion queda guardada en `.wwebjs_auth/`. No borrar ni mover esa carpeta sin backup, porque podria requerir escanear QR nuevamente.

Durante el arranque el bot informa eventos seguros de diagnostico de WhatsApp Web, como carga, cambios de estado, autenticacion y `ready`. Si la sesion se autentica pero `ready` no llega, despues de:

```env
WHATSAPP_READY_TIMEOUT_SECONDS=120
```

se imprime una advertencia de diagnostico y el proceso queda vivo para observacion. Ese timeout no borra sesion, no borra cache y no corta un bot ya listo para operar 24/7.

Por defecto el bot evita servir HTML local cacheado de WhatsApp Web:

```env
WHATSAPP_WEB_VERSION_CACHE_TYPE=none
```

Si hace falta probar una version cacheada especifica sin borrar `.wwebjs_cache/`, se puede usar una configuracion local controlada:

```env
WHATSAPP_WEB_VERSION=2.x.x
WHATSAPP_WEB_VERSION_CACHE_TYPE=local
WHATSAPP_WEB_CACHE_PATH=.wwebjs_cache
```

No versionar estos ajustes si contienen datos operativos locales.

## Ejecucion local

```bash
npm start
```

Cuando el bot esta listo, escucha mensajes de grupos configurados. Si el mensaje trae imagen o PDF, lo descarga y lo procesa. Otros tipos de archivo se ignoran.

Para esta fase, toda imagen o PDF recibido en un grupo configurado se considera comprobante. No hay OCR, IA, reconocimiento visual, lectura bancaria ni validacion semantica del contenido.

#### Conversion PDF → JPG

Los PDFs se convierten automaticamente a JPEG (primera página únicamente, DPI 200) antes de ser subidos a Drive, porque sistemas downstream (OCR) solo procesan imagenes, no PDFs.

- **Entrada:** PDF en cualquier tamaño o cantidad de páginas
- **Proceso:** conversión de la primera página via `node-poppler`
- **Salida:** JPEG de 200 DPI, archivo convertido sigue el flujo normal de upload/pending
- **Nombre final:** sigue patrón `<ID>_<DDMM>_<HHmm>_<TAG>.jpg` (extension es siempre `.jpg`, nunca `.pdf`)
- **Errores:** si la conversion falla (PDF corrupto, encriptado, sin páginas), el bot loguea el error, notifica al grupo administrador via canal de alertas, y NO marca el mensaje como procesado (queda disponible para reintento manual)

Imagenes (JPG, PNG, WebP, GIF) y otros tipos permitidos se suben tal cual, sin conversion.

Los comprobantes se organizan dentro de la carpeta raiz configurada (PULL TRANSFERENCIAS) con esta estructura (planos, sin subcarpetas por grupo ni fecha):

```text
PULL TRANSFERENCIAS/<ID>_<DDMM>_<HHmm>_<TAG>.<ext>
```

Ejemplo:

```text
PULL TRANSFERENCIAS/1_0505_2243_BT.jpg
```

Todos los comprobantes se guardan planos en `PULL TRANSFERENCIAS/` sin subcarpetas. El grupo se identifica por el TAG incluido en el filename, no por estructura de carpetas. El bot escribe directamente en la carpeta raiz sin crear niveles adicionales.

Los archivos se nombran con:

```text
<ID>_<DDMM>_<HHmm>_<TAG>.<ext>
```

Ejemplos:

```text
1_0505_2243_BT.jpg
2_0505_2248_BT.pdf
3_0505_2252_BT.jpg
1_0506_0915_BT.jpg
```

El `ID` es incremental por día calendario (resetea cada día). Para calcularlo, el bot lista todos los archivos en `PULL TRANSFERENCIAS/` y toma en cuenta solo nombres que cumplen el formato completo `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>`, con DDMM y hora valida. Dentro de un mismo día (mismo DDMM), el bot incrementa el ID. Archivos manuales o con formato parcial se ignoran para evitar saltos artificiales en la secuencia.

El `DDMM` es el día-mes del mensaje original (fecha local según `BOT_TIME_ZONE`). La hora `HHmm` sale del timestamp del mensaje de WhatsApp. El `TAG` sale del valor configurado para el grupo en `config.json.groups` y permite identificar qué grupo originó el archivo. El filename no incluye telefonos, LID ni remitentes.

## Calendario laboral

El horario operativo se define con un calendario local editable. Fuera de horario, el bot descarga imagenes/PDFs permitidos y los encola en Drive como pendientes; dentro de horario conserva el flujo normal hacia `Entrantes`.

El archivo real local debe llamarse:

```text
business-calendar.json
```

Ese archivo esta ignorado por Git. Usar `business-calendar.example.json` como plantilla:

```json
{
  "timeZone": "America/Argentina/Buenos_Aires",
  "businessDays": [1, 2, 3, 4, 5],
  "startTime": "09:00",
  "endTime": "16:30",
  "nonBusinessDates": [
    {
      "date": "2026-01-01",
      "name": "Feriado de ejemplo"
    }
  ]
}
```

`businessDays` usa la numeracion de JavaScript: `0` domingo, `1` lunes, `2` martes, `3` miercoles, `4` jueves, `5` viernes y `6` sabado. Por defecto el horario operativo es lunes a viernes de `09:00` a `16:30` en `America/Argentina/Buenos_Aires`.

Los dias no habiles se cargan manualmente en `nonBusinessDates` con formato `YYYY-MM-DD`. Tambien se soporta una lista simple de strings si no hace falta nombre descriptivo. El horario de inicio es inclusivo y `16:30` tambien se considera dentro de horario; despues de `16:30`, antes de `09:00`, sabados, domingos y dias no habiles se encolan para la fecha operativa correspondiente.

## Pendientes fuera de horario

Los comprobantes recibidos fuera de horario se guardan temporalmente en Drive como pendientes. Los mensajes dentro del horario operativo siguen procesandose como antes.

La carpeta raiz de pendientes se puede configurar con:

```env
GOOGLE_DRIVE_PENDING_FOLDER_ID=
PENDING_PROCESSOR_INTERVAL_MINUTES=5
PENDING_PROCESSOR_MAX_ATTEMPTS=3
```

Si esa variable no esta definida, el bot busca o crea una carpeta llamada:

```text
Archivos Pendientes por Fuera de Horario
```

Desde V0.6, los pendientes se guardan planos en esa carpeta raiz, sin subcarpetas por fecha. Cada archivo pendiente usa un nombre temporal seguro, no final:

```text
pending_<HHmm>_<TAG>_<messageKeyShort>.<ext>
```

Ejemplo:

```text
pending_1820_BT_a1b2c3d4.jpg
```

La metadata esencial se guarda en `appProperties` de Google Drive: `messageKey` hasheado, estado del pendiente, grupo sanitizado, tag, MIME, hora original UTC/local, fecha operativa, fecha de encolado, intentos y ultimo error sanitizado. No debe incluir telefonos completos, LID completos, links completos de Drive, tokens ni payloads de chat.

El pendiente conserva el grupo original como `groupFolderName` sanitizado y conserva el `tag` por separado. Al procesarse, la carpeta final en `Entrantes` sale de `groupFolderName`; el `tag` solo se usa en el filename final `<ID>_<HHmm>_<TAG>.<ext>`. No usar el tag como unica referencia para decidir carpeta final.

Estados previstos:

```text
queued
processing
uploaded
failed
```

Cuando el bot llega a `ready`, inicia un procesador de pendientes. El procesador corre solo dentro del horario operativo: hace una corrida inmediata al arrancar y luego reintenta cada `PENDING_PROCESSOR_INTERVAL_MINUTES`, por defecto `5`. Si el bot esta fuera de horario, no procesa pendientes y los conserva.

El procesador lista todos los archivos pendientes en la carpeta raiz. Para cada archivo `queued` o `failed` con menos de `PENDING_PROCESSOR_MAX_ATTEMPTS` intentos, marca estado `processing`, lo copia dentro de `PULL TRANSFERENCIAS/` con el naming final `<ID>_<DDMM>_<HHmm>_<TAG>.<ext>`, marca el mensaje como procesado solo despues de confirmar la copia final, marca el pendiente como `uploaded` y recien entonces elimina el archivo pendiente.

Si falla algun paso, el archivo pendiente no se borra, no se marca como procesado final y se actualiza su metadata a `failed` con intentos/error sanitizado.

### Auditoria de pendientes

Para revisar pendientes sin modificarlos, existe un script read-only:

```bash
node scripts/auditPendingTransfers.js
```

Ese comando no toca WhatsApp, no borra, no copia, no mueve y no modifica `appProperties`. Solo consulta Drive con las credenciales locales y muestra un resumen seguro:

```text
[PENDING AUDIT] 0 queued, 0 processing, 1 failed, 0 uploaded, 0 other
[PENDING AUDIT] failed pending_1820_BT_abcd1234.jpg attempts=3 operationalDate=2026-05-06 group=BOT_TEST tag=BT error="..."
```

Si quedan pendientes sin procesar:

1. Confirmar que el bot llego a `Bot listo y escuchando`.
2. Confirmar que el horario actual cae dentro de `business-calendar.json`.
3. Confirmar `GOOGLE_DRIVE_PENDING_FOLDER_ID` si se usa una carpeta raiz explicita.
4. Revisar en consola los eventos `[PENDING PROCESSOR]`, `[PENDING OK]` y `[PENDING ERROR]`.
5. Si un archivo queda `failed`, dejarlo en pendientes para que el scheduler lo reintente hasta `PENDING_PROCESSOR_MAX_ATTEMPTS`.
6. Si agoto intentos, revisar el `lastError` sanitizado y permisos de Drive antes de tocar archivos manualmente.
7. No borrar pendientes manualmente salvo que haya backup/verificacion de que ya estan en `Entrantes`.

## Notificaciones operativas

El bot puede preparar y enviar avisos operativos seguros a un grupo administrador de WhatsApp una vez que ya llego a `ready`. Esta integracion no cambia el arranque de WhatsApp ni limita la cantidad de comprobantes recibidos.

Variables:

```env
WHATSAPP_ALERT_GROUP_NAME=
WHATSAPP_ALERT_GROUPS_JSON=[]
WHATSAPP_STATUS_GROUPS_JSON=[]
OPERATIONAL_NOTIFICATIONS_ENABLED=true
OPERATIONAL_NOTIFY_ON_READY=true
OPERATIONAL_NOTIFY_ON_OFF_HOURS=true
OPERATIONAL_NOTIFY_ON_SHUTDOWN=false
OPERATIONAL_STATUS_CHECK_INTERVAL_SECONDS=60
```

Para un unico grupo administrador (alertas y estado), usar:

```env
WHATSAPP_ALERT_GROUP_NAME=BOT ALERTAS
```

Para varios grupos administradores, usar:

```env
WHATSAPP_ALERT_GROUPS_JSON=["BOT ALERTAS","ADMIN TRANSFERENCIAS"]
```

Si `WHATSAPP_ALERT_GROUPS_JSON` existe y es un JSON valido, tiene prioridad. Si no existe o es invalido, el bot usa `WHATSAPP_ALERT_GROUP_NAME` como fallback. Se ignoran strings vacios y nombres duplicados. Si no queda ningun grupo configurado, el bot solo deja el aviso en consola y no envia WhatsApp.

Desde V0.5, se pueden separar los grupos que reciben mensajes operativos (ready, horarios) del grupo que recibe alertas de error:

```env
WHATSAPP_STATUS_GROUPS_JSON=["BOT OPERACIONES","BOT TEST"]
WHATSAPP_ALERT_GROUPS_JSON=["BOT ALERTAS"]
```

Si `WHATSAPP_STATUS_GROUPS_JSON` no se define, el bot usa `WHATSAPP_ALERT_GROUPS_JSON` como fallback. Los mensajes de estado operativo (`✅ listo`, `🌙 fuera de horario`, `🌞 inicio de horario`) se envian a status groups. Las alertas de error (warnings, críticas) se envian a alert groups.

Si un grupo configurado no existe o falla el envio a un destino, el bot registra un warning seguro y continua con los demas grupos. Un problema de notificacion no debe tumbar el proceso.

Mensajes previstos:

- Ready dentro de horario: `✅ Bot preparado para trabajar. Horario operativo activo. Los comprobantes se procesarán en Entrantes.`
- Ready fuera de horario: `🌙 Bot activo fuera de horario. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.`
- Fin de horario operativo: `🌙 Fin del horario operativo. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.`
- Apagado local ordenado, solo si `OPERATIONAL_NOTIFY_ON_SHUTDOWN=true`: `⚠️ Bot detenido manualmente. Si se reciben comprobantes mientras está apagado, no podrán ser capturados hasta que vuelva a iniciar.`

El aviso de apagado por `Ctrl + C`, `SIGINT` o `SIGTERM` es best-effort: el bot intenta enviarlo durante unos segundos y luego deja cerrar el proceso. En un corte abrupto, crash, cierre forzado del host o caida de red, no hay garantia de envio. Por defecto esta desactivado con `OPERATIONAL_NOTIFY_ON_SHUTDOWN=false`.

No hay anti-spam ni rate limit sobre comprobantes de clientes. El bot no debe ignorar, limitar ni suprimir media por cantidad. La unica deduplicacion permitida en esta fase es evitar repetir el mismo mensaje de estado operativo, por ejemplo el aviso de fuera de horario, dentro de la misma ventana de estado.

Los avisos no deben incluir telefonos completos, LID completos, links completos de Drive, tokens, IDs crudos ni payloads de chat. Los errores de notificacion se capturan y no deben tumbar el bot ni bloquear `ready`.

### Alertas criticas

Ademas de los avisos de estado, el bot envia alertas operativas para eventos que requieren revision:

- fallo subiendo un comprobante a `Entrantes`;
- fallo encolando un comprobante fuera de horario;
- pendiente con metadata invalida;
- pendiente fallido reintentable;
- pendiente que agoto intentos;
- error general del processor de pendientes;
- pendiente copiado pero no borrado de temporales;
- fallo escribiendo `processed-messages.json`;
- `business-calendar.json` faltante/invalido y uso de defaults;
- `blocked-senders.json` invalido;
- carpeta de pendientes sin ID explicito y uso de fallback por nombre;
- `auth_failure`, `disconnected`, timeout de `ready` o error inicializando WhatsApp.

No se alerta cada archivo OK, cada duplicado ignorado, cada remitente bloqueado, cada corrida del processor sin pendientes ni cada comprobante recibido. Estas alertas no limitan ni filtran comprobantes por cantidad.

Para bloquear procesamiento sin cambiar codigo:

```env
BOT_PROCESSING_ENABLED=false
```

Para impedir conexion real a WhatsApp:

```env
ALLOW_REAL_WHATSAPP_CONNECTION=false
```

Para impedir subidas reales a Drive:

```env
ALLOW_REAL_DRIVE_UPLOADS=false
```

Los valores por defecto conservan el comportamiento actual.

## Blacklist de remitentes

El bot puede ignorar media enviada por numeros/remitentes bloqueados mediante un archivo local en la raiz:

```text
blocked-senders.json
```

Ese archivo esta ignorado por Git. Para crear uno nuevo, usar como referencia `blocked-senders.example.json`:

```json
{
  "blockedNumbers": [
    "LID_NORMALIZADO_SIN_ARROBA (effectiveNormalized)"
  ]
}
```

Los numeros se normalizan antes de comparar, por lo que se aceptan formatos como `+549...`, `549...`, `549...@c.us`, valores con espacios, guiones o parentesis, y sufijos de dispositivo de WhatsApp. En grupos se usa `message.author` y, si falta, `message.from`.

WhatsApp tambien puede entregar algunos remitentes como identificadores `@lid` en lugar de un numero telefonico tradicional. En esos casos, el valor que debe agregarse a `blocked-senders.json` es el `effectiveNormalized` que muestra el diagnostico local, sin `@lid` ni otros sufijos.

Para que grupos específicos ignoren la blacklist (por ejemplo, cuando un remitente bloqueado globalmente debe poder enviar comprobantes en un grupo particular):

```env
BLACKLIST_EXEMPT_GROUPS_JSON=["Nombre Exacto del Grupo"]
```

Si la variable no se define o está vacía, la blacklist aplica a todos los grupos sin excepción.

Si un remitente bloqueado envia media en un grupo configurado, el bot corta antes de `downloadMedia()`: no descarga, no sube a Drive y no marca el mensaje como procesado. Para aplicar cambios en `blocked-senders.json`, reiniciar el bot. Los logs de bloqueo no deben incluir telefonos completos.

Para diagnosticar localmente que numero completo entrega WhatsApp al bot, se puede iniciar una sesion de PowerShell con:

```powershell
$env:BLACKLIST_DEBUG_FULL_SENDER="true"
npm start
```

Con ese flag activo, enviar una imagen/PDF desde el remitente a bloquear y buscar una linea como:

```text
[blacklist-debug-local] ... effectiveNormalized=...
```

Copiar el valor de `effectiveNormalized` al archivo local `blocked-senders.json`. Si WhatsApp entrega un remitente `@lid`, ese valor puede verse como un identificador numerico normalizado en vez de un telefono. No incluir `@lid` en el archivo local.

Al terminar, detener el bot y limpiar la variable:

```powershell
Remove-Item Env:\BLACKLIST_DEBUG_FULL_SENDER -ErrorAction SilentlyContinue
npm start
```

Este modo puede mostrar numeros o identificadores completos en consola. Usarlo solo en entorno local, no copiar esa salida en reportes publicos, y no commitear valores reales. Este modo no cambia filenames, no escribe en logs persistentes y no sube esos datos a Drive.

## Logs

El bot mantiene compatibilidad con:

- `uploads.log`
- `errors.log`

Los logs historicos no se migran ni se borran automaticamente. Desde la Fase 2, los nuevos registros aplican masking y sanitizacion basica:

- Los telefonos/remitentes no se guardan completos.
- Los nombres de archivo no incluyen telefonos, LID ni remitentes.
- Los links completos de Drive no se guardan por defecto.
- La ruta logica de Drive puede registrarse como `GrupoSanitizado/MM-YYYY/DD`.
- Los errores se recortan y se filtran para evitar tokens, URLs largas y datos sensibles obvios.

Flags relacionados:

```env
LOG_MASK_PHONE_NUMBERS=true
LOG_STORE_DRIVE_LINKS=false
LOG_MAX_FIELD_LENGTH=120
```

`LOG_STORE_DRIVE_LINKS=true` permite guardar/imprimir el link completo de Drive y debe usarse solo en entornos controlados. Aun con masking, `uploads.log` y `errors.log` deben tratarse como sensibles. No compartirlos ni subirlos a repositorios.

## Timestamps de auditoria

El bot conserva timestamps tecnicos en UTC con formato ISO y `Z` cuando necesita calcular o comparar tiempos. Para auditoria humana tambien genera una hora local explicita controlada por:

```env
BOT_TIME_ZONE=America/Argentina/Buenos_Aires
```

Por defecto se usa `America/Argentina/Buenos_Aires`, independientemente del timezone del sistema operativo.

Las entradas nuevas de `processed-messages.json` guardan:

```json
{
  "processedAt": "2026-05-05T15:24:42.696Z",
  "processedAtLocal": "2026-05-05 12:24:42",
  "timeZone": "America/Argentina/Buenos_Aires",
  "status": "uploaded"
}
```

Las entradas historicas pueden no tener `processedAtLocal` ni `timeZone`; no se migran automaticamente. El TTL de idempotencia sigue usando `processedAt` en UTC.

## Idempotencia local

Desde la Fase 3, el bot guarda un registro local de mensajes procesados para evitar subir duplicados si WhatsApp reentrega el mismo mensaje o si el proceso recibe el evento mas de una vez.

Por defecto usa:

```env
PROCESSED_STORE_PATH=processed-messages.json
PROCESSED_STORE_TTL_HOURS=720
PROCESSED_STORE_MAX_ITEMS=5000
```

El store se guarda en filesystem local y esta ignorado por Git. No guarda telefonos, links de Drive ni payloads completos. La clave persistida es un hash SHA-256 construido a partir de identificadores internos del chat y del mensaje.

El bot marca un mensaje como procesado solo despues de una subida exitosa a Drive. Si falla la subida, el mensaje no se marca como procesado y puede reintentarse.

Limitaciones:

- Si se borra `processed-messages.json`, un mensaje reentregado podria procesarse otra vez.
- Si en el futuro corren multiples instancias del bot, este store local no alcanza; habria que disenar una idempotencia compartida.
- El store se limpia por TTL y por cantidad maxima de entradas.
- Las entradas historicas pueden tener solo timestamp UTC; las nuevas agregan hora local de auditoria.

## Validaciones seguras

Comandos permitidos para validar sintaxis sin conectar servicios:

```bash
node --check index.js
node --check auth.js
node --check src/index.js
node --check src/auth/googleOAuth.js
```

No ejecutar `npm start` ni `npm run auth` salvo instruccion explicita.

`npm run setup:chrome` es una preparacion de entorno y no inicia el bot. Ejecutarlo solo cuando se necesite instalar el navegador de Puppeteer.

## Recuperacion basica

- Si falta `credentials.json`, descargar nuevamente el OAuth Client ID o revisar `GOOGLE_CREDENTIALS_PATH`.
- Si falta `token.json`, ejecutar `npm run auth` manualmente.
- Si se pierde `.wwebjs_auth/`, probablemente haya que escanear QR otra vez.
- Si falla Drive, revisar permisos de la cuenta autorizada y `GOOGLE_DRIVE_FOLDER_ID`.
- Si no aparecen subcarpetas esperadas en Drive, confirmar que la cuenta OAuth tenga permisos sobre la carpeta raiz `Entrantes` y que el scope permita buscar/crear carpetas.
- Si no procesa mensajes, revisar nombre exacto del grupo y tag en config/env.
- Si reaparecen duplicados, revisar que `processed-messages.json` exista, sea escribible y no haya sido borrado.
- Si Puppeteer informa `Could not find Chrome`, ejecutar `npm run setup:chrome` o configurar `PUPPETEER_EXECUTABLE_PATH`.
- Si queda en `Autenticado` y no llega a `Bot listo y escuchando`, observar los eventos `WhatsApp loading`, `WhatsApp state changed` y la advertencia de `WHATSAPP_READY_TIMEOUT_SECONDS`. No borrar `.wwebjs_auth/` ni `.wwebjs_cache/` como primera medida.
- Si aparece error `SingletonLock` en logs, significa que Puppeteer o Chromium está siendo usado simultáneamente por múltiples procesos. Esto ocurre si se ejecutan dos o más instancias del bot al mismo tiempo. Solución: asegurarse de que solo hay una instancia del bot corriendo. Si se necesita múltiples instancias, requerirá arquitectura de cluster o múltiples máquinas con sesiones WhatsApp/cache separadas.

## Cómo agregar un nuevo grupo productivo al bot

Para agregar un nuevo grupo de WhatsApp al bot:

### Paso 1: Agregar el bot al grupo en WhatsApp

1. Abre el grupo en WhatsApp.
2. Toca en el nombre/tema del grupo → Información del grupo.
3. Desplázate a "Miembros" y busca agregar a "Rubén Botta LA RESURRECCIÓN" (identidad del bot).
4. Confirma que aparece un mensaje de sistema: "Rubén Botta se unió al grupo".

### Paso 2: Editar config.json (archivo local en /data/)

Conecta via SSH a Railway o edita localmente `/data/config.json`:

```json
{
  "driveFolderId": "...",
  "groups": {
    "Nombre Exacto del Grupo": "TAG",
    "Transfer BBZ CLARO PAY": "BBZCL"
  }
}
```

- La clave (`"Transfer BBZ CLARO PAY"`) debe coincidir EXACTAMENTE con el nombre del grupo en WhatsApp.
- El valor (`"BBZCL"`) es el TAG sin espacios, recomendable [A-Z0-9]+.

### Paso 3: Editar WHATSAPP_STATUS_GROUPS_JSON (solo DESPUÉS de confirmar membresía)

**IMPORTANTE:** Esta variable SOLO se actualiza después de confirmar que el bot esta fisicamente en el grupo.

En Railway, edita la variable de entorno:

```json
WHATSAPP_STATUS_GROUPS_JSON=["BOT TEST","PRUEBA TEST"]
```

**¿Por qué el orden de los pasos 2 y 3 importa?** El bot intenta resolver los nombres de grupos en esta variable durante su inicializacion. Si un grupo no existe fisicamente (bot no es miembro), la resolucion puede bloquear el `ready`. Por eso: primero agregar bot al grupo en WhatsApp, LUEGO agregar el nombre a la variable de env.

### Paso 4: Restart limpio

En Railway:

1. Pausa el bot: Custom Start Command = `tail -f /dev/null`
2. SSH: `find /data/.wwebjs_auth/ -name "Singleton*" -delete` (limpia locks huérfanos)
3. Despausar: Custom Start Command vacío

### Paso 5: Smoke test

1. Envía una imagen o PDF al grupo nuevo.
2. Revisa los logs de Railway: `[OK] Transfer BBZ CLARO PAY -> //3_DDMM_HHmm_BBZCL.jpg`
3. Verifica en Drive que el archivo aparezca en `PULL TRANSFERENCIAS/` con el tag correcto.

Si el bot sigue sin llegar a `ready` después de 120 segundos, verifica:
- El nombre exacto del grupo en WhatsApp vs. el configurado.
- Que el bot sea efectivamente miembro del grupo (mensaje de sistema visible).
- Los logs de Railway para errores de resolucion de grupo.

## Deploy y operacion

El deploy actual debe hacerse como single-instance. No usar cluster, multiples workers ni dos servicios apuntando al mismo directorio/sesion.

El runbook formal esta en:

```text
DEPLOYMENT.md
```

Ese documento cubre persistencia, supervisor, deploy Railway con volumen `/data`, backups manuales externos, restore, checklist pre-deploy, checklist post-deploy, checklist de recuperacion y la investigacion futura sobre numeros de WhatsApp de reserva.

## Limitaciones

- `whatsapp-web.js` depende de WhatsApp Web y puede romperse ante cambios externos de Meta sin aviso.
- **Incompatibilidad 1.34.7 con WhatsApp Web 2.3000.x (incidente 04-05/06/2026):** la versión estable 1.34.7 del paquete dejó de funcionar cuando Meta actualizó WhatsApp Web. Síntoma: la autenticación completaba pero `ready` nunca se disparaba (`whatsapp_ready_timeout` a los 90s). El bot quedaba "autenticado pero sordo". Resolución activa: `patches/Client.js` sobrescribe `Client.js` del paquete en el build Docker con una versión parcheada (retry del setup post-auth, flag de idempotencia del attach). Ver NEKO_LOG.md 04-05/06/2026.
- Si reaparece el síntoma `autenticado pero sin ready` sin cambios de código propios, sospechar de un nuevo update de Meta y revisar si el patch sigue siendo compatible.
- No es una integracion oficial WhatsApp Business Cloud API.
- La idempotencia actual es local y no reemplaza una base compartida para multiples instancias.
- El masking de logs es basico y debe revisarse si se agregan nuevos proveedores o payloads.
- No hay deploy/staging formal en esta fase.

## Deploy cycle para builds parcheados

Aplica siempre que se modifique `patches/Client.js` o se realice cualquier cambio que requiera build limpio en Railway:

1. **Pausar** el bot: Custom Start Command = `tail -f /dev/null` → Railway redeploya con el container en pausa (online sin ejecutar el bot)
2. `commit + push` del cambio (el build corre mientras el bot está pausado)
3. **SSH al container**: `find /data/.wwebjs_auth/ -name "Singleton*" -delete` (limpia locks huérfanos)
4. **Despausar**: Custom Start Command vacío → Railway redeploya y ejecuta `node index.js`
5. Observar logs y hacer smoke test (enviar imagen/PDF a BOT TEST)

**Importante:** nunca ejecutar el cleanup de Singleton mientras el bot está corriendo; puede corromper la sesión de Chromium. No encolar dos deploys consecutivos sin esperar que el anterior finalice.

## Prueba manual futura

Solo con aprobacion:

1. Confirmar backup de `.wwebjs_auth/`, `token.json` y `credentials.json`.
2. Confirmar que el grupo es de prueba.
3. Ejecutar `npm start`.
4. Enviar una imagen y un PDF al grupo de prueba.
5. Confirmar subida a Drive dentro de `PULL TRANSFERENCIAS/` (buscar archivos con TAG correspondiente).
6. Revisar logs sin compartir datos sensibles.
