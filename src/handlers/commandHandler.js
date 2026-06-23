// MOD-04: comandos operativos en el grupo de control. Dispatcher central.
// Todos los comandos responden en el mismo grupo (chat.sendMessage). El ruteo lo
// engancha index.js: solo se llega aca si el mensaje viene del grupo de control y
// empieza con '/', ANTES de la logica de comprobantes (SPEC MOD-04 O4).

const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { maskSensitiveText } = require('../utils/mask');
const { getPhoneSuffix, loadBlockedSenders } = require('../services/blockedSenders');
const { isWithinBusinessHours, loadBusinessCalendar } = require('../utils/businessCalendar');
const { findSequenceGaps } = require('../utils/sequence');

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtAgo(iso) {
  if (!iso) return 'sin registro';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return 'sin registro';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h}h ${min % 60}m`;
}

function createCommandHandler(deps) {
  const {
    config, client, driveService, pendingProcessor,
    groupsCache, blacklistCache, statsStore, startedAt, getReady,
    broadcastHandler,
  } = deps;

  async function reply(chat, text) {
    await chat.sendMessage(text);
  }

  async function maybeAsFile(chat, header, lines, filename) {
    if (lines.length > 20) {
      const body = `${header}\n\n${lines.join('\n')}`;
      const media = new MessageMedia('text/plain', Buffer.from(body, 'utf8').toString('base64'), filename);
      await chat.sendMessage(media, { caption: `${header} (${lines.length}) — adjunto` });
    } else {
      await reply(chat, `${header}\n\n${lines.join('\n')}`);
    }
  }

  async function cmdComandos(msg, chat) {
    await reply(chat, [
      '🤖 Comandos disponibles:',
      '',
      '📊 Consultas',
      '  /resumen     — comprobantes del día por cartera',
      '  /pendientes  — cola de comprobantes sin procesar',
      '  /status      — estado general del bot',
      '',
      '⚙️ Configuración',
      '  /recargar    — recargar grupos/blacklist desde Sheets',
      '  /grupos      — lista de grupos activos con TAG',
      '  /bloqueados  — números en blacklist',
      '',
      '🔧 Operaciones',
      '  /forzar      — procesar pendientes ahora',
      broadcastHandler ? '  /broadcast   — difusión masiva a grupos' : null,
      '',
      '🩺 Diagnóstico',
      '  /errores     — últimos errores del log',
      '  /auditoria   — recibidos vs subidos vs pendientes + huecos del día',
    ].filter((l) => l !== null).join('\n'));
  }

  async function cmdStatus(msg, chat) {
    let state = 'desconocido';
    try { state = await client.getState(); } catch (_) { state = 'sin respuesta'; }
    const cal = loadBusinessCalendar(config.paths.businessCalendar, {});
    const enHorario = isWithinBusinessHours(new Date(), cal);
    await reply(chat, [
      '🤖 Estado del bot',
      `Conexión: ${state === 'CONNECTED' ? '✅ CONNECTED' : '⚠️ ' + state}`,
      `Ready: ${getReady() ? 'sí' : 'no'}`,
      `Uptime: ${fmtUptime(Date.now() - startedAt)}`,
      `Última subida: ${fmtAgo(statsStore && statsStore.getLastActivity())}`,
      `Horario actual: ${enHorario ? 'dentro de jornada' : 'fuera de jornada'}`,
      'Cola de pendientes: usá /pendientes',
    ].join('\n'));
  }

  async function cmdResumen(msg, chat) {
    if (!statsStore) { await reply(chat, 'Métricas no disponibles.'); return; }
    const { date, entries } = statsStore.getDailyStats();
    if (!entries.length) { await reply(chat, 'Sin comprobantes registrados hoy.'); return; }
    const inH = entries.filter((e) => e.inBusinessHours).length;
    const outH = entries.length - inH;
    const byTag = {};
    for (const e of entries) {
      if (!byTag[e.tag]) byTag[e.tag] = { total: 0, out: 0 };
      byTag[e.tag].total += 1;
      if (!e.inBusinessHours) byTag[e.tag].out += 1;
    }
    const tagLines = Object.entries(byTag)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([tag, s]) => `  ${tag}  ${s.total}${s.out ? `  (${s.out} fuera de horario)` : ''}`);
    await reply(chat, [
      `📊 Resumen del día — ${date || '-'}`,
      '',
      `✅ En horario: ${inH}`,
      `🌙 Fuera de horario: ${outH}`,
      `Total: ${entries.length}`,
      '',
      'Por cartera:',
      ...tagLines,
    ].join('\n'));
  }

  async function cmdPendientes(msg, chat) {
    const { files } = await driveService.listAllPendingFiles();
    const count = (files || []).length;
    await reply(chat, count === 0 ? '✅ Sin pendientes en cola.' : `📥 Pendientes en cola: ${count} comprobante(s).`);
  }

  async function cmdRecargar(msg, chat) {
    if (!groupsCache && !blacklistCache) {
      await reply(chat, 'Sheets no está activo (falta GOOGLE_SHEETS_ID). El bot usa config.json / blocked-senders.json.');
      return;
    }
    const parts = [];
    if (groupsCache) {
      try { const r = await groupsCache.reload(); parts.push(`${r.matched} grupos`); }
      catch (e) { parts.push(`grupos: error (${maskSensitiveText(e && e.message)})`); }
    }
    if (blacklistCache) {
      try { const r = await blacklistCache.reload(); parts.push(`${r.blocked} bloqueados, ${r.exempt} exentos`); }
      catch (e) { parts.push(`blacklist: error (${maskSensitiveText(e && e.message)})`); }
    }
    await reply(chat, `🔄 Recarga desde Sheets: ${parts.join(' · ')}.`);
  }

  async function cmdGrupos(msg, chat) {
    const map = groupsCache ? groupsCache.getAll() : null;
    const pairs = map
      ? Object.entries(map).map(([name, v]) => [v.tag, name])
      : Object.entries(config.whatsapp.groups || {}).map(([name, tag]) => [tag, name]);
    if (!pairs.length) { await reply(chat, 'No hay grupos configurados.'); return; }
    const lines = pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([tag, name]) => `${tag}  →  ${name}`);
    await maybeAsFile(chat, `📋 Grupos activos: ${lines.length}`, lines, 'grupos.txt');
  }

  async function cmdBloqueados(msg, chat) {
    let numbers = [];
    if (blacklistCache) numbers = blacklistCache.getNumbers();
    else numbers = loadBlockedSenders(config.paths.blockedSenders, {});
    if (!numbers.length) { await reply(chat, '✅ Sin números bloqueados.'); return; }
    const lines = numbers.map((n) => `••••${getPhoneSuffix(n)}`);
    await maybeAsFile(chat, `🚫 Blacklist activa: ${lines.length}`, lines, 'bloqueados.txt');
  }

  async function cmdForzar(msg, chat) {
    await reply(chat, '⚡ Procesando pendientes...');
    const r = await pendingProcessor.runOnce({ force: true });
    if (r && r.skipped && r.reason === 'already-running') {
      await reply(chat, '⚠️ Ya hay un procesamiento en curso. Esperá que termine.');
    } else if (r && r.error) {
      await reply(chat, `❌ Error procesando pendientes: ${maskSensitiveText(r.error.message)}`);
    } else {
      const processed = (r && r.processed) || 0;
      const failed = (r && r.failed) || 0;
      await reply(chat, processed === 0 && failed === 0
        ? '✅ Sin pendientes para procesar.'
        : `✅ ${processed} procesado(s)${failed ? `, ${failed} con error` : ''}.`);
    }
  }

  async function cmdErrores(msg, chat) {
    let content = '';
    try { content = fs.readFileSync(config.paths.errorsLog, 'utf8'); }
    catch (_) { await reply(chat, '✅ Sin errores registrados.'); return; }
    const lines = content.split(/\r?\n/)
      .filter((l) => l.includes('ERROR:') && !l.includes('DUPLICATE'))
      .slice(-10)
      .map((l) => {
        const ts = l.split('\t')[0];
        const errIdx = l.indexOf('ERROR:');
        const msgPart = errIdx >= 0 ? l.slice(errIdx + 6).trim() : l;
        return `[${ts}] ${maskSensitiveText(msgPart, 140)}`;
      });
    if (!lines.length) { await reply(chat, '✅ Sin errores registrados.'); return; }
    await maybeAsFile(chat, `🔴 Últimos ${lines.length} errores:`, lines, 'errores.txt');
  }

  async function cmdAuditoria(msg, chat) {
    const ids = await driveService.listUploadedIdsForDate(new Date());
    const subidos = new Set(ids).size;
    const maxId = ids.length ? Math.max(...ids) : 0;
    const gaps = findSequenceGaps(ids);
    const { files } = await driveService.listAllPendingFiles();
    const pendientes = (files || []).length;
    const recibidos = statsStore ? statsStore.getDailyStats().entries.length : null;
    const lines = [
      '🧾 Auditoría de cierre — hoy',
      `Subidos a Entrantes: ${subidos} (último ID ${maxId})`,
      recibidos !== null ? `Registrados por el bot: ${recibidos}` : null,
      `Pendientes en cola: ${pendientes}`,
      gaps.length
        ? `⚠️ Huecos en la secuencia: ${gaps.slice(0, 30).join(', ')}${gaps.length > 30 ? '…' : ''} (revisar)`
        : '✅ Secuencia sin huecos.',
    ].filter((l) => l !== null);
    await reply(chat, lines.join('\n'));
  }

  const COMMANDS = {
    '/comandos': cmdComandos,
    '/status': cmdStatus,
    '/resumen': cmdResumen,
    '/pendientes': cmdPendientes,
    '/recargar': cmdRecargar,
    '/grupos': cmdGrupos,
    '/bloqueados': cmdBloqueados,
    '/forzar': cmdForzar,
    '/errores': cmdErrores,
    '/auditoria': cmdAuditoria,
  };
  if (broadcastHandler) {
    COMMANDS['/broadcast'] = (msg, chat) => broadcastHandler.handleCommand(msg, chat);
  }

  async function dispatch(msg, chat) {
    const text = (msg.body || '').trim();
    const key = Object.keys(COMMANDS).find((k) => text === k || text.startsWith(`${k} `));
    if (!key) {
      await reply(chat, 'Comando no reconocido. Escribí /comandos para ver los disponibles.');
      return;
    }
    try {
      await COMMANDS[key](msg, chat);
    } catch (err) {
      console.error(`[CMD ${key}] error:`, maskSensitiveText(err && err.message));
      await reply(chat, `Error ejecutando ${key}.`).catch(() => {});
    }
  }

  // Para MOD-03: el broadcast necesita interceptar respuestas CONFIRMAR/CANCELAR
  // (que no empiezan con '/'). index.js consulta esto antes del dispatch normal.
  function isControlMessage(text) {
    const t = (text || '').trim();
    return t.startsWith('/');
  }

  return { dispatch, isControlMessage };
}

module.exports = { createCommandHandler };
