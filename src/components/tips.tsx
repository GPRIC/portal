'use client';
// First-visit tip bubbles. Each tip shows beside its button until the person clicks Got It;
// what they have seen is kept in public.seen_tips, so it follows them to every device.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';

type TipsCtx = { seen: (key: string) => boolean; dismiss: (key: string) => void };
const Ctx = createContext<TipsCtx | null>(null);

export function TipsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  // null until loaded, so no tip flashes for someone who has already seen it.
  const [keys, setKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    supabase().from('seen_tips').select('tip_key').then(({ data }) => {
      if (live) setKeys(new Set((data || []).map((r) => r.tip_key as string)));
    });
    return () => { live = false; };
  }, [userId]);
  const seen = useCallback((k: string) => keys === null || keys.has(k), [keys]);
  const dismiss = useCallback((k: string) => {
    setKeys((s) => new Set(s || []).add(k));
    supabase().from('seen_tips').upsert({ user_id: userId, tip_key: k }, { onConflict: 'user_id,tip_key', ignoreDuplicates: true }).then(() => {});
  }, [userId]);
  return <Ctx.Provider value={{ seen, dismiss }}>{children}</Ctx.Provider>;
}

/** Wraps a button: the bubble sits under it until dismissed. side 'r' anchors the bubble to the right edge. */
export function Tip({ id, text, side, children }: { id: string; text: ReactNode; side?: 'r'; children: ReactNode }) {
  const c = useContext(Ctx);
  const show = c ? !c.seen(id) : false;
  return (
    <span className="tipwrap">
      {children}
      {show ? (
        <span className={'tip' + (side === 'r' ? ' r' : '')} role="note">
          <span className="tiptext">{text}</span>
          <button className="btn sm pri" onClick={() => c?.dismiss(id)}>Got It</button>
        </span>
      ) : null}
    </span>
  );
}
