import { CreditCard } from 'lucide-react';
import { requireParent } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export default async function TuitionPage() {
  await requireParent();
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">Tuition &amp; Payments</h1>
        <p className="text-sm text-gray-600">View your balance and payment history.</p>
      </header>
      <div className="rounded-lg border border-dashed border-gray-300 bg-gradient-to-br from-emerald-50 to-white p-8 text-center">
        <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <CreditCard className="h-6 w-6 text-emerald-700" />
        </div>
        <h2 className="text-base font-semibold text-gray-900">Coming soon</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
          Tuition balances, payment history, payment plans, and online payment will appear
          here once Smart Payments is live for your school.
        </p>
      </div>
    </div>
  );
}
