// MOD-01: matching entre los grupos donde el bot esta presente y los pares
// {grupo, TAG} de la planilla. Fase 1: SOLO match exacto (case-insensitive por
// default). El match ambiguo (scoring + consulta al grupo de control) se difiere a
// cuando MOD-04 este listo; se devuelve `unmatched` para que el llamador lo reporte.

function normalizeName(value, caseSensitive) {
  const t = String(value || '').trim();
  return caseSensitive ? t : t.toLowerCase();
}

// presentNames: string[] (nombres de grupos donde esta el bot)
// pairs: [{ grupoWhatsapp, tag }]
// -> { matched: [{ name, tag }], unmatched: [{ grupoWhatsapp, tag }] }
function matchExact(presentNames, pairs, { caseSensitive = false } = {}) {
  const present = new Map();
  for (const name of presentNames || []) {
    present.set(normalizeName(name, caseSensitive), name);
  }

  const matched = [];
  const unmatched = [];
  for (const pair of pairs || []) {
    const key = normalizeName(pair.grupoWhatsapp, caseSensitive);
    if (present.has(key)) {
      matched.push({ name: present.get(key), tag: pair.tag });
    } else {
      unmatched.push(pair);
    }
  }

  return { matched, unmatched };
}

module.exports = { matchExact, normalizeName };
