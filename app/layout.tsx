import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { loadBrandingByHost } from '@/lib/branding';
import { Geist, Geist_Mono, Dancing_Script } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

// Used by the `signature_stamp` form block to render pre-signed
// operator signatures (e.g. the Head of School pre-signing a form
// every parent fills out). Lazy-loaded via next/font.
const dancingScript = Dancing_Script({
  variable: '--font-signature',
  subsets: ['latin'],
  weight: ['600', '700'],
});

// Browser-tab title follows the school that owns the host (custom domains);
// the shared host keeps the generic app name.
export async function generateMetadata(): Promise<Metadata> {
  let title = process.env.NEXT_PUBLIC_APP_NAME ?? 'Family Portal';
  try {
    const h = await headers();
    const b = await loadBrandingByHost(h.get('x-forwarded-host') ?? h.get('host'));
    if (b?.display_name) title = b.display_name;
  } catch { /* keep the generic title */ }
  return {
    title,
    description: 'View and update your family’s information, forms, and messages.',
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${dancingScript.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
