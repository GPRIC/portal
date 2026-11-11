'use client';
import { useMemo } from 'react';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { Calendar } from '@/components/calendar/calendar';

// Board meetings, community events and team schedules in one calendar (mockup 98). Officers add and change any event.
export default function CalendarPage() {
  const { db, readOnly } = useData();
  const teams = useMemo(() => db.teams.map((t) => ({ id: t.id, name: t.name, short: t.short })), [db.teams]);
  // The CPA reads the books only; calendar_events is not readable for that login (0012_cpa.sql).
  if (readOnly) return <Page title="Calendar"><div className="panel empty">The calendar is not part of the CPA login.</div></Page>;
  return (
    <Calendar side="board" teams={teams}
      frame={(perm, add, body) => <Page title="Calendar" actions={<>{perm}{add}</>}>{body}</Page>} />
  );
}
