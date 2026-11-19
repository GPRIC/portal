// The phone app's icon (manifest, home screen, notifications), drawn as a PNG at the size asked for.
import { ImageResponse } from 'next/og';

const SIZES = [96, 180, 192, 512];

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const asked = Number((await params).size);
  const s = SIZES.includes(asked) ? asked : 192;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#121212' }}>
        <div style={{ width: '78%', height: '78%', borderRadius: s * 0.16, background: '#1c1c1c', border: `${Math.max(2, s * 0.02)}px solid #3ecf8e`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3ecf8e', fontSize: s * 0.2, fontWeight: 700, letterSpacing: s * 0.004 }}>
          GPRIC
        </div>
      </div>
    ),
    { width: s, height: s, headers: { 'Cache-Control': 'public, max-age=86400' } },
  );
}
