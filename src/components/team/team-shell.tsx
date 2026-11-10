'use client';
// The Team Portal shell: its own top bar (brand, area, team, who is signed in, Profile, theme, sign out),
// the team's data, first-visit tips, and the modal host.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { initials } from '@/lib/format';
import { ThemeToggle } from '@/components/shell';
import { UIHost, UIProvider, useUI } from '@/components/ui';
import { Tip, TipsProvider } from '@/components/tips';
import { TeamDataProvider, useTeam } from './team-data';
import { ProfileForm } from './team-forms';
import { ReportProblem } from '@/components/problems/report-problem';

export function TeamApp({ user, children }: { user: User; children: ReactNode }) {
  return (
    <UIProvider>
      <TeamDataProvider>
        <TipsProvider userId={user.id}>
          <TeamTopBar email={user.email || ''} />
          {children}
          <UIHost />
        </TipsProvider>
      </TeamDataProvider>
    </UIProvider>
  );
}

function TeamTopBar({ email }: { email: string }) {
  const router = useRouter();
  const ui = useUI();
  const { p } = useTeam();
  const me = p.me.name || p.me.email || email;
  const signOut = async () => { await supabase().auth.signOut(); router.replace('/login'); router.refresh(); };
  return (
    <header className="top">
      <Link className="brand" href="/team"><span className="dotb" />GPRIC</Link>
      <span className="area">Team</span>
      <span className="chip team-chip" title={p.team.name}><span className="dot" style={{ background: 'var(--g)' }} />{p.team.short || p.team.name}</span>
      <span className="sp" />
      <ReportProblem who={me + ' (' + (p.team.short || p.team.name) + ')'} role={p.me.role ? p.me.role + ' login' : 'Team login'} />
      <span className="chip who" tabIndex={0}>
        <span className="av grn">{initials(me)}</span><span className="who-name">{me}</span>
        <span className="pop r">Signed in as {p.me.email || email}.{p.me.role ? ' ' + p.me.role + ' login' : ' Team login'} for {p.team.name}. Two-step sign-in is on.</span>
      </span>
      <Link className="btn sm" href="/team/history" title="Every change to your team's requests, receipts and money">History</Link>
      <Tip id="team.profile" side="r" text="Your name and the Zelle contact the board pays you back at.">
        <button className="btn sm" onClick={() => ui.open(<ProfileForm />)}>Profile</button>
      </Tip>
      <ThemeToggle />
      <button className="btn sm" onClick={signOut}>Sign Out</button>
    </header>
  );
}
