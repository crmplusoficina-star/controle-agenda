export type AppointmentDraft = {
  id: string;
  branch: string;
  appointment_date: string;
  technician_id: string;
  client_name: string;
  equipment_serial: string;
  service_city: string;
  status: string;
  service_reason: string;
  description: string;
  reported_hourmeter: string;
  forecast_amount: string;
  billing_status: string;
};

export type FollowupDraft = {
  id: string;
  branch: string;
  client_name: string;
  equipment_serial: string;
  stage: 'prospectar' | 'acompanhar' | 'encerrar';
  next_followup_date: string;
  notes: string;
  result: '' | 'venda_ganha' | 'venda_perdida';
  sale_kind: '' | 'pecas' | 'servicos' | 'pecas_servicos';
  parts_value: string;
  services_value: string;
};

export function emptyAppointment(date: string, technicianId: string, branch: string): AppointmentDraft {
  return { id: '', branch, appointment_date: date, technician_id: technicianId, client_name: '', equipment_serial: '', service_city: '', status: 'planejado', service_reason: '', description: '', reported_hourmeter: '', forecast_amount: '', billing_status: 'aguardando_faturamento' };
}

export function emptyFollowup(branch: string): FollowupDraft {
  return {
    id: '',
    branch,
    client_name: '',
    equipment_serial: '',
    stage: 'prospectar',
    next_followup_date: '',
    notes: '',
    result: '',
    sale_kind: '',
    parts_value: '',
    services_value: '',
  };
}
