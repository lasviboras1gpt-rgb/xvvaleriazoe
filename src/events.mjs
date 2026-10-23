// Textos en español de los avisos (mismos que usa el panel de Windows).
const lugares = (n) => (n === 1 ? '1 lugar' : `${n} lugares`);

export function describeEvent(e) {
  switch (e.type) {
    case 'open':
      return {
        title: 'Invitación abierta',
        text: e.firstOpen ? `${e.guest} abrió su invitación por primera vez` : `${e.guest} volvió a abrir su invitación`,
      };
    case 'confirm':
      return { title: 'Asistencia confirmada', text: `${e.guest} confirmó ${lugares(e.count)} de ${e.seats} asignados` };
    case 'decline':
      return { title: 'No podrá asistir', text: `${e.guest} avisó que no podrá asistir` };
    case 'modify': {
      let text;
      if (e.status === 'declined') text = `${e.guest} cambió su respuesta: ya no podrá asistir`;
      else if (e.previousStatus === 'declined') text = `${e.guest} cambió su respuesta: ahora asistirá con ${lugares(e.count)}`;
      else text = `${e.guest} cambió de ${lugares(e.previousCount)} a ${lugares(e.count)}`;
      return { title: 'Asistencia modificada', text };
    }
    default:
      return { title: 'Novedad', text: String(e.guest ?? '') };
  }
}
