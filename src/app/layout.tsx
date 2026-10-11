import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

const projectDomain =
  process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://localhost:5000';

export const metadata: Metadata = {
  metadataBase: new URL(
    projectDomain.startsWith('http://') || projectDomain.startsWith('https://')
      ? projectDomain
      : `https://${projectDomain}`,
  ),
  title: {
    default: 'vidio | AI product video creation',
    template: '%s | vidio',
  },
  description:
    'Turn product images into short promotional videos with vidio: identify selling points, draft scripts, generate voiceover and scenes, and compose the final video.',
  keywords: [
    'vidio',
    'AI product video',
    'product video generator',
    'promotional video',
    'AI video creation',
    'voiceover',
  ],
  applicationName: 'vidio',
  openGraph: {
    title: 'vidio | AI product video creation',
    description:
      'Turn product images into short promotional videos with vidio — from selling points and scripts to voiceover, scenes and the finished video.',
    siteName: 'vidio',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'vidio | AI product video creation',
    description: 'Create complete promotional product videos from images, selling points and scripts with vidio.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="en">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
