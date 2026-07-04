// R4: patch HTTPS compartido (antes duplicado en src/index.js y scripts/recoverWindow.js).
//
// node-fetch/Gunzip emite "Premature close" (ERR_STREAM_PREMATURE_CLOSE) en Node.js 22 al
// descomprimir respuestas gzip de oauth2.googleapis.com/token y de las subidas a Drive.
// Parcheamos https.request a nivel global para forzar Accept-Encoding: identity en TODOS
// los requests salientes, sin importar qué librería los haga (gaxios top-level,
// google-auth-library con su propio gaxios anidado, etc). Confirmado: https nativo con
// identity → HTTP 200 OK.
//
// ⚠️ Acople a la versión de googleapis (ver CLAUDE.md §11 / SPEC_ROBUSTEZ R2/R3): esto
// funciona porque googleapis@144 usa internamente gaxios → node-fetch → https.request.
// Un bump de googleapis/gaxios que mueva el transporte a fetch nativo (undici) NO pasa por
// https.request y el patch dejaría de interceptar en silencio. Antes de actualizar
// googleapis, revalidar que este patch sigue haciendo efecto (o migrar a fetch nativo, R3).

const https = require('https');

let applied = false;

// Fuerza Accept-Encoding: identity en un objeto de headers (case-insensitive). Exportada
// aparte para poder testear la lógica sin tocar el módulo https global del proceso.
function forceIdentityEncoding(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'accept-encoding');
  if (key) headers[key] = 'identity';
  else headers['Accept-Encoding'] = 'identity';
  return headers;
}

// Parchea https.request globalmente. Idempotente: solo la primera llamada tiene efecto
// (devuelve true); las siguientes son no-op (devuelven false). Debe invocarse como primera
// instrucción de cada entry point, antes de requerir módulos que capturen https.request.
function applyHttpsIdentityPatch() {
  if (applied) return false;
  applied = true;
  const orig = https.request;
  https.request = function () {
    for (const arg of arguments) {
      if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && arg.headers) {
        forceIdentityEncoding(arg.headers);
        break;
      }
    }
    return orig.apply(this, arguments);
  };
  console.log('[HTTPS-PATCH] Accept-Encoding=identity forzado globalmente (fix node-fetch/gzip/Node22)');
  return true;
}

module.exports = { applyHttpsIdentityPatch, forceIdentityEncoding };
