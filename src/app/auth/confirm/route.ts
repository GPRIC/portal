import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { serverSupabase } from '@/lib/supabase/server';

// Invite and reset emails link here: /auth/confirm?token_hash=...&type=invite|recovery
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  if (token_hash && type) {
    const sb = await serverSupabase();
    const { error } = await sb.auth.verifyOtp({ type, token_hash });
    if (!error) {
      const dest = type === 'invite' || type === 'recovery' || type === 'signup' ? '/login/password' : '/login/two-step';
      return NextResponse.redirect(new URL(dest, url.origin));
    }
    return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('That link has expired or was already used. Ask for a new one.'), url.origin));
  }
  return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('That link is not valid.'), url.origin));
}
