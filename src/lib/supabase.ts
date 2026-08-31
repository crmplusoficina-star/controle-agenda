import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://ydziukxbglyuknamcokd.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlkeml1a3hiZ2x5dWtuYW1jb2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1OTIzMjMsImV4cCI6MjEwMzE2ODMyM30.YwkQzz_UiozVmzn6AsdClMgUgD1GTbuYCezld-IJnjg';

const primarySupabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Shared map/location data is canonical in the clean Agenda database. Keep the
// rest of the operational app on the current project, but route official client
// coordinates and the retention map context through Agenda so both use the same
// source of truth.
const agendaSupabase = createClient(
  'https://lwowtuspbrnbaukakyss.supabase.co',
  'sb_publishable_ZYYWM9lamdDpgiTMS4en9g_s-k2W9RN',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const primaryFrom = primarySupabase.from.bind(primarySupabase);
Object.defineProperty(primarySupabase, 'from', {
  configurable: false,
  writable: false,
  value: (relation: string) => relation === 'client_location_overrides'
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
