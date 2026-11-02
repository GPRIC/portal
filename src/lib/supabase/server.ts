import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { SUPABASE_KEY, SUPABASE_URL } from './env';

export async function serverSupabase() {
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a Server Component: the proxy refreshes the session instead
        }
      },
    },
  });
}

/** Signed in with two-step done: the only state that may see board data. */
export async function boardClaims() {
  const sb = await serverSupabase();
  const { data } = await sb.auth.getClaims();
  const c = data?.claims;
  return c && c.aal === 'aal2' ? c : null;
}
