// R1: limpieza de locks huerfanos de Chromium (SingletonLock/SingletonCookie/SingletonSocket)
// que quedan en el userDataDir de la sesion de WhatsApp tras un cierre sucio del proceso
// (crash, kill, o abrir la Railway Console durante un redeploy). Si un contenedor nuevo
// arranca y encuentra estos locks, Chromium falla con "profile appears to be in use"
// (Code 21) y el bot no levanta. Con la auto-recuperacion (exit-on-disconnect, F0.4) eso
// puede derivar en crash-loop. Este cleanup replica en codigo el fix manual que se hacia
// por SSH durante el incidente del 23/06:
//   find /data/.wwebjs_auth/ -name "Singleton*" -delete
//
// Es best-effort: nunca lanza. Si un borrado falla (permisos, ya no existe), se ignora y
// se sigue. Seguro porque el proyecto es single-instance (CLAUDE.md §12): un solo proceso
// usa el perfil, asi que no hay otra instancia viva cuyo lock estariamos borrando.

const fs = require('fs');
const path = require('path');

// Borra recursivamente todo archivo cuyo nombre empiece con "Singleton" bajo rootDir.
// Devuelve la cantidad de locks eliminados. No sigue symlinks de directorio (withFileTypes
// marca los symlinks como no-directorio), pero SI borra los Singleton* que son symlinks
// (unlinkSync borra el link, no su destino), que es justo el caso de SingletonLock en Linux.
function clearSingletonLocks(rootDir) {
  let removed = 0;
  if (!rootDir) return removed;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // dir no existe o sin permisos: best-effort, no es error
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.startsWith('Singleton')) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch (_) {
          // lock en uso / permisos / ya borrado: ignorar y continuar
        }
      }
    }
  }

  walk(rootDir);
  return removed;
}

module.exports = { clearSingletonLocks };
