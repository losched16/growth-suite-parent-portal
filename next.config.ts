import type { NextConfig } from 'next';

// Whitelisted iframe ancestors. The portal is meant to be top-level on
// family.mygrowthsuite.com but allow embedding from:
//   - the CRM iframe host (GHL family of domains)
//   - the Growth Suite operator dashboard (so a "Preview as parent"
//     link clicked inside the embedded operator iframe can load in
//     the same window if the browser blocks the popup — happens when
//     the outer iframe sandbox doesn't include allow-popups).
const FRAME_ANCESTORS = [
  "'self'",
  'https://*.gohighlevel.com',
  'https://*.leadconnectorhq.com',
  'https://app.msgsndr.com',
  'https://*.msgsndr.com',
  'https://growth-suite-dashboards.vercel.app',
  'https://*.vercel.app',
];

const nextConfig: NextConfig = {
  // Server actions default to 1MB; bump to 10MB so document uploads
  // (immunization records, custody papers, etc.) fit. The DB schema
  // also enforces 10MB max; whichever rejects first wins.
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${FRAME_ANCESTORS.join(' ')};`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
