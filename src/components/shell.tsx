'use client';
// The board shell: top bar with the nine pages, who is signed in, light/dark switch, sign out,
// the page header with About This Page, and the Sample Data flag with its Clear button.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { HELP } from '@/lib/help';
import { initials } from '@/lib/format';
import { DataProvider, useData } from './data';
import { ROLE_LABEL } from '@/lib/types';
import { Modal, UIHost, UIProvider, useUI } from './ui';
import { TipsProvider } from './tips';

export const NAV: [string, string][] = [
  ['/dashboard', 'Dashboard'], ['/grants', 'Grants'], ['/donors', 'Donors'], ['/requests', 'Team Requests'],
  ['/balances', 'Team Balances'], ['/ledger', 'Ledger'], ['/accounts', 'Accounts'], ['/documents', 'Documents'], ['/meetings', 'Meetings'],
];

export function BoardApp({ user, children }: { user: User; children: ReactNode }) {
  return (
    <UIProvider>
      <DataProvider user={user}>
        <TipsProvider userId={user.id}>
          <TopBar />
          {children}
          <SampleFlag />
          <UIHost />
        </TipsProvider>
      </DataProvider>
    </UIProvider>
  );
}

type Theme = 'system' | 'light' | 'dark';
const THEME_EVENT = 'gpric-theme';
function readTheme(): Theme {
  try { return (localStorage.getItem('gpric_theme') as Theme | null) || 'system'; } catch { return 'system'; }
}
function onTheme(cb: () => void) {
  window.addEventListener(THEME_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { window.removeEventListener(THEME_EVENT, cb); window.removeEventListener('storage', cb); };
}
export function ThemeToggle() {
  const t = useSyncExternalStore(onTheme, readTheme, () => 'system' as Theme);
  const next = () => {
    const n: Theme = t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
    try { if (n === 'system') localStorage.removeItem('gpric_theme'); else localStorage.setItem('gpric_theme', n); } catch { /* storage blocked */ }
    if (n === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = n;
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  const label = t === 'system' ? 'Theme: Auto' : t === 'light' ? 'Theme: Light' : 'Theme: Dark';
  return <button className="btn sm" onClick={next} title="Switch between light, dark and your device setting">{label}</button>;
}

function TopBar() {
  const path = usePathname();
  const router = useRouter();
  const { me, user, role } = useData();
  const signOut = async () => { await supabase().auth.signOut(); router.replace('/login'); router.refresh(); };
  return (
    <header className="top">
      <Link className="brand" href="/dashboard"><span className="dotb" />GPRIC</Link>
      <span className="area">Board</span>
      <nav className="nav" aria-label="Board pages">
        {NAV.map(([href, label]) => <Link key={href} href={href} className={path === href ? 'on' : ''}>{label}</Link>)}
      </nav>
      <span className="chip who" tabIndex={0}>
        <span className="av grn">{initials(me)}</span><span className="who-name">{me}</span>
        {role ? <span className="muted who-role">{ROLE_LABEL[role]}</span> : null}
        <span className="pop r">Signed in as {user.email}{role ? ' · ' + ROLE_LABEL[role] : ''}. Two-step sign-in is on.</span>
      </span>
      <ThemeToggle />
      <button className="btn sm" onClick={signOut}>Sign Out</button>
    </header>
  );
}

export function Page({ title, help, actions, children }: { title: string; help?: string; actions?: ReactNode; children: ReactNode }) {
  const ui = useUI();
  const h = help ? HELP[help] : null;
  const about = () => h && ui.open(
    <Modal title="About This Page" foot={<><span /><button className="btn" onClick={ui.close}>Close</button></>}>
      <div className="full helpsec">
        <h4>What This Page Is For</h4><p>{h.purpose}</p>
        <h4>How It Works</h4><ol>{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <h4>Who Sees It</h4><p>{h.who}</p>
      </div>
    </Modal>,
  );
  useEffect(() => { document.title = title + ' · GPRIC Board'; }, [title]);
  return (
    <div className="wrap">
      <div className="hdr">
        <h1>{title}</h1>
        {h ? <button className="btn about" onClick={about}>About This Page</button> : null}
        <span className="sp" />
        <span className="acts">{actions}</span>
      </div>
      {children}
    </div>
  );
}

function SampleFlag() {
  const { anySample, run, isTreasurer } = useData();
  const ui = useUI();
  if (!anySample || !isTreasurer) return null;
  const clear = async () => {
    const ok = await ui.confirm({
      title: 'Clear Sample Data',
      body: <>This removes every made-up row the portal started with: the sample donors, gifts, grants, ledger entries, team requests, meetings, documents and accounts. Anything you entered yourself stays. Sample funds, teams or donors that your own entries use are kept and become real. This cannot be undone.</>,
      ok: 'Clear Sample Data', danger: true,
    });
    if (!ok) return;
    await run(() => supabase().rpc('clear_sample_data'), 'Sample data cleared');  // Treasurer only (the database checks too)
  };
  return <button className="sample-flag" onClick={clear} title="Some names and figures here are made up to show how the portal works. Click to clear them.">Sample data · Clear</button>;
}
