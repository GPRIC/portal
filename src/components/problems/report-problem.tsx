'use client';
// Report A Problem (P37, mockup #99 v2): a button in the board and team top bars. The person types what went wrong,
// may snip the screen (one frame through the browser's screen share, or an uploaded picture when the browser refuses)
// and may record a voice note (MediaRecorder; the browser writes the words into the notes when it can).
// The files go to the private bucket under problems/<user id>/; the database adds the person, time and device.
// Nothing is emailed: the Treasurer reads reports on the Problem Reports page.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { uploadFile } from '@/components/data';
import { deviceLabel } from '@/components/history';
import { useUI } from '@/components/ui';
import './problems.css';

/* ---------- icons ---------- */
const svg = (d: ReactNode, fill = false) => (
  <svg className="ico" viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
export const Icon = {
  flag: () => svg(<><path d="M4 22V4" /><path d="M4 4h12l-2 4 2 4H4" /></>),
  snip: () => svg(<><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><rect x="7" y="7" width="10" height="10" rx="1" /></>),
  mic: () => svg(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></>),
  stop: () => svg(<rect x="6" y="6" width="12" height="12" rx="2" />, true),
  play: () => svg(<path d="M7 4v16l13-8z" />, true),
  pause: () => svg(<><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>, true),
  lock: () => svg(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  img: () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 17l-5-5-9 8" /></>),
};

/** The name a page shows as, from its path. */
const PAGE_NAMES: Record<string, string> = {
  '/dashboard': 'Dashboard', '/grants': 'Grants', '/donors': 'Donors', '/requests': 'Requests', '/balances': 'Team Balances',
  '/ledger': 'Ledger', '/accounts': 'Accounts', '/documents': 'Documents', '/meetings': 'Meetings', '/history': 'History',
  '/problems': 'Problem Reports', '/team': 'Team Portal', '/team/history': 'Team History',
};
export function pageName(path: string, title?: string | null) {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return PAGE_NAMES[p] || title || p;
}
export const secs = (n: number) => Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
const shortName = (n: string) => n.replace(/ —.*/, '').replace(/ \(.*/, '');

export function ReportProblem({ who, role }: { who: string; role?: string }) {
  const ui = useUI();
  const path = usePathname();
  const open = () => {
    const page = path + (typeof window !== 'undefined' ? window.location.search : '');
    const title = document.title.replace(/ · GPRIC.*$/, '').trim() || null;
    ui.open(<ReportModal who={who} role={role} page={page} title={pageName(page, title)} />);
  };
  return (
    <button className="btn sm rep-btn" onClick={open} title="Tell the Treasurer something is wrong on this page. You can add a screenshot or a voice note.">
      <Icon.flag />Report A Problem
    </button>
  );
}

type SpeechRec = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; start: () => void; stop: () => void;
};
function speechRec(): SpeechRec | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const C = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!C) return null;
  try { return new C(); } catch { return null; }
}
function audioType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const MAX_REC = 300;
const BARS = 46;

