import type { Metadata, Viewport } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';

const dm = DM_Sans({ subsets: ['latin'], variable: '--font-dm', display: 'swap' });

export const metadata: Metadata = {
  title: 'GPRIC Board',
  description: 'Grosse Pointe Robotics & Innovation Center board portal',
  robots: { index: false, follow: false },
  // the phone app (manifest.ts): home-screen icon and full-screen launch on iPhone
  appleWebApp: { capable: true, title: 'GPRIC', statusBarStyle: 'black' },
  icons: { apple: '/app-icon/180' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#121212' };

// Set the saved light/dark choice before the first paint so the page never flashes the wrong theme.
const THEME = `try{var t=localStorage.getItem('gpric_theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={dm.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
