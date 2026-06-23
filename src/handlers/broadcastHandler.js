// MOD-03: difusion masiva a los grupos productivos desde el grupo de control.
// Flujo: /broadcast <msg> -> preview + confirmacion (CONFIRMAR/CANCELAR) -> envio con
// delay entre grupos. Envia DIRECTO con chat.sendMessage (NO pasa por el notifier, que
// rechazaria CBUs/links — SPEC O1). Solo una difusion pendiente a la vez.

const { maskSensitiveText } = require('../utils/mask');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBroadcastHandler({ config, client, groupsCache }) {
  let pending = null; // { message, groupNames, timeoutId }

  function isPending() {
    return pending !== null;
  }

  // Nombres de los grupos productivos (Sheets si esta activo; si no, config.json),
  // excluyendo el grupo de control.
  function productiveGroupNames() {
    const names = groupsCache
      ? Object.keys(groupsCache.getAll())
      : Object.keys(config.whatsapp.groups || {});
    return names.filter((n) => n && n !== config.whatsapp.controlGroupName);
  }

  function clearPending() {
    if (pending && pending.timeoutId) clearTimeout(pending.timeoutId);
    pending = null;
  }

  async function handleCommand(msg, chat) {
    const text = (msg.body || '').trim();
    const message = text.slice('/broadcast'.length).trim();
    if (!message) {
      await chat.sendMessage('Uso: /broadcast <mensaje>. Todo lo que sigue se difunde a los grupos.');
      return;
    }
    if (pending) {
      await chat.sendMessage('⚠️ Ya hay una difusión esperando confirmación. Respondé CONFIRMAR o CANCELAR antes de lanzar otra.');
      return;
    }
    const groupNames = productiveGroupNames();
    if (!groupNames.length) {
      await chat.sendMessage('No hay grupos productivos para difundir.');
      return;
    }
    const timeoutMs = config.broadcast.confirmTimeoutMs;
    pending = {
      message,
      groupNames,
      timeoutId: setTimeout(() => {
        pending = null;
        chat.sendMessage('❌ Difusión cancelada por timeout.').catch(() => {});
      }, timeoutMs),
    };
    if (pending.timeoutId.unref) pending.timeoutId.unref();
    const mins = Math.round(timeoutMs / 60000);
    await chat.sendMessage([
      `🟢 Vas a enviar este mensaje a ${groupNames.length} grupos:`,
      '',
      '━━━━━━━━━━━━━',
      message,
      '━━━━━━━━━━━━━',
      '',
      `Respondé CONFIRMAR en los próximos ${mins} min para proceder, o CANCELAR para abortar.`,
    ].join('\n'));
  }

  // Intercepta CONFIRMAR / CANCELAR (no empiezan con '/'). Devuelve true si consumio el
  // mensaje. index.js lo llama solo para mensajes del grupo de control.
  async function maybeHandleReply(msg, chat) {
    if (!pending) return false;
    const text = (msg.body || '').trim().toUpperCase();
    if (text === 'CANCELAR') {
      clearPending();
      await chat.sendMessage('❌ Difusión cancelada.');
      return true;
    }
    if (text === 'CONFIRMAR') {
      const { message, groupNames } = pending;
      clearPending();
      await chat.sendMessage(`⏳ Iniciando difusión a ${groupNames.length} grupos...`);
      runBroadcast(message, groupNames, chat); // background, no bloquea
      return true;
    }
    return false; // no era una respuesta de confirmacion
  }

  async function runBroadcast(message, groupNames, controlChat) {
    const delayMs = config.broadcast.sendDelayMs;
    let okCount = 0;
    const failed = [];
    try {
      const chats = await client.getChats();
      const byName = new Map();
      for (const ch of chats) if (ch.isGroup) byName.set(ch.name, ch);

      for (const name of groupNames) {
        const target = byName.get(name);
        if (!target) { failed.push(name); continue; }
        try {
          await target.sendMessage(message);
          okCount += 1;
        } catch (err) {
          console.error(`[BROADCAST] fallo en "${maskSensitiveText(name, 80)}": ${maskSensitiveText(err && err.message)}`);
          failed.push(name);
        }
        if (delayMs > 0) await sleep(delayMs);
      }
    } catch (err) {
      await controlChat.sendMessage(`❌ Difusión fallida: ${maskSensitiveText(err && err.message)}`).catch(() => {});
      return;
    }

    const total = groupNames.length;
    let report;
    if (okCount === total) report = `✅ Difusión completada. ${okCount}/${total} grupos notificados.`;
    else if (okCount === 0) report = `❌ Difusión fallida. 0/${total} grupos notificados. Revisar logs.`;
    else report = `⚠️ Difusión completada con errores. ${okCount}/${total} notificados. Fallaron: ${failed.slice(0, 15).join(', ')}${failed.length > 15 ? '…' : ''}.`;
    await controlChat.sendMessage(report).catch(() => {});
  }

  return { handleCommand, maybeHandleReply, isPending };
}

module.exports = { createBroadcastHandler };
