const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const { loadConfig } = require('../config/env');

function runGoogleOAuth() {
  const config = loadConfig();

  if (!fs.existsSync(config.paths.credentials)) {
    console.error('Falta credentials.json. Tiene que ser un OAuth Client ID tipo Desktop app.');
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(config.paths.credentials, 'utf8'));
  const block = creds.installed || creds.web;
  if (!block || !block.client_id) {
    console.error('credentials.json no parece ser un OAuth Client ID.');
    console.error('Si pusiste el JSON de Service Account por error, descarga uno nuevo del tipo "OAuth client ID -> Desktop app".');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    block.client_id,
    block.client_secret,
    config.google.oauthRedirectUri
  );
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [config.google.oauthScope],
  });

  const server = http.createServer(async (req, res) => {
    console.log(`[req] ${req.method} ${req.url}`);
    const reqUrl = new URL(req.url, config.google.oauthRedirectUri);
    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error de autorizacion: ' + error + '</h2>');
      console.error('[auth] Error de Google:', error);
      return;
    }

    if (!code) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Esperando codigo de autorizacion...');
      return;
    }

    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        console.warn('[auth] Atencion: Google no devolvio refresh_token.');
        console.warn('[auth] Revoca el acceso en https://myaccount.google.com/permissions y volve a correr.');
      }
      fs.writeFileSync(config.paths.token, JSON.stringify(tokens, null, 2));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Listo!</h2><p>Token guardado. Cerra esta pestana y volve a la terminal.</p>');
      console.log('[auth] Token guardado en', config.paths.token);
      console.log('[auth] Ya podes correr:  node index.js');
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 500);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error: ' + err.message + '</h2>');
      console.error('[auth] Error obteniendo token:', err.message);
      if (err.response && err.response.data) {
        console.error('[auth] Detalle:', JSON.stringify(err.response.data));
      }
      console.log('[auth] El servidor sigue escuchando. Volve a abrir la URL para reintentar.');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[auth] El puerto ${config.google.oauthRedirectPort} ya esta en uso. Cerra cualquier otra instancia de auth.js o reinicia la terminal.`);
    } else {
      console.error('[auth] Error del servidor:', err.message);
    }
    process.exit(1);
  });

  server.listen(config.google.oauthRedirectPort, () => {
    console.log(`\n=== Autorizacion de Google Drive ===\n`);
    console.log(`Server escuchando en ${config.google.oauthRedirectUri}\n`);
    console.log('1. Abri esta URL en tu navegador:\n');
    console.log(authUrl);
    console.log('\n2. Inicia sesion con tu Gmail y autoriza la app.');
    console.log('3. El navegador te va a redirigir a localhost y vas a ver "Listo!".');
    console.log('\nNO CIERRES ESTA TERMINAL hasta que veas "[auth] Token guardado".\n');
    console.log('Esperando autorizacion...\n');
  });
}

module.exports = {
  runGoogleOAuth,
};
