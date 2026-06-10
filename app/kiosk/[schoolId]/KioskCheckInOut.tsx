'use client';

// Kiosk client flow: PIN pad → student selection → confirm → done.
//
// Built for an iPad propped at the front door: huge touch targets,
// no keyboard needed, auto-resets to the PIN pad after each person so
// the next family can walk up. PIN is the identity proof (verified
// server-side); no signature step.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Delete, LogIn, LogOut, CheckCircle2, Loader2, Car } from 'lucide-react';

interface PickupTimeOption { value: string; label: string; programs_short: string }
interface KioskStudent {
  id: string;
  name: string;
  program: string | null;
  checked_in: boolean;
  pickup_times: PickupTimeOption[];
}

type Phase =
  | { name: 'pin' }
  | { name: 'verifying' }
  | { name: 'select'; token: string; person: string; students: KioskStudent[] }
  | { name: 'submitting'; token: string; person: string; students: KioskStudent[] }
  | { name: 'done'; person: string; summary: Array<{ student_name: string; action: string }> };

const RESET_AFTER_DONE_S = 8;

export function KioskCheckInOut({ schoolId }: { schoolId: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'pin' });
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Selection state for the 'select' phase
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickupTimes, setPickupTimes] = useState<Record<string, string>>({});
  const [curbside, setCurbside] = useState(false);
  const [curbsideSlot, setCurbsideSlot] = useState('');

  const reset = useCallback(() => {
    setPhase({ name: 'pin' });
    setPin(''); setErr(null);
    setSelected(new Set()); setPickupTimes({});
    setCurbside(false); setCurbsideSlot('');
  }, []);

  // Auto-reset countdown on the done screen.
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phase.name === 'done') {
      doneTimer.current = setTimeout(reset, RESET_AFTER_DONE_S * 1000);
      return () => { if (doneTimer.current) clearTimeout(doneTimer.current); };
    }
  }, [phase.name, reset]);

  async function submitPin() {
    if (pin.length < 4) return;
    setPhase({ name: 'verifying' }); setErr(null);
    try {
      const r = await fetch(`/api/kiosk/${encodeURIComponent(schoolId)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.detail || (j.error === 'rate_limited' ? 'Too many attempts — wait a few minutes.' : 'PIN not recognized.'));
        setPhase({ name: 'pin' }); setPin('');
        return;
      }
      const students: KioskStudent[] = j.students ?? [];
      if (students.length === 0) {
        setErr('No students found for your PIN. Please see the front office.');
        setPhase({ name: 'pin' }); setPin('');
        return;
      }
      // Pre-select every student (the common case is "all my kids"),
      // and prefill each check-in's pickup time when their program
      // maps to a single wave.
      setSelected(new Set(students.map((s) => s.id)));
      const prefill: Record<string, string> = {};
      for (const s of students) {
        if (!s.checked_in && s.pickup_times.length === 1) prefill[s.id] = s.pickup_times[0].value;
      }
      setPickupTimes(prefill);
      setPhase({ name: 'select', token: j.token, person: j.person_name, students });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase({ name: 'pin' }); setPin('');
    }
  }

  async function submitActions() {
    if (phase.name !== 'select') return;
    const chosen = phase.students.filter((s) => selected.has(s.id));
    if (chosen.length === 0) return;
    // Every check-in needs a pickup time before we let them through.
    for (const s of chosen) {
      if (!s.checked_in && !pickupTimes[s.id]) {
        setErr(`Pick a pickup time for ${s.name.split(' ')[0]}.`);
        return;
      }
    }
    setErr(null);
    setPhase({ ...phase, name: 'submitting' });
    try {
      const r = await fetch(`/api/kiosk/${encodeURIComponent(schoolId)}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: phase.token,
          actions: chosen.map((s) => ({
            student_id: s.id,
            action: s.checked_in ? 'check_out' : 'check_in',
            ...(s.checked_in ? {} : {
              pickup_time: pickupTimes[s.id],
              curbside,
              curbside_slot: curbside ? curbsideSlot : undefined,
            }),
          })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setPhase({ ...phase, name: 'select' });
        return;
      }
      setPhase({
        name: 'done',
        person: phase.person,
        summary: (j.recorded ?? []).map((x: { student_name: string; action: string }) => x),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase({ ...phase, name: 'select' });
    }
  }

  // ── PIN pad ────────────────────────────────────────────────────────
  if (phase.name === 'pin' || phase.name === 'verifying') {
    const busy = phase.name === 'verifying';
    return (
      <div className="w-full max-w-xs">
        <div className="mb-4 text-center">
          <div className="text-sm text-slate-600">Enter your PIN</div>
          <div className="mt-2 h-12 flex items-center justify-center gap-2">
            {pin.length === 0 ? (
              <span className="text-slate-300 text-2xl tracking-widest">····</span>
            ) : (
              Array.from(pin).map((_, i) => (
                <span key={i} className="h-4 w-4 rounded-full bg-slate-800 inline-block" />
              ))
            )}
          </div>
        </div>
        {err ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 text-center">{err}</div>
        ) : null}
        <div className="grid grid-cols-3 gap-2">
          {['1','2','3','4','5','6','7','8','9'].map((d) => (
            <PadKey key={d} onClick={() => setPin((p) => (p.length < 8 ? p + d : p))} disabled={busy}>{d}</PadKey>
          ))}
          <PadKey onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} subtle>
            <Delete className="h-6 w-6 mx-auto" />
          </PadKey>
          <PadKey onClick={() => setPin((p) => (p.length < 8 ? p + '0' : p))} disabled={busy}>0</PadKey>
          <button
            type="button"
            onClick={submitPin}
            disabled={busy || pin.length < 4}
            className="rounded-xl bg-emerald-600 text-white text-lg font-semibold py-4 hover:bg-emerald-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-6 w-6 mx-auto animate-spin" /> : 'Go'}
          </button>
        </div>
      </div>
    );
  }

  // ── Done ───────────────────────────────────────────────────────────
  if (phase.name === 'done') {
    return (
      <div className="w-full max-w-md text-center">
        <CheckCircle2 className="h-16 w-16 text-emerald-600 mx-auto" />
        <h2 className="mt-3 text-2xl font-semibold text-slate-900">All set, {phase.person.split(' ')[0]}!</h2>
        <ul className="mt-4 space-y-1.5">
          {phase.summary.map((s, i) => (
            <li key={i} className="text-lg text-slate-800">
              {s.action === 'check_in' ? '✅ Checked in' : '👋 Checked out'} <strong>{s.student_name}</strong>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-xl bg-slate-800 px-8 py-3 text-white text-lg font-semibold hover:bg-slate-900"
        >
          Done
        </button>
        <p className="mt-2 text-xs text-slate-400">Resets automatically in a few seconds…</p>
      </div>
    );
  }

  // ── Student selection ──────────────────────────────────────────────
  const busy = phase.name === 'submitting';
  const chosen = phase.students.filter((s) => selected.has(s.id));
  const anyCheckIns = chosen.some((s) => !s.checked_in);

  return (
    <div className="w-full max-w-md space-y-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-slate-900">Hi, {phase.person.split(' ')[0]}!</h2>
        <p className="text-sm text-slate-600">Tap to select who you&rsquo;re dropping off or picking up.</p>
      </div>

      <div className="space-y-2">
        {phase.students.map((s) => {
          const on = selected.has(s.id);
          return (
            <div key={s.id} className={`rounded-xl border-2 ${on ? (s.checked_in ? 'border-sky-400 bg-sky-50' : 'border-emerald-400 bg-emerald-50') : 'border-slate-200 bg-white opacity-60'}`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                  return next;
                })}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <div>
                  <div className="text-lg font-semibold text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-500">{s.checked_in ? 'Currently here' : 'Not checked in yet'}</div>
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${
                  s.checked_in ? 'bg-sky-600 text-white' : 'bg-emerald-600 text-white'
                } ${on ? '' : 'opacity-30'}`}>
                  {s.checked_in ? <LogOut className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                  {s.checked_in ? 'Check out' : 'Check in'}
                </span>
              </button>
              {/* Pickup-time selector for check-ins */}
              {on && !s.checked_in ? (
                <div className="border-t border-emerald-200 px-4 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 mb-1">Pickup time today</div>
                  <div className="flex gap-2 flex-wrap">
                    {s.pickup_times.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={busy}
                        onClick={() => setPickupTimes((m) => ({ ...m, [s.id]: opt.value }))}
                        className={`rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
                          pickupTimes[s.id] === opt.value
                            ? 'border-emerald-600 bg-emerald-600 text-white'
                            : 'border-emerald-300 bg-white text-emerald-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Curbside intent — applies to all selected check-ins */}
      {anyCheckIns ? (
        <label className="flex items-center gap-3 rounded-xl border border-violet-200 bg-violet-50/40 px-4 py-3">
          <input
            type="checkbox"
            checked={curbside}
            onChange={(e) => setCurbside(e.target.checked)}
            disabled={busy}
            className="h-5 w-5 rounded border-violet-300"
          />
          <span className="flex items-center gap-1.5 text-sm text-slate-800">
            <Car className="h-4 w-4 text-violet-600" /> Curbside pickup today
          </span>
          {curbside ? (
            <input
              type="text"
              value={curbsideSlot}
              onChange={(e) => setCurbsideSlot(e.target.value)}
              placeholder="Slot #"
              maxLength={16}
              disabled={busy}
              className="ml-auto w-20 rounded-md border border-violet-300 px-2 py-1 text-sm"
            />
          ) : null}
        </label>
      ) : null}

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 text-center">{err}</div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="rounded-xl border border-slate-300 bg-white px-5 py-4 text-slate-700 font-semibold"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submitActions}
          disabled={busy || chosen.length === 0}
          className="flex-1 rounded-xl bg-emerald-600 py-4 text-lg font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-6 w-6 mx-auto animate-spin" /> : `Confirm (${chosen.length})`}
        </button>
      </div>
    </div>
  );
}

function PadKey({ children, onClick, disabled, subtle }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl py-4 text-2xl font-semibold ${
        subtle ? 'bg-slate-100 text-slate-500 hover:bg-slate-200' : 'bg-white border border-slate-200 text-slate-900 hover:bg-slate-50'
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}
