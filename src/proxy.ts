import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_KEY, SUPABASE_URL, configured } from '@/lib/supabase/env';

// Keeps the sign-in session fresh and sends anyone without a finished two-step sign-in to /login.
// Row security in the database is the real guard; this only routes people.
// /api/zeffy is called by the Vercel cron and Zeffy's webhook, which check their own secrets.
const OPEN = ['/login', '/auth', '/setup', '/api/zeffy'];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const open = OPEN.some((p) => path === p || path.startsWith(p + '/'));
  if (!configured) {
    if (open) return NextResponse.next();
    const u = request.nextUrl.clone(); u.pathname = '/setup'; u.search = '';
    return NextResponse.redirect(u);
  }

  let response = NextResponse.next({ request });
  const sb = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await sb.auth.getClaims();
  const claims = data?.claims;

  if (open) return response;
  if (!claims || claims.aal !== 'aal2') {
    const u = request.nextUrl.clone();
    u.pathname = claims ? '/login/two-step' : '/login';
    u.search = path === '/' ? '' : '?next=' + encodeURIComponent(path + request.nextUrl.search);
    const r = NextResponse.redirect(u);
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
