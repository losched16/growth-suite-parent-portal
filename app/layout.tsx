import type { Metadata } from 'next';
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

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Family Portal',
  description: 'View and update your family’s information, forms, and messages.',
};

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
