export type ViewName = 'agenda' | 'retencao' | 'followup';

export type Branch = { name: string };
export type Technician = { id: string; branch: string; name: string; active: boolean };

export type AppointmentStatus = 'planejado' | 'confirmado' | 'em_atendimento' | 'concluido' | 'cancelado';

export type Appointment = {
  id: string;
  branch: string;
  appointment_date: string;
  technician_id: string;
  client_name: string | null;
  equipment_serial: string | null;
  service_city: string | null;
  status: AppointmentStatus;
  service_reason: string | null;
  description: string | null;
  reported_hourmeter: number | null;
  forecast_amount: number;
  billing_status: string;
  technician?: Technician | null;
};

export type MachineSummary = {
  serial: string;
  client_name: string | null;
  city: string | null;
  state: string | null;
  branch: string | null;
  first_service_at: string | null;
  last_service_at: string | null;
  service_count: number;
  last_operation_type: string | null;
  last_os_type: string | null;
  last_description: string | null;
  last_os_g4: string | null;
  last_os_sap: number | null;
};

export type ClientSummary = {
  client_key: string;
  client_name: string;
  branch: string;
  city: string | null;
  last_service_at: string | null;
  first_service_at: string | null;
  service_count: number;
  machine_count: number;
  last_operation_type: string | null;
  last_description: string | null;
};

export type HistoryRow = {
  source_id: number;
  os_g4: string | null;
  os_sap: number | null;
  client_name: string | null;
  serial: string | null;
  city: string | null;
  branch: string | null;
  operation_type: string | null;
  os_type: string | null;
  status: string | null;
  service_date: string | null;
  description: string | null;
};

export type FollowupStage = 'prospectar' | 'acompanhar' | 'encerrar';
export type FollowupResult = 'venda_ganha' | 'venda_perdida' | null;
export type FollowupSaleKind = 'pecas' | 'servicos' | 'pecas_servicos' | null;

export type Followup = {
  id: string;
  branch: string;
  client_name: string;
  equipment_serial: string | null;
  action_date: string;
  treatment_type: string;
  status: string;
  estimated_value: number | null;
  next_followup_date: string | null;
  notes: string | null;
  stage: FollowupStage;
  result: FollowupResult;
  sale_kind: FollowupSaleKind;
  parts_value: number | null;
  services_value: number | null;
  created_at: string;
  updated_at: string;
};

export type Insight = {
  id: string;
  appointment_id: string | null;
  branch: string | null;
  insight_type: string;
  priority: string;
  presentation_level: number;
  title: string;
  message: string;
  status: string;
  created_at: string;
};
