// Clasificacion de errores de Drive para el retry: distinguir transitorio (reintentar)
// de permanente (propagar -> el handler reencola a pending). Sin deps externas para que
// sea testeable offline.

// R5: "premature" cubre ERR_STREAM_PREMATURE_CLOSE / "Premature close" (bug gzip Node 22).
// Si un premature se escapa del patch HTTPS, es transitorio -> reintentar, no fallar permanente.
const RETRYABLE_NET_RE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNREFUSED|socket hang up|network|timeout|premature/i;

function httpStatusOf(err) {
  if (!err) return undefined;
  if (typeof err.code === 'number') return err.code;
  if (err.response && Number.isFinite(err.response.status)) return err.response.status;
  if (Number.isFinite(err.status)) return err.status;
  return undefined;
}

function isRetryableDriveError(err) {
  const status = httpStatusOf(err);
  if (status !== undefined) {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  const token = String((err && (err.code || err.message)) || '');
  return RETRYABLE_NET_RE.test(token);
}

// Espera antes del proximo intento: respeta Retry-After (segundos) si Drive lo manda;
// si no, backoff exponencial con jitter. Cap a 60s.
function retryWaitMs(err, attempt) {
  const headers = err && err.response && err.response.headers;
  const ra = headers && (headers['retry-after'] || headers['Retry-After']);
  const raSec = ra !== undefined ? Number(ra) : NaN;
  if (Number.isFinite(raSec) && raSec >= 0) return Math.min(raSec * 1000, 60000);
  const base = 1000 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(base * 0.2 * Math.random());
  return Math.min(base + jitter, 60000);
}

module.exports = { httpStatusOf, isRetryableDriveError, retryWaitMs, RETRYABLE_NET_RE };
