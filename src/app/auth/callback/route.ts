import { NextResponse, type NextRequest } from 'next/server';
import { serverSupabase } from '@/lib/supabase/server';

// Password-reset links come back here with a one-time code that becomes a session.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safe(url.searchParams.get('next'));
  if (code) {
    const sb = await serverSupabase();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent(error.message), url.origin));
  }
  return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent(url.searchParams.get('error_description') || 'That link is not valid.'), url.origin));
}

function safe(v: string | null) {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/login/two-step';
}
