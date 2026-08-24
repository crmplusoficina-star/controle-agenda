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
  branch: string;
  client_name: string;
  equipment_serial: string;
  action_date: string;
  treatment_type: string;
  status: string;
  estimated_value: string;
  next_followup_date: string;
  notes: string;
};

export function emptyAppointment(date: string, technicianId: string, branch: string): AppointmentDraft {
  return { id: '', branch, appointment_date: date, technician_id: technicianId, client_name: '', equipment_serial: '', service_city: '', status: 'planejado', service_reason: '', description: '', reported_hourmeter: '', forecast_amount: '', billing_status: 'nao_precificado' };
}
