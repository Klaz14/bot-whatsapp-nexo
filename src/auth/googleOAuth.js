const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const { loadConfig } = require('../config/env');
const { maskSensitiveText } = require('../utils/mask');

function generateOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidOAuthState(receivedState, expectedState) {
  if (!receivedState || !expectedState) return false;
  const received = Buffer.from(receivedState);
  const expected = Buffer.from(expectedState);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function readOAuthCredentials(credentialsPath) {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error('Falta credentials.json. Tiene que ser un OAuth Client ID tipo Desktop app.');
  }

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    throw new Error(`credentials.json no es JSON valido: ${maskSensitiveText(err.message)}`);
  }

  const block = creds.installed || creds.web;
  if (!block || !block.client_id || !block.client_secret) {
    throw new Error('credentials.json no parece ser un OAuth Client ID valido.');
  }

  return block;
}

function writeHtml(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function closeServer(server, exitCode = 0, delayMs = 500) {
  setTimeout(() => {
    server.close(() => process.exit(exitCode));
  }, delayMs);
}

function runGoogleOAuth() {
  const config = loadConfig();
  let oauthBlock;

  try {
    oauthBlock = readOAuthCredentials(config.paths.credentials);
  } catch (err) {
    console.error('[auth]', maskSensitiveText(err.message));
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    oauthBlock.client_id,
    oauthBlock.client_secret,
    config.google.oauthRedirectUri
  );
  const expectedState = generateOAuthState();
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [config.google.oauthScope],
    state: expectedState,
  });

  let completed = false;
  let server;
  const timeout = setTimeout(() => {
    if (completed) return;
    completed = true;
    console.error('[auth] Tiempo agotado esperando autorizacion de Google.');
    closeServer(server, 1, 0);
  }, config.google.oauthTimeoutSeconds * 1000);

  server = http.createServer(async (req, res) => {
    console.log(`[req] ${req.method} callback recibido`);
    const reqUrl = new URL(req.url, config.google.oauthRedirectUri);
    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');
    const state = reqUrl.searchParams.get('state');

    if (error) {
      completed = true;
      clearTimeout(timeout);
      writeHtml(res, 400, '<h2>Error de autorizacion de Google.</h2><p>Volver a la terminal.</p>');
      console.error('[auth] Google rechazo la autorizacion:', maskSensitiveText(error));
      closeServer(server, 1);
      return;
    }

    if (!code) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Esperando codigo de autorizacion...');
      return;
    }

    if (!isValidOAuthState(state, expectedState)) {
      completed = true;
      clearTimeout(timeout);
      writeHtml(res, 400, '<h2>Solicitud OAuth invalida.</h2><p>State invalido. No se guardo ningun token.</p>');
      console.error('[auth] Callback rechazado por state invalido. No se guardo token.');
      closeServer(server, 1);
      return;
    }

    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        console.warn('[auth] Atencion: Google no devolvio refresh_token.');
        console.warn('[auth] Revoca el acceso en https://myaccount.google.com/permissions y volve a correr.');
      }
      fs.writeFileSync(config.paths.token, JSON.stringify(tokens, null, 2));
      completed = true;
      clearTimeout(timeout);
      writeHtml(res, 200, '<h2>Listo!</h2><p>Token guardado. Cerra esta pestana y volve a la terminal.</p>');
      console.log('[auth] Token guardado en la ruta configurada.');
      console.log('[auth] Ya podes correr:  node index.js');
      closeServer(server, 0);
    } catch (err) {
      completed = true;
      clearTimeout(timeout);
      writeHtml(res, 500, '<h2>Error obteniendo token.</h2><p>Volver a la terminal.</p>');
      console.error('[auth] Error obteniendo token:', maskSensitiveText(err.message));
      closeServer(server, 1);
    }
  });

  server.on('error', (err) => {
    clearTimeout(timeout);
    if (err.code === 'EADDRINUSE') {
      console.error(`[auth] El puerto ${config.google.oauthRedirectPort} ya esta en uso en ${config.google.oauthRedirectHost}.`);
    } else {
      console.error('[auth] Error del servidor:', maskSensitiveText(err.message));
    }
    process.exit(1);
  });

  server.listen(config.google.oauthRedirectPort, config.google.oauthRedirectHost, () => {
    console.log(`\n=== Autorizacion de Google Drive ===\n`);
    console.log(`Servidor local escuchando en ${config.google.oauthRedirectUri}`);
    console.log(`Timeout: ${config.google.oauthTimeoutSeconds} segundos\n`);
    console.log('1. Abri esta URL en tu navegador. No la compartas:\n');
    console.log(authUrl);
    console.log('\n2. Inicia sesion con tu Gmail y autoriza la app.');
    console.log('3. El navegador va a redirigir al servidor local y vas a ver "Listo!".');
    console.log('\nNO CIERRES ESTA TERMINAL hasta que veas "[auth] Token guardado".\n');
    console.log('Esperando autorizacion...\n');
  });
}

module.exports = {
  generateOAuthState,
  isValidOAuthState,
  readOAuthCredentials,
  runGoogleOAuth,
};
