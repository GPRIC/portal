// Project URL and publishable key come from the environment only (Vercel settings, or .env.local on a dev machine).
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const BUCKET = 'board-files';
