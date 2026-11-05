// Reglas del evento que el servidor hace cumplir (fechas límite y mesas).
// Se leen de public/event.json; si falta algo se usan estos valores.
export const DEFAULT_RULES = {
  rsvpUntil: Date.parse('2026-11-20T23:59:59-06:00'), // último momento para confirmar o modificar
  viewUntil: Date.parse('2026-12-02T23:59:59-06:00'), // último momento en que se puede ver la invitación
  tableCount: 15,
  tableCapacity: 12,
  mainTable: 'Principal',
};

export function rulesFromEvent(ev = {}) {
  const t = (iso, dflt) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : dflt;
  };
  const num = (v, dflt) => (Number.isInteger(v) && v > 0 ? v : dflt);
  return {
    rsvpUntil: t(ev.rsvpDeadlineISO, DEFAULT_RULES.rsvpUntil),
    viewUntil: t(ev.viewUntilISO, DEFAULT_RULES.viewUntil),
    tableCount: num(ev.tables?.count, DEFAULT_RULES.tableCount),
    tableCapacity: num(ev.tables?.capacity, DEFAULT_RULES.tableCapacity),
    mainTable: DEFAULT_RULES.mainTable,
  };
}
