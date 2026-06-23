// MOD-05: informe semanal de errores via Claude API. Los viernes a WEEKLY_REPORT_HOUR
// (TZ del bot) recopila errors.log de los ultimos N dias, sanitiza, los manda a Claude
// para diagnostico, y postea el resultado al grupo de administracion. Sin SDK: usa fetch
// nativo (Node 22). Estado en disco para no duplicar ante reinicios.

const fs = require('fs');
const { maskSensitiveText } = require('../utils/mask');
const { parseErrors, clusterErrors } = require('../utils/logParser');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function nowPartsInTz(timeZone) {
  // weekday corto (Fri) + hora 0-23 en la TZ dada.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const weekday = (parts.find((p) => p.type === 'weekday') || {}).value || '';
  const hourStr = (parts.find((p) => p.type === 'hour') || {}).value || '0';
  let hour = parseInt(hourStr, 10);
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

function todayKeyInTz(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // YYYY-MM-DD
}

async function callClaude(apiKey, model, prompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

function buildPrompt(clusters) {
  const lines = clusters.slice(0, 25).map((c) =>
    `- ${c.count} ocurrencia(s): "${maskSensitiveText(c.lastMessage, 160)}"`);
  return [
    'Sos un asistente tecnico analizando logs de errores de un bot de WhatsApp que sube',
    'comprobantes de transferencia a Google Drive. Errores de la semana (sanitizados):',
    '',
    ...lines,
    '',
    'Por cada tipo de error: (1) diagnostico probable, (2) propuesta de fix o mitigacion,',
    '(3) prioridad sugerida (alta/media/baja). Respuesta en espanol, formato estructurado,',
    'conciso, sin codigo.',
  ].join('\n');
}

function createWeeklyReportService({ config, client, getReady }) {
  let timer;

  function readState() {
    try {
      if (fs.existsSync(config.weeklyReport.statePath)) {
        return JSON.parse(fs.readFileSync(config.weeklyReport.statePath, 'utf8')) || {};
      }
    } catch (_) { /* ignore */ }
    return {};
  }

  function writeState(state) {
    try {
      const tmp = `${config.weeklyReport.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, config.weeklyReport.statePath);
    } catch (err) {
      console.warn('[WEEKLY] no se pudo persistir estado:', err && err.message);
    }
  }

  async function resolveAdminChat() {
    const name = config.whatsapp.controlGroupName
      || (config.operationalNotifications.alertGroupNames || [])[0];
    if (!name) return null;
    const chats = await client.getChats();
    return chats.find((c) => c.isGroup && c.name === name) || null;
  }

  async function sendToAdmin(text) {
    const chat = await resolveAdminChat();
    if (!chat) { console.warn('[WEEKLY] sin grupo admin para enviar el informe.'); return; }
    await chat.sendMessage(text);
  }

  async function runReport() {
    const lookbackMs = config.weeklyReport.lookbackDays * 24 * 60 * 60 * 1000;
    const sinceMs = Date.now() - lookbackMs;
    let content = '';
    try { content = fs.readFileSync(config.paths.errorsLog, 'utf8'); } catch (_) { content = ''; }
    const clusters = clusterErrors(parseErrors(content, sinceMs));

    if (!clusters.length) {
      await sendToAdmin('✅ Informe semanal: sin errores registrados esta semana.');
      return;
    }

    const resumen = clusters.slice(0, 25)
      .map((c) => `• ${c.count}×  ${maskSensitiveText(c.lastMessage, 140)}`)
      .join('\n');

    let analysis = '';
    if (config.weeklyReport.apiKey) {
      try {
        analysis = await callClaude(config.weeklyReport.apiKey, config.weeklyReport.model, buildPrompt(clusters));
      } catch (err) {
        console.error('[WEEKLY] Claude no respondio:', maskSensitiveText(err && err.message));
        analysis = '(análisis de Claude no disponible — API no respondió)';
      }
    } else {
      analysis = '(sin ANTHROPIC_API_KEY: informe sin análisis de IA)';
    }

    const report = [
      `📋 Informe semanal de errores (${config.weeklyReport.lookbackDays} días)`,
      `Tipos distintos: ${clusters.length} · Total: ${clusters.reduce((a, c) => a + c.count, 0)}`,
      '',
      'Top errores:',
      resumen,
      '',
      '🧠 Análisis:',
      analysis,
    ].join('\n');

    await sendToAdmin(report);
  }

  async function tick() {
    try {
      if (typeof getReady === 'function' && !getReady()) return;
      const { weekday, hour } = nowPartsInTz(config.timeZone);
      if (weekday !== 'Fri') return;
      if (hour !== config.weeklyReport.hour) return;
      const today = todayKeyInTz(config.timeZone);
      const state = readState();
      if (state.lastReportDate === today) return; // ya se envio hoy
      writeState({ lastReportDate: today });
      console.log('[WEEKLY] generando informe semanal...');
      await runReport();
    } catch (err) {
      console.error('[WEEKLY] error en tick:', maskSensitiveText(err && err.message));
    }
  }

  function start() {
    if (timer) return;
    // Chequeo cada hora si es viernes a la hora configurada (state evita duplicados).
    timer = setInterval(() => { tick(); }, 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    console.log(`[WEEKLY] scheduler activo (viernes ${config.weeklyReport.hour}:00 ${config.timeZone}).`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = undefined; }
  }

  return { start, stop, runReport };
}

module.exports = { createWeeklyReportService };
