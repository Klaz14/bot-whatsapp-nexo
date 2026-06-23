// Deteccion de huecos en la secuencia diaria de IDs (<ID>_<DDMM>_...). Auditoria de
// cierre: si falta un ID intermedio, puede ser un comprobante que no quedo subido.
// Sin deps -> testeable offline.

// ids: number[] (puede tener repetidos por PDFs multipagina que comparten ID).
// Devuelve los IDs faltantes entre 1 y el maximo (sin contar el 0).
function findSequenceGaps(ids) {
  const present = new Set();
  let max = 0;
  for (const raw of ids || []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) {
      present.add(id);
      if (id > max) max = id;
    }
  }
  const gaps = [];
  for (let i = 1; i < max; i++) {
    if (!present.has(i)) gaps.push(i);
  }
  return gaps;
}

module.exports = { findSequenceGaps };
