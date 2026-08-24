import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || 'https://ydziukxbglyuknamcokd.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlkeml1a3hiZ2x5dWtuYW1jb2tkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1OTIzMjMsImV4cCI6MjEwMzE2ODMyM30.YwkQzz_UiozVmzn6AsdClMgUgD1GTbuYCezld-IJnjg';

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
