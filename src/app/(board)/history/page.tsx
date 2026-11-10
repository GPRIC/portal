'use client';
import { Page } from '@/components/shell';
import { useData } from '@/components/data';
import { History } from '@/components/history';

export default function HistoryPage() {
  const { isTreasurer } = useData();
  return (
    <Page title="History" help="history" actions={<span className="muted" title="Every add, change, archive, sign-in, approval, payment, import and month lock is written by the database itself, so nothing escapes the log.">Recorded by the database for every board and team action</span>}>
      <History canRollBack={isTreasurer} />
    </Page>
  );
}
