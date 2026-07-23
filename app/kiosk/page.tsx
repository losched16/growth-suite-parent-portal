// /kiosk — the clean front-door kiosk URL for custom portal domains.
//
// On a school's own domain the host already identifies the school
// (portal.desertgardenmontessori.org → DGM), so the iPad link needs no
// id: just /kiosk. The id'd URL (/kiosk/<uuid-or-location-id>) keeps
// working — this page resolves the school from the host and renders the
// exact same kiosk. On a generic host (vercel.app) there's no school to
// resolve → 404; use the id'd URL there.

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { schoolIdForHost } from '@/lib/branding';
import { resolveKioskSchool } from '@/lib/kiosk/kiosk';
import { resolveCurbsideSlots } from '@/lib/attendance/curbside-slots';
import { KioskCheckInOut } from './[schoolId]/KioskCheckInOut';

export const dynamic = 'force-dynamic';

export default async function KioskHostPage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const schoolId = await schoolIdForHost(host);
  if (!schoolId) notFound();
  const school = await resolveKioskSchool(schoolId);
  if (!school) notFound();
  const curbSlots = await resolveCurbsideSlots(school.id);

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col items-center px-4 py-8">
      <header className="w-full max-w-xl mb-6 text-center">
        <div className="text-xs uppercase tracking-wider text-slate-500">Check-in / Check-out</div>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">{school.name}</h1>
      </header>
      <KioskCheckInOut schoolId={school.id} curbSlots={curbSlots} />
      <p className="mt-8 text-[11px] text-slate-400 text-center max-w-md">
        Parents: set your PIN in the parent portal under Settings → Pickup People.
        Grandparents &amp; sitters: ask the parent to generate a PIN for you.
      </p>
    </main>
  );
}
