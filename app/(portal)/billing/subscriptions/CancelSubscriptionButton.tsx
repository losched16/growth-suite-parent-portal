'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2 } from 'lucide-react';

export function CancelSubscriptionButton({
  purchaseId, productName,
}: {
  purchaseId: string;
  productName: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function cancel() {
    const ok = window.confirm(
      `Cancel your "${productName}" subscription?\n\n`
      + `You'll still have access through the end of the current billing period. `
      + `No more charges will be made after that.`,
    );
    if (!ok) return;
    setErr(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/billing/subscriptions/${purchaseId}/cancel`, { method: 'POST' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || `HTTP ${r.status}`);
        }
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not cancel.');
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        Cancel subscription
      </button>
      {err ? <span className="text-[11px] text-rose-700">{err}</span> : null}
    </div>
  );
}
