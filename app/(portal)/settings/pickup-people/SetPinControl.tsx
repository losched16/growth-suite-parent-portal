'use client';

// Tiny client island that lets the parent generate or revoke a PIN
// for a pickup person. Generation opens a small popover with options
// (no-expiry / expires today / expires in N days / temporary one-shot).
// On submit it hits the set-pin API and shows the resulting PIN inline.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Key, RotateCw, Trash2 } from 'lucide-react';

export function SetPinControl({
  pickupPersonId,
  hasExistingPin,
}: {
  pickupPersonId: string;
  hasExistingPin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [expiresChoice, setExpiresChoice] = useState<'never' | 'eod' | '7d' | '30d'>('never');
  const [isTemporary, setIsTemporary] = useState(false);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const expiresAt = computeExpiresAt(expiresChoice);
      const r = await fetch('/api/attendance/pickup-persons/set-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          id: pickupPersonId,
          expires_at: expiresAt,
          is_temporary: isTemporary,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setNewPin(data.pin);
      // Refresh the server data so the "PIN active" badge updates
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not generate PIN');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!confirm('Revoke this PIN? The pickup person will no longer be able to use it.')) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/attendance/pickup-persons/set-pin?id=${pickupPersonId}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      setNewPin(null);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not revoke PIN');
    } finally {
      setBusy(false);
    }
  }

  if (newPin) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wide text-amber-900 font-semibold">
          PIN — copy now
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <code className="font-mono text-lg tabular-nums text-amber-900">{newPin}</code>
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(newPin); }}
            className="text-[10px] underline text-amber-800 hover:text-amber-900"
          >
            copy
          </button>
          <button
            type="button"
            onClick={() => { setNewPin(null); setOpen(false); }}
            className="text-[10px] underline text-gray-600 hover:text-gray-900"
          >
            done
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50"
      >
        {hasExistingPin ? <RotateCw className="h-3 w-3" /> : <Key className="h-3 w-3" />}
        {hasExistingPin ? 'Regenerate PIN' : 'Set PIN'}
      </button>
    );
  }

  return (
    <div className="rounded border border-emerald-300 bg-white px-3 py-2 w-full sm:w-auto">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 mb-1">
        {hasExistingPin ? 'Regenerate PIN' : 'Set a new PIN'}
      </div>
      <div className="text-[11px] text-gray-600 mb-2">
        We&rsquo;ll generate a random 6-digit PIN. Share it with them — they enter it at the
        school&rsquo;s pickup kiosk.
      </div>
      <div className="space-y-2">
        <label className="block text-[11px]">
          Expires:{' '}
          <select
            value={expiresChoice}
            onChange={(e) => setExpiresChoice(e.target.value as typeof expiresChoice)}
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px]"
          >
            <option value="never">Never (recurring use)</option>
            <option value="eod">End of today</option>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={isTemporary}
            onChange={(e) => setIsTemporary(e.target.checked)}
            className="h-3 w-3"
          />
          <span>Mark as one-off / temporary (e.g. babysitter for today)</span>
        </label>
      </div>
      {err ? <p className="mt-1.5 text-[11px] text-red-700">{err}</p> : null}
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy ? 'Generating…' : 'Generate PIN'}
        </button>
        {hasExistingPin ? (
          <button
            type="button"
            onClick={revoke}
            disabled={busy}
            className="inline-flex items-center gap-0.5 rounded border border-rose-300 bg-white px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50 disabled:opacity-60"
          >
            <Trash2 className="h-3 w-3" /> Revoke
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => { setOpen(false); setErr(null); }}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function computeExpiresAt(choice: 'never' | 'eod' | '7d' | '30d'): string | null {
  if (choice === 'never') return null;
  const d = new Date();
  if (choice === 'eod') {
    d.setHours(23, 59, 59, 999);
  } else if (choice === '7d') {
    d.setDate(d.getDate() + 7);
  } else if (choice === '30d') {
    d.setDate(d.getDate() + 30);
  }
  return d.toISOString();
}
