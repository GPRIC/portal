'use client';
import Link from 'next/link';
import { History } from '@/components/history';

// The team's own history, read only (row security shows a team login only its own team's records).
export default function TeamHistoryPage() {
  return (
    <div className="wrap">
      <div className="hdr"><h1>History</h1><span className="sp" /><Link className="btn sm" href="/team">Back To Team Portal</Link></div>
      <History canRollBack={false} team />
    </div>
  );
}
