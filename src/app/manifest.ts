// Makes the portal installable on a phone (Add to Home Screen): its own icon, full screen, no browser bar.
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GPRIC Portal',
    short_name: 'GPRIC',
    description: 'Grosse Pointe Robotics & Innovation Center board portal',
    start_url: '/requests',
    scope: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#121212',
    icons: [
      { src: '/app-icon/192', sizes: '192x192', type: 'image/png' },
      { src: '/app-icon/512', sizes: '512x512', type: 'image/png' },
      { src: '/app-icon/512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
