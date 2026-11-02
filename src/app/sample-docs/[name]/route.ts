import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { boardClaims } from '@/lib/supabase/server';

// The made-up documents that come with the sample data. Board only; removed with the sample rows' links.
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!(await boardClaims())) return new NextResponse('Sign in first.', { status: 401 });
  const raw = (await params).name;
  if (!/^[a-z0-9-]+(\.(html|css))?$/.test(raw)) return new NextResponse('Not found', { status: 404 });
  const name = path.extname(raw) ? raw : raw + '.html';
  const ext = path.extname(name);
  try {
    const body = await readFile(path.join(process.cwd(), 'sample-docs', name));
    return new NextResponse(body, { headers: { 'Content-Type': TYPES[ext], 'Cache-Control': 'private, no-store' } });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
