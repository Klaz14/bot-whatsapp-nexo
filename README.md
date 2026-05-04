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
    auth/googleOAuth.js
    config/env.js
    config/paths.js
    handlers/messageHandler.js
    services/driveService.js
    services/logService.js
    services/whatsappClient.js
    utils/fileNames.js
    utils/mime.js
  config.json
  config.example.json
  .env.example
  AGENTS.md
  package.json
  package-lock.json
```

Archivos locales sensibles como `credentials.json`, `token.json`, `.wwebjs_auth/`, `.wwebjs_cache/`, `uploads.log`, `errors.log` y `.env` estan ignorados por Git.

## Instalacion

```bash
npm install
```

La primera instalacion puede tardar porque `whatsapp-web.js` usa Puppeteer/Chromium.

## Configuracion

Copiar `.env.example` a `.env` y completar solo los valores necesarios. No subir `.env` ni credenciales.

Variables principales:

```env
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_CREDENTIALS_PATH=credentials.json
GOOGLE_TOKEN_PATH=token.json
WHATSAPP_AUTH_DATA_PATH=.wwebjs_auth
WHATSAPP_GROUPS_CONFIG_PATH=config.json
LOG_UPLOADS_PATH=uploads.log
LOG_ERRORS_PATH=errors.log
BOT_PROCESSING_ENABLED=true
ALLOW_REAL_WHATSAPP_CONNECTION=true
ALLOW_REAL_DRIVE_UPLOADS=true
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

## Login WhatsApp

El bot usa WhatsApp Web. La primera vez que se ejecuta muestra un QR en terminal. Escanearlo desde el telefono de la eSIM del bot:

```bash
npm start
```

La sesion queda guardada en `.wwebjs_auth/`. No borrar ni mover esa carpeta sin backup, porque podria requerir escanear QR nuevamente.

## Ejecucion local

```bash
npm start
```

Cuando el bot esta listo, escucha mensajes de grupos configurados. Si el mensaje trae imagen o PDF, lo descarga y lo sube a Drive. Otros tipos de archivo se ignoran.

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

## Logs

La fase actual mantiene compatibilidad con:

- `uploads.log`
- `errors.log`

Estos logs pueden contener nombres de grupos, telefonos en nombres de archivo y links de Drive. Tratarlos como sensibles. No compartirlos ni subirlos a repositorios. En fases posteriores se planifica masking, sanitizacion e idempotencia.

## Validaciones seguras

Comandos permitidos para validar sintaxis sin conectar servicios:

```bash
node --check index.js
node --check auth.js
node --check src/index.js
node --check src/auth/googleOAuth.js
```

No ejecutar `npm start` ni `npm run auth` salvo instruccion explicita.

## Recuperacion basica

- Si falta `credentials.json`, descargar nuevamente el OAuth Client ID o revisar `GOOGLE_CREDENTIALS_PATH`.
- Si falta `token.json`, ejecutar `npm run auth` manualmente.
- Si se pierde `.wwebjs_auth/`, probablemente haya que escanear QR otra vez.
- Si falla Drive, revisar permisos de la cuenta autorizada y `GOOGLE_DRIVE_FOLDER_ID`.
- Si no procesa mensajes, revisar nombre exacto del grupo y tag en config/env.

## Limitaciones

- `whatsapp-web.js` depende de WhatsApp Web y puede romperse ante cambios externos.
- No es una integracion oficial WhatsApp Business Cloud API.
- No hay idempotencia implementada todavia.
- Los logs seguros profundos quedan para una fase posterior.
- No hay deploy/staging formal en esta fase.

## Prueba manual futura

Solo con aprobacion:

1. Confirmar backup de `.wwebjs_auth/`, `token.json` y `credentials.json`.
2. Confirmar que el grupo es de prueba.
3. Ejecutar `npm start`.
4. Enviar una imagen y un PDF al grupo de prueba.
5. Confirmar subida a Drive.
6. Revisar logs sin compartir datos sensibles.
