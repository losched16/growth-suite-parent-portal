'use client';

// Kiosk pickup UI. Three steps:
//   1. PIN entry (6-digit input)
//   2. Pick student + curbside slot
//   3. Sign + submit
//
// We POST { pin, student_id, signature_png, curbside_slot? } to
// /api/kiosk/{schoolId}/pickup. The server verifies the PIN, scopes
// students to the authorizing family, and records the attendance event.

import { useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { Check, RotateCcw, AlertCircle, CheckCircle2 } from 'lucide-react';

interface Student { id: string; family_id: string; name: string }
interface Slot    { value: string; label: string }

type Step = 'pin' | 'pick' | 'sign' | 'done';

export function KioskClient({
  schoolId,
  checkedInStudents,
  curbsideSlots,
}: {
  schoolId: string;
  checkedInStudents: Student[];
  curbsideSlots: Slot[];
}) {
  const [step, setStep] = useState<Step>('pin');
  const [pin, setPin] = useState('');
  const [studentId, setStudentId] = useState<string>('');
  const [curbsideSlot, setCurbsideSlot] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    pickup_person_name: string;
    student_name: string;
    curbside_slot: string | null;
  } | null>(null);
  const sigRef = useRef<SignatureCanvas | null>(null);

  function reset() {
    setStep('pin');
    setPin('');
    setStudentId('');
    setCurbsideSlot('');
    setErr(null);
    setResult(null);
    sigRef.current?.clear();
  }

  function onPinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) {
      setErr('PIN must be 4–8 digits.');
      return;
    }
    setErr(null);
    setStep('pick');
  }

  async function onFinalSubmit() {
    if (submitting) return;
    if (!studentId) {
      setErr('Pick a student.');
      return;
    }
    const sig = sigRef.current;
    if (!sig || sig.isEmpty()) {
      setErr('Please sign before submitting.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const dataUrl = sig.getCanvas().toDataURL('image/png');
      const r = await fetch(`/api/kiosk/${schoolId}/pickup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          student_id: studentId,
          signature_png: dataUrl,
          curbside_slot: curbsideSlot || undefined,
        }),
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (!r.ok) {
        throw new Error(
          typeof data.detail === 'string' ? data.detail :
          typeof data.error === 'string' ? humanizeError(data.error as string) :
          `HTTP ${r.status}`,
        );
      }
      setResult({
        pickup_person_name: data.pickup_person_name as string,
        student_name: data.student_name as string,
        curbside_slot: (data.curbside_slot as string | null) ?? null,
      });
      setStep('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record pickup.');
    } finally {
      setSubmitting(false);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Step 4 — success
  if (step === 'done' && result) {
    return (
      <section className="w-full max-w-2xl rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600 mb-3" />
        <h2 className="text-xl font-semibold text-emerald-900">Pickup recorded</h2>
        <p className="mt-1 text-sm text-emerald-800">
          <strong>{result.student_name}</strong> signed out to{' '}
          <strong>{result.pickup_person_name}</strong>
          {result.curbside_slot ? ` (curbside ${result.curbside_slot})` : ''}.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          Start another pickup
        </button>
      </section>
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  return (
    <section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
      {/* Step bar */}
      <ol className="flex items-center gap-1 text-[11px] uppercase tracking-wider mb-5">
        <StepCrumb num={1} label="PIN"     active={step === 'pin'}  done={step !== 'pin'} />
        <StepCrumb num={2} label="Student" active={step === 'pick'} done={step === 'sign'} />
        <StepCrumb num={3} label="Sign"    active={step === 'sign'} done={false} />
      </ol>

      {err ? (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" /> {err}
        </div>
      ) : null}

      {/* Step 1 — PIN */}
      {step === 'pin' ? (
        <form onSubmit={onPinSubmit} className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-800">Your PIN</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              maxLength={8}
              className="mt-1 block w-full rounded-md border-2 border-slate-300 bg-white px-4 py-3 text-2xl font-mono tabular-nums tracking-widest text-center focus:border-emerald-600 focus:outline-none"
              placeholder="••••••"
            />
          </label>
          <button
            type="submit"
            disabled={pin.length < 4}
            className="w-full rounded-md bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            Continue
          </button>
        </form>
      ) : null}

      {/* Step 2 — pick student + curbside slot */}
      {step === 'pick' ? (
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium text-slate-800 mb-2">
              Who are you picking up?
            </div>
            {checkedInStudents.length === 0 ? (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                No students are currently checked in. If you think this is wrong, ask the front desk.
              </div>
            ) : (
              <div className="space-y-1.5">
                {checkedInStudents.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-3 text-sm cursor-pointer hover:bg-slate-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40"
                  >
                    <input
                      type="radio"
                      name="student_id"
                      value={s.id}
                      checked={studentId === s.id}
                      onChange={() => setStudentId(s.id)}
                      className="h-4 w-4 text-emerald-600"
                    />
                    <span className="text-slate-900 font-medium">{s.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-500">
              We&rsquo;ll only let you sign out students from the family that authorized you.
            </p>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-800 mb-2">
              Curbside pickup time? <span className="text-slate-400 font-normal">(optional)</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCurbsideSlot('')}
                className={`rounded-md border-2 px-3 py-2 text-sm font-medium ${
                  curbsideSlot === ''
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                Not curbside
              </button>
              {curbsideSlots.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setCurbsideSlot(s.value)}
                  className={`rounded-md border-2 px-3 py-2 text-sm font-medium ${
                    curbsideSlot === s.value
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setStep('pin')}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => {
                if (!studentId) { setErr('Pick a student.'); return; }
                setErr(null);
                setStep('sign');
              }}
              disabled={!studentId}
              className="flex-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Continue to sign
            </button>
          </div>
        </div>
      ) : null}

      {/* Step 3 — sign */}
      {step === 'sign' ? (
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-800">
            Sign below to confirm pickup
          </div>
          <div className="rounded-md border-2 border-dashed border-slate-300 bg-white" style={{ touchAction: 'none' }}>
            <SignatureCanvas
              ref={(r) => { sigRef.current = r; }}
              penColor="#047857"
              canvasProps={{
                width: 600,
                height: 180,
                className: 'rounded-md',
                style: { width: '100%', height: 180, display: 'block', touchAction: 'none' },
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => sigRef.current?.clear()}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              <RotateCcw className="h-3 w-3" /> Clear
            </button>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setStep('pick')}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={onFinalSubmit}
              disabled={submitting}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {submitting ? 'Recording…' : <><Check className="h-4 w-4" /> Confirm pickup</>}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StepCrumb({ num, label, active, done }: { num: number; label: string; active: boolean; done: boolean }) {
  const cls =
    active ? 'bg-emerald-700 text-white' :
    done   ? 'bg-emerald-100 text-emerald-800' :
             'bg-slate-100 text-slate-500';
  return (
    <li className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${cls}`}>
      <span className="font-semibold">{num}</span>
      <span>{label}</span>
    </li>
  );
}

function humanizeError(code: string): string {
  switch (code) {
    case 'pin_not_recognized':         return 'PIN not recognized. Double-check with the parent.';
    case 'not_authorized_for_this_student': return 'This PIN is not authorized for that student.';
    case 'rate_limited':               return 'Too many failed attempts. Try again in a few minutes.';
    case 'invalid_pin_format':         return 'PIN must be 4–8 digits.';
    case 'student_not_found':          return 'Student not found.';
    default:                           return code;
  }
}
