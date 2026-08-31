import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://ydziukxbglyuknamcokd.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlkeml1a3hiZ2x5dWtuYW1jb2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1OTIzMjMsImV4cCI6MjEwMzE2ODMyM30.YwkQzz_UiozVmzn6AsdClMgUgD1GTbuYCezld-IJnjg';

const primarySupabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Client location corrections are shared business data. Keep them in the clean
// Agenda database even while the rest of the app still points at the legacy
// operational Supabase project.
const officialLocationSupabase = createClient(
  'https://lwowtuspbrnbaukakyss.supabase.co',
  'sb_publishable_ZYYWM9lamdDpgiTMS4en9g_s-k2W9RN',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const primaryFrom = primarySupabase.from.bind(primarySupabase);
Object.defineProperty(primarySupabase, 'from', {
  configurable: false,
  writable: false,
  value: (relation: string) => relation === 'client_location_overrides'
    ? officialLocationSupabase.from(relation)
    : primaryFrom(relation),
});

export const supabase = primarySupabase;
