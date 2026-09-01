export type AppointmentTypeStyle = {
  color: string;
  background: string;
};

export const APPOINTMENT_TYPE_STYLES: Record<string, AppointmentTypeStyle> = {
  'Garantia': { color: '#00b050', background: '#eefaf2' },
  'Férias': { color: '#ff0000', background: '#fff0f0' },
  'Aplicação de peças': { color: '#f4b183', background: '#fff6ef' },
  'Medição material rodante': { color: '#ff99cc', background: '#fff1f8' },
  'Oficina': { color: '#92d050', background: '#f4faec' },
  'Manutenção carro': { color: '#d9e1f2', background: '#f7f9fd' },
  'Diagnóstico': { color: '#000000', background: '#f2f2f2' },
  'Entrega Técnica': { color: '#ffff00', background: '#fffde8' },
  'Revisão PMP': { color: '#00b0f0', background: '#eefaff' },
  'Revisão OS cliente': { color: '#7030a0', background: '#f7f0fb' },
  'Equipamento parado': { color: '#f4cccc', background: '#fff5f5' },
  'Deslocamento garantia': { color: '#f4b183', background: '#fff6ef' },
  'Deslocamento cliente': { color: '#203864', background: '#f1f4f9' },
  'Deslocamento PMP': { color: '#7030a0', background: '#f7f0fb' },
  'Folga': { color: '#c00000', background: '#fff0f0' },
  'Sem agenda': { color: '#00b050', background: '#eefaf2' },
  'Treinamento': { color: '#0070c0', background: '#eef7fd' },
};

export const APPOINTMENT_TYPE_LEGEND = Object.entries(APPOINTMENT_TYPE_STYLES).map(([label, style]) => ({ label, ...style }));

export function appointmentTypeStyle(reason?: string | null): AppointmentTypeStyle {
  return APPOINTMENT_TYPE_STYLES[String(reason || '').trim()] || { color: '#94a3b8', background: '#f8fafc' };
}
