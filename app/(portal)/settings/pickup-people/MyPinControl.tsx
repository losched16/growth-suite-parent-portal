'use client';

// Parent's own kiosk PIN. Self-scoped — each parent (including each
// parent of a divorced household, from their own login) manages only
// their own PIN here. PINs are never displayed back once set; the
// parent picks a new one to change it.

import { useState } from 'react';
import { KeyRound, Loader2, CheckCircle2 } from 'lucide-react';

export function MyPinControl({ pinSet }: { pinSet: boolean }) {
  const [hasPin, setHasPin] = useState(pinSet);
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/attendance/my-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); setBusy(false); return; }
      setHasPin(true); setEditing(false); setPin(''); setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/attendance/my-pin', { method: 'DELETE' });
      if (!r.ok) { setErr(`HTTP ${r.status}`); setBusy(false); return; }
      setHasPin(false); setEditing(false); setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="h-5 w-5 text-emerald-700 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-slate-900">My kiosk check-in PIN</h2>
          <p className="text-[11px] text-slate-600 mt-0.5">
            Use this PIN at the front-door kiosk to check your kids in and out — no login needed.
            Only you can change your PIN.
          </p>

          {saved ? (
            <div className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> PIN saved
            </div>
          ) : null}

          {!editing ? (
            <div className="mt-2 flex items-center gap-2">
              <span className={`text-xs font-medium ${hasPin ? 'text-emerald-800' : 'text-slate-500'}`}>
                {hasPin ? 'PIN is set ✓' : 'No PIN set yet'}
              </span>
              <button
                type="button"
                onClick={() => { setEditing(true); setErr(null); }}
                className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50"
              >
                {hasPin ? 'Change PIN' : 'Set my PIN'}
              </button>
              {hasPin ? (
                <button
                  type="button"
                  onClick={clear}
                  disabled={busy}
                  className="text-xs text-slate-500 hover:text-rose-700 hover:underline"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d*"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="4-8 digits"
                autoFocus
                className="w-32 rounded-md border border-emerald-300 px-3 py-1.5 text-sm tracking-widest focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
              />
              <button
                type="button"
                onClick={save}
                disabled={busy || pin.length < 4}
                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save PIN
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setPin(''); setErr(null); }}
                disabled={busy}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          )}

          {err ? (
            <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">{err}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
