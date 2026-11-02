'use client';
// Hover and focus tips for Team Balances (the mockup's data-tip), built on the shared .pop popover.
import type { ReactNode } from 'react';

export function Hint({ tip, children, r }: { tip: ReactNode; children: ReactNode; r?: boolean }) {
  if (!tip) return <>{children}</>;
  return (
    <span className="bh" tabIndex={0}>
      {children}
      <span className={'pop' + (r ? ' r' : '')} role="tooltip">{tip}</span>
    </span>
  );
}

/** The small "?" beside a label. */
export function Info({ tip, r }: { tip: ReactNode; r?: boolean }) {
  return <Hint tip={tip} r={r}><span className="info" aria-label="More information">?</span></Hint>;
}

/** Money in the page's style: cents always, a minus sign for negatives, a faint $0.00. */
export function cash(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '−$' : '$') + s;
}
export function Cash({ n, out }: { n: number; out?: boolean }) {
  if (!n) return <span className="zero">$0.00</span>;
  return <>{cash(out ? -n : n)}</>;
}

/** Saves text as a file in the browser. */
export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
