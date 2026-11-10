'use client';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { useTeam } from '@/components/team/team-data';
import { Calendar } from '@/components/calendar/calendar';

// The team's calendar: community events and the team's own schedule (row security hides board meetings and other teams).
// A coach adds and changes only their own team's practices, scrimmages and competitions.
export default function TeamCalendarPage() {
  const { p } = useTeam();
  const team = useMemo(() => ({ id: p.team.id, name: p.team.name, short: p.team.short }), [p.team.id, p.team.name, p.team.short]);
  const teams = useMemo(() => [team], [team]);
  useEffect(() => { document.title = 'Calendar · GPRIC Team Portal'; }, []);
  return (
    <Calendar side="team" teams={teams} myTeam={team}
      frame={(perm, add, body) => (
        <div className="wrap">
          <div className="hdr"><h1>Calendar</h1><span className="sp" />{perm}<Link className="btn sm" href="/team">Back To Team Portal</Link>{add}</div>
          {body}
        </div>
      )} />
  );
}