function ReportModal({ who, role, page, title }: { who: string; role?: string; page: string; title: string }) {
  const ui = useUI();
  const [notes, setNotes] = useState('');
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [flash, setFlash] = useState(0);
  const [voice, setVoice] = useState<{ blob: Blob; secs: number; type: string } | null>(null);
  const [transcript, setTranscript] = useState('');
  const [rec, setRec] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.2));
  const [snipping, setSnipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const live = useRef<{ mr?: MediaRecorder; stream?: MediaStream; sr?: SpeechRec | null; timer?: ReturnType<typeof setInterval>; ctx?: AudioContext; raf?: number }>({});
  const [now] = useState(() => new Date());

  // Stop the microphone if the box closes mid-recording.
  useEffect(() => {
    const l = live.current;
    return () => {
      if (l.timer) clearInterval(l.timer);
      if (l.raf) cancelAnimationFrame(l.raf);
      try { l.sr?.stop(); } catch { /* already stopped */ }
      l.stream?.getTracks().forEach((t) => t.stop());
      l.ctx?.close().catch(() => {});
    };
  }, []);
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);
  useEffect(() => { textRef.current?.focus(); }, []);

  const setPicture = (blob: Blob) => { setShot({ blob, url: URL.createObjectURL(blob) }); setFlash((f) => f + 1); setMsg(null); };

  // One frame of the screen: hide this box, ask the browser to share the tab, grab a frame, stop sharing, bring the box back.
  const snip = async () => {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md?.getDisplayMedia) { fileRef.current?.click(); return; }
    setSnipping(true);
    await frame();
    let stream: MediaStream | null = null;
    try {
      stream = await md.getDisplayMedia({
        video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
      } as DisplayMediaStreamOptions);
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 350));   // let the share prompt close before the frame is taken
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d')!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('no picture');
      setPicture(blob);
    } catch {
      setMsg('The browser did not take the picture. You can choose a screenshot from your device instead.');
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setSnipping(false);
    }
  };

  const stopRec = useCallback(() => {
    const l = live.current;
    if (l.timer) clearInterval(l.timer);
    if (l.raf) cancelAnimationFrame(l.raf);
    l.ctx?.close().catch(() => {}); l.ctx = undefined;
    try { l.sr?.stop(); } catch { /* already stopped */ }
    if (l.mr && l.mr.state !== 'inactive') l.mr.stop();
    setRec(false);
  }, []);
  const startRec = async () => {
    const type = audioType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) { setMsg('This browser cannot record a voice note. Please type the problem instead.'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setMsg('The microphone was not allowed. Allow it in the browser, or type the problem instead.'); return; }
    const l = live.current;
    const chunks: Blob[] = [];
    const mr = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    const started = Date.now();
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const t = mr.mimeType || type || 'audio/webm';
      setVoice({ blob: new Blob(chunks, { type: t }), secs: Math.max(1, Math.round((Date.now() - started) / 1000)), type: t });
      stream.getTracks().forEach((x) => x.stop());
    };
    mr.start(1000);
    l.mr = mr; l.stream = stream;
    setRec(true); setRecSecs(0); setMsg(null); setVoice(null);
    l.timer = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      setRecSecs(s);
      if (s >= MAX_REC) stopRec();
    }, 500);
    // A live level meter, so the person can see they are being heard.
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 128;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const hist: number[] = Array(BARS).fill(0.2);
      let last = 0;
      const tick = (ts: number) => {
        if (ts - last > 70) {
          an.getByteTimeDomainData(buf);
          let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          hist.shift(); hist.push(Math.min(1, 0.15 + peak / 64));
          setLevels(hist.slice()); last = ts;
        }
        l.raf = requestAnimationFrame(tick);
      };
      l.ctx = ctx; l.raf = requestAnimationFrame(tick);
    } catch { /* no meter */ }
    // The browser writes out the words when it can (Chrome, Edge, Safari); the recording is attached either way.
    const sr = speechRec();
    if (sr) {
      sr.continuous = true; sr.interimResults = false; sr.lang = navigator.language || 'en-US';
      sr.onresult = (e) => {
        let said = '';
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
        said = said.trim();
        if (!said) return;
        setTranscript((t) => (t ? t + ' ' : '') + said);
        setNotes((n) => (n.trim() ? n.replace(/\s+$/, '') + (n.endsWith('\n') ? '' : ' ') : '') + said);
      };
      sr.onerror = () => {};
      try { sr.start(); l.sr = sr; } catch { l.sr = null; }
    }
  };

  const can = (notes.trim() || shot || voice) && !rec && !busy;
  const why = rec ? 'Stop the recording first' : !can ? 'Add a note, a screenshot or a voice note first' : '';
  const device = typeof window !== 'undefined' ? `${deviceLabel(navigator.userAgent)} · ${window.screen.width}×${window.screen.height}` : '';
  const time = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const send = async () => {
    if (!can) return;
    setBusy(true);
    try {
      const { data: s } = await supabase().auth.getUser();
      if (!s.user) throw new Error('Sign in again to send the report.');
      const dir = 'problems/' + s.user.id;
      const stamp = Date.now();
      let screenshot_path: string | null = null, audio_path: string | null = null;
      if (shot) {
        const up = await uploadFile(dir, new File([shot.blob], `${stamp}-screen.${shot.blob.type === 'image/png' ? 'png' : (shot.blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: shot.blob.type || 'image/png' }));
        if ('error' in up) throw new Error('The screenshot did not upload: ' + up.error);
        screenshot_path = up.path;
      }
      if (voice) {
        const ext = /mp4/.test(voice.type) ? 'm4a' : /ogg/.test(voice.type) ? 'ogg' : 'webm';
        const up = await uploadFile(dir, new File([voice.blob], `${stamp}-voice.${ext}`, { type: voice.type.split(';')[0] }));
        if ('error' in up) throw new Error('The voice note did not upload: ' + up.error);
        audio_path = up.path;
      }
      // Insert only (no read back): the person cannot read reports, the Treasurer can.
      const { error } = await supabase().from('problem_reports').insert({
        page, page_title: title, device, notes: notes.trim() || null, transcript: voice ? transcript.trim() || null : null,
        screenshot_path, audio_path, audio_secs: voice?.secs ?? null,
      });
      if (error) throw new Error(error.message);
      ui.close(); ui.toast('Report sent');
    } catch (e) {
      setBusy(false);
      ui.toast((e as Error).message, true);
    }
  };

  const tip = `Page: ${title} (${page}). Time: ${time}. Sender: ${who}${role ? ', ' + role : ''} · ${device}`;
  return (
    <div className={'ov' + (snipping ? ' snipping' : '')} onMouseDown={(e) => { if (e.target === e.currentTarget && !rec) ui.close(); }}>
      <div className="modal rp" role="dialog" aria-modal="true" aria-label="Report A Problem">
        <div className="mh"><h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ color: 'var(--g)', display: 'inline-flex' }}><Icon.flag /></span>Report A Problem</h3>
          <button className="x" onClick={() => { stopRec(); ui.close(); }} aria-label="Close">✕</button></div>
        <div className="mb">
          <div className="rbox">
            <div className="note" style={{ marginTop: -2 }}>What went wrong? The Treasurer reads every report.</div>
            <textarea ref={textRef} className="in" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What were you trying to do, and what happened instead?" />
            <div className="rp-tools">
              <button className="btn" onClick={snip} disabled={rec || busy} title="Hides this box, takes a picture of the page behind it, then brings the box back">
                <Icon.snip />{shot ? 'Retake Snip' : 'Snip Screen'}</button>
              <button className={'btn' + (rec ? ' rec' : '')} onClick={rec ? stopRec : startRec} disabled={busy}
                title="Talk instead of typing. What you say is written into the notes and the recording is attached.">
                {rec ? <><Icon.stop />Stop</> : <><Icon.mic />Voice Note</>}</button>
              {msg ? <button className="lnk" onClick={() => fileRef.current?.click()}>Choose A Screenshot</button> : null}
              <input ref={fileRef} className="rp-hidden" type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPicture(f); e.target.value = ''; }} />
            </div>
            {msg ? <div className="note">{msg}</div> : null}
            {rec ? (
              <div className="recbar"><span className="rdot" /><span className="tmr">{secs(recSecs)}</span>
                <div className="wave">{levels.map((v, i) => <i key={i} style={{ height: Math.round(v * 100) + '%' }} />)}</div>
                <span className="muted" style={{ fontSize: 12 }}>Listening…</span></div>
            ) : null}
            {shot || voice ? (
              <div className="rp-attach">
                {shot ? (
                  <div className="shot flash" key={flash}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not a served image */}
                    <img src={shot.url} alt="Screenshot to send" title="Screenshot of this page, taken just now. The Treasurer sees it full size." />
                    <div className="shot-acts"><button className="lnk" onClick={snip}>Retake</button><button className="lnk dim" onClick={() => setShot(null)}>Remove</button></div>
                  </div>
                ) : null}
                {voice ? (
                  <span className="achip" title="Voice recording attached. The words the browser caught are in the notes; the Treasurer can also play the recording.">
                    <Icon.play />Voice Note {secs(voice.secs)}
                    <button className="cx" onClick={() => { setVoice(null); setTranscript(''); }} title="Remove the recording (the typed words stay)" aria-label="Remove the recording">×</button>
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="autos" title={tip}>Sent with it: {title} · now · {shortName(who)}</div>
          </div>
        </div>
        <div className="mf">
          <button className="btn" onClick={() => { stopRec(); ui.close(); }}>Cancel</button>
          <span title={why}><button className="btn pri" disabled={!can} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></span>
        </div>
      </div>
    </div>
  );
}
