import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Used only for Realtime subscriptions on the venue display screens.
// These bypass our own backend entirely (Vercel serverless can't hold a
// persistent Socket.IO connection open), connecting straight to Supabase's
// always-on realtime infrastructure instead.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
