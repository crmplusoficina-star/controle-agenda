import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://ydziukxbglyuknamcokd.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXAiLCJyZWYiOiJ5ZHppdWt4YmdseXVrbmFtY29rZCIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzg3NTkyMzIzLCJleHAiOjIxMDMxNjgzMjN9.YwkQzz_UiozVmzn6AsdClMgUgD1GTbuYCezld-IJnjg';

const primarySupabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Shared Agenda data is canonical in the clean Agenda database. Keep the rest
// of the operational app on the current project, but route these relations
// through Agenda so every user reads the same shared configuration.
const agendaSupabase = createClient(
  'https://lwowtuspbrnbaukakyss.supabase.co',
  'sb_publishable_ZYYWM9lamdDpgiTMS4en9g_s-k2W9RN',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const agendaRelations = new Set([
  'client_location_overrides',
  'client_contacts',
  'agenda_share_recipients',
  'agenda_share_user_defaults',
]);

const primaryFrom = primarySupabase.from.bind(primarySupabase);
Object.defineProperty(primarySupabase, 'from', {
  configurable: false,
  writable: false,
  value: (relation: string) => agendaRelations.has(relation)
    ? agendaSupabase.from(relation)
    : primaryFrom(relation),
});

const primaryInvoke = primarySupabase.functions.invoke.bind(primarySupabase.functions);
Object.defineProperty(primarySupabase.functions, 'invoke', {
  configurable: false,
  writable: false,
  value: (functionName: string, options?: Parameters<typeof primaryInvoke>[1]) => functionName === 'retention-map-context'
    ? agendaSupabase.functions.invoke(functionName, options)
    : primaryInvoke(functionName, options),
});

export const supabase = primarySupabase;
