'use client';
import { TeamReceipts } from '@/components/team/team-receipts';

// The team's own receipts (team_portal() returns this team only) and anything paid still missing one.
export default function TeamReceiptsPage() {
  return <TeamReceipts />;
}
