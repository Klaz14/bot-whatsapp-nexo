// SMOKE TEST de arranque (LOCAL, sin tocar produccion). Bootea el bot en modo seguro:
// credenciales DUMMY en /tmp (no usa las reales), dry-run de Drive y SIN conectar a
// WhatsApp. Verifica que startBot() no tira y que /health responde. Self-cleanup + exit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const credPath = path.join(os.tmpdir(), 'kalaza-smoke-creds.json');
const tokPath = path.join(os.tmpdir(), 'kalaza-smoke-token.json');
fs.writeFileSync(credPath, JSON.stringify({ installed: { client_id: 'dummy', client_secret: 'dummy', redirect_uris: ['http://127.0.0.1'] } }));
fs.writeFileSync(tokPath, JSON.stringify({ access_token: 'dummy', refresh_token: 'dummy', token_type: 'Bearer', expiry_date: 9999999999999 }));

process.env.ENV_FILE = 'env';
process.env.GOOGLE_CREDENTIALS_PATH = credPath;
process.env.GOOGLE_TOKEN_PATH = tokPath;
process.env.ALLOW_REAL_WHATSAPP_CONNECTION = 'false';
process.env.BOT_DRY_RUN = 'true';
process.env.OPERATIONAL_NOTIFICATIONS_ENABLED = 'false';
process.env.HEALTH_PORT = process.env.HEALTH_PORT || '3999';

function cleanup() { try { fs.unlinkSync(credPath); fs.unlinkSync(tokPath); } catch (_) {} }

try {
  require('../src').startBot();
  console.log('BOOT OK — startBot() no lanzo excepcion');
} catch (e) {
  console.error('BOOT THREW:', e && e.message);
  cleanup();
  process.exit(1);
}

const port = process.env.PORT || process.env.HEALTH_PORT || 3000;
setTimeout(() => {
  http.get('http://127.0.0.1:' + port + '/health', (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => {
      console.log(`HEALTH status=${res.statusCode} body=${JSON.stringify(b)}`);
      cleanup();
      process.exit(res.statusCode === 200 ? 0 : 2);
    });
  }).on('error', (e) => { console.error('HEALTH ERR:', e.message); cleanup(); process.exit(3); });
}, 3500);
