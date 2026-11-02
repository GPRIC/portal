'use client';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/shell';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="authbrand"><span className="dotb" />GPRIC Board<span className="sp" /><ThemeToggle /></div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Only same-site paths are followed after sign-in. */
export function safeNext(v: string | null | undefined, fallback = '/dashboard') {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/login') ? v : fallback;
}
