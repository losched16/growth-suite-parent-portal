// /kiosk/[schoolId] — unified check-in/out kiosk.
//
// THE front-door iPad link. No parent-portal login: parents AND
// authorized pickup people (grandparents, babysitters) authenticate
// with their personal PIN. Accepts the school uuid OR the GHL location
// id in the URL — DGM's is /kiosk/wy1qNRECEgy8lg8pKqm0.
//
// The legacy checkout-only kiosk stays at /kiosk/[schoolId]/pickup;
// this page supersedes it (check-in + check-out, parents + pickups).

import { notFound } from 'next/navigation';
import { resolveKioskSchool } from '@/lib/kiosk/kiosk';
import { KioskCheckInOut } from './KioskCheckInOut';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function KioskPage({ params }: { params: Params }) {
  const { schoolId } = await params;
  const school = await resolveKioskSchool(schoolId);
  if (!school) notFound();

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col items-center px-4 py-8">
      <header className="w-full max-w-xl mb-6 text-center">
        <div className="text-xs uppercase tracking-wider text-slate-500">Check-in / Check-out</div>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">{school.name}</h1>
      </header>
      <KioskCheckInOut schoolId={schoolId} />
      <p className="mt-8 text-[11px] text-slate-400 text-center max-w-md">
        Parents: set your PIN in the parent portal under Settings → Pickup People.
        Grandparents &amp; sitters: ask the parent to generate a PIN for you.
      </p>
    </main>
  );
}
