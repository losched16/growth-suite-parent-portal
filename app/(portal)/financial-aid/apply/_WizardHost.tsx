'use client';

// Multi-step FA wizard host. Renders one section at a time with
// prev/next nav, autosave on blur, and a progress bar across the
// top. State lives in fa_applications.responses (JSONB) — persisted
// per step via /api/financial-aid/save-draft.

import { useState, useTransition, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Save, CheckCircle2, AlertCircle, Loader2, FileText, Sparkles, Lock, FileUp, Printer } from 'lucide-react';
import type { WizardSection, WizardField } from '@/lib/financial-aid/wizard-schema';
import { FA_DOCUMENT_CATALOG_MAP } from '@/lib/financial-aid/settings';

interface StudentLite { id: string; first_name: string; last_name: string; preferred_name: string | null }
interface ChildRow { student_id: string; current_tuition: string | null; requested_aid: string | null }
interface UploadedFile { id: string; document_type: string; original_filename: string; size_bytes: number }

export function WizardHost(props: {
  year: string;
  step: number;
  totalSteps: number;
  section: WizardSection;
  sections: WizardSection[];
  students: StudentLite[];
  childRows: ChildRow[];
  responses: Record<string, unknown>;
  requiredDocs: string[];
  docCounts: Record<string, number>;
  uploadedFiles: UploadedFile[];
  applicationId: string | null;
  hasExistingApplication: boolean;
  priorYearResponses: Record<string, unknown> | null;
  priorYear: string | null;
  locked: boolean;
  finalDecision: boolean;
  err: string | null;
  savedToast: boolean;
  currentStatus: string;
}) {
  const router = useRouter();
  type StudentInputMap = Record<string, { include: boolean; tuition: string; ask: string }>;
  const [responses, setResponses] = useState<Record<string, unknown>>(props.responses);
  const [studentInputs, setStudentInputs] = useState<StudentInputMap>(() => {
    const init: StudentInputMap = {};
    for (const s of props.students) {
      const existing = props.childRows.find((c) => c.student_id === s.id);
      init[s.id] = {
        include: !!existing,
        tuition: existing?.current_tuition ?? '',
        ask: existing?.requested_aid ?? '',
      };
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(props.err);
  const [, startTransition] = useTransition();

  function patchResponse(key: string, value: unknown) {
    setResponses((prev) => ({ ...prev, [props.section.key]: { ...(prev[props.section.key] as object || {}), [key]: value } }));
  }
  function currentSectionResponses(): Record<string, unknown> {
    return (responses[props.section.key] as Record<string, unknown>) ?? {};
  }

  async function saveCurrent(opts: { advance: boolean }): Promise<boolean> {
    setSaving(true); setErr(null);
    try {
      const r = await fetch('/api/financial-aid/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          academic_year: props.year,
          step: props.step,
          // Send the WHOLE responses object so the server has the full
          // picture (small, JSONB on the row).
          responses,
          students: Object.fromEntries(
            (Object.entries(studentInputs) as Array<[string, StudentInputMap[string]]>).map(([id, v]) => [id, { include: v.include, tuition: v.tuition || null, ask: v.ask || null }]),
          ),
          advance: opts.advance,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); setSaving(false); return false; }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
      return false;
    }
  }

  async function next() {
    const ok = await saveCurrent({ advance: true });
    setSaving(false);
    if (!ok) return;
    if (props.step < props.totalSteps) {
      startTransition(() => router.push(`/financial-aid/apply?year=${props.year}&step=${props.step + 1}&saved=1`));
    }
  }
  async function prev() {
    const ok = await saveCurrent({ advance: false });
    setSaving(false);
    if (!ok) return;
    if (props.step > 1) {
      startTransition(() => router.push(`/financial-aid/apply?year=${props.year}&step=${props.step - 1}`));
    }
  }
  async function saveAndExit() {
    const ok = await saveCurrent({ advance: false });
    setSaving(false);
    if (ok) router.push('/financial-aid?saved=1');
  }
  async function submit() {
    setSaving(true); setErr(null);
    try {
      const r = await fetch('/api/financial-aid/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          academic_year: props.year,
          step: props.step,
          responses,
          students: Object.fromEntries(
            (Object.entries(studentInputs) as Array<[string, StudentInputMap[string]]>).map(([id, v]) => [id, { include: v.include, tuition: v.tuition || null, ask: v.ask || null }]),
          ),
          submit_now: true,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); setSaving(false); return; }
      router.push('/financial-aid?submitted=1');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  function loadPriorYear() {
    if (!props.priorYearResponses) return;
    if (!confirm(`Start with your ${props.priorYear} answers as a starting point? You'll still review and update each section.`)) return;
    setResponses(props.priorYearResponses);
  }

  return (
    <div className="space-y-4">
      <Link href="/financial-aid" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-3 w-3" /> Back to Financial Aid
      </Link>

      {/* Top banner: prior-year prefill */}
      {props.priorYearResponses && Object.keys(responses).length === 0 ? (
        <div className="rounded-lg border-2 border-blue-300 bg-blue-50 px-4 py-3 flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-blue-600 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-900">Start from your {props.priorYear} answers?</p>
            <p className="text-xs text-blue-800 mt-0.5">We can pre-fill this year&rsquo;s application with what you submitted last year. You&rsquo;ll review and update each section.</p>
            <button type="button" onClick={loadPriorYear} className="mt-2 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700">
              <Sparkles className="h-3 w-3" /> Use my {props.priorYear} answers
            </button>
          </div>
        </div>
      ) : null}

      {/* Locked state */}
      {props.finalDecision ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2">
          <Lock className="h-4 w-4 mt-0.5" />
          This application has been {props.currentStatus} for the {props.year} school year and is now read-only. Contact the school if you need to make changes.
        </div>
      ) : null}

      <header className="border-b border-gray-200 pb-3">
        <h1 className="text-2xl font-semibold text-gray-900">Financial Aid — {props.year}</h1>
        <p className="mt-1 text-xs text-gray-500">Step {props.step} of {props.totalSteps} · {props.section.title}</p>
      </header>

      {/* Progress bar with clickable steps */}
      <nav className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {props.sections.map((s) => {
          const isCurrent = s.step === props.step;
          const isComplete = s.step < props.step;
          return (
            <Link
              key={s.step}
              href={`/financial-aid/apply?year=${props.year}&step=${s.step}`}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap ${
                isCurrent ? 'bg-emerald-600 text-white' :
                isComplete ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' :
                'bg-slate-100 text-slate-600'
              }`}
            >
              {isComplete ? <CheckCircle2 className="h-3 w-3" /> : <span className="font-bold">{s.step}</span>}
              <span>{s.title}</span>
            </Link>
          );
        })}
      </nav>

      {/* "Why we ask" callout */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Why we ask</p>
        <p className="text-sm text-slate-700 mt-0.5">{props.section.why}</p>
        {props.section.intro ? <p className="text-xs text-slate-600 mt-2">{props.section.intro}</p> : null}
      </div>

      {/* Saved toast */}
      {props.savedToast && !err ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" /> Your previous step was saved.
        </div>
      ) : null}

      {err ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-center gap-1">
          <AlertCircle className="h-3.5 w-3.5" /> {err}
        </div>
      ) : null}

      {/* SECTION BODY */}
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); next(); }} className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        {props.section.key === 'students' ? (
          <StudentsStep
            students={props.students}
            inputs={studentInputs}
            onChange={setStudentInputs}
            locked={props.locked}
          />
        ) : props.section.key === 'final' ? (
          <FinalStep
            fields={props.section.fields}
            values={currentSectionResponses()}
            patch={patchResponse}
            requiredDocs={props.requiredDocs}
            applicationId={props.applicationId}
            initialFiles={props.uploadedFiles}
            locked={props.locked}
          />
        ) : (
          <GenericFields
            fields={props.section.fields}
            values={currentSectionResponses()}
            patch={patchResponse}
            locked={props.locked}
          />
        )}

        {/* Optional explanation textarea */}
        {props.section.optionalExplanationKey ? (
          <label className="block">
            <span className="text-sm font-medium text-gray-800">Anything else about this section? (optional)</span>
            <textarea
              rows={2}
              value={String(currentSectionResponses()[props.section.optionalExplanationKey] ?? '')}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patchResponse(props.section.optionalExplanationKey!, e.target.value)}
              disabled={props.locked}
              placeholder="Use this space to clarify any answers in this section."
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none disabled:bg-gray-100"
            />
          </label>
        ) : null}

        {/* Nav buttons */}
        <div className="flex items-center justify-between gap-2 pt-4 border-t border-gray-100 flex-wrap">
          <div className="flex items-center gap-2">
            {props.step > 1 ? (
              <button type="button" onClick={prev} disabled={saving} className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                <ArrowLeft className="h-3.5 w-3.5" /> Previous
              </button>
            ) : null}
            <button type="button" onClick={saveAndExit} disabled={saving || props.locked} className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save & continue later
            </button>
          </div>
          <div className="flex items-center gap-2">
            {props.step < props.totalSteps ? (
              <button type="submit" disabled={saving || props.locked} className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Next <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={saving || props.locked} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                Submit application
              </button>
            )}
          </div>
        </div>

        {/* Worksheet PDF link */}
        <div className="text-center pt-3 border-t border-gray-50">
          <a href="/api/financial-aid/worksheet" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800">
            <Printer className="h-3 w-3" /> Print blank worksheet to gather info offline first
          </a>
        </div>
      </form>
    </div>
  );
}

// ── Generic field renderer ──────────────────────────────────────────
function GenericFields({
  fields, values, patch, locked,
}: {
  fields: WizardField[];
  values: Record<string, unknown>;
  patch: (key: string, value: unknown) => void;
  locked: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {fields.map((f) => {
        // Group + long_text fields always span full width regardless
        // of their `width` hint — they're never readable in half.
        const isFullWidth = f.width === 'full' || f.type === 'group' || f.type === 'long_text';
        return (
          <div key={f.key} className={isFullWidth ? 'sm:col-span-2' : ''}>
            <FieldRenderer field={f} value={values[f.key]} onChange={(v) => patch(f.key, v)} locked={locked} />
          </div>
        );
      })}
    </div>
  );
}

function FieldRenderer({ field, value, onChange, locked }: { field: WizardField; value: unknown; onChange: (v: unknown) => void; locked: boolean }) {
  const Label = (
    <div className="mb-1">
      <label className="text-sm font-medium text-gray-800">
        {field.label} {field.required ? <span className="text-rose-600">*</span> : null}
      </label>
      {field.help ? <p className="text-[11px] text-gray-500 mt-0.5">{field.help}</p> : null}
    </div>
  );
  if (field.type === 'short_text') {
    return (
      <div>
        {Label}
        <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} disabled={locked} className={inputCls} />
      </div>
    );
  }
  if (field.type === 'long_text') {
    return (
      <div>
        {Label}
        <textarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} disabled={locked} className={inputCls} />
      </div>
    );
  }
  if (field.type === 'number') {
    return (
      <div>
        {Label}
        <input type="number" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} disabled={locked} className={inputCls} />
      </div>
    );
  }
  if (field.type === 'money') {
    return (
      <div>
        {Label}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">$</span>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? '0.00'} disabled={locked} className={`${inputCls} pl-7`} />
        </div>
      </div>
    );
  }
  if (field.type === 'yes_no') {
    return (
      <div>
        {Label}
        <div className="flex items-center gap-3">
          {['yes', 'no', 'unsure'].map((opt) => (
            <label key={opt} className="flex items-center gap-1 text-sm">
              <input type="radio" name={field.key} value={opt} checked={value === opt} onChange={() => onChange(opt)} disabled={locked} className="h-4 w-4" />
              <span className="capitalize">{opt === 'unsure' ? 'Not sure' : opt}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (field.type === 'select') {
    return (
      <div>
        {Label}
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={locked} className={inputCls}>
          <option value="">— Pick one —</option>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  }
  if (field.type === 'date') {
    return (
      <div>
        {Label}
        <input type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={locked} className={inputCls} />
      </div>
    );
  }
  if (field.type === 'group') {
    return (
      <GroupField field={field} value={Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []} onChange={(v) => onChange(v)} locked={locked} />
    );
  }
  return null;
}

// ── Repeatable group ────────────────────────────────────────────────
// Renders a stack of "card" sub-forms. Each card contains the field's
// `groupFields`. Parent provides Add / Remove buttons bounded by
// groupMinCount / groupMaxCount.
function GroupField({
  field, value, onChange, locked,
}: {
  field: WizardField;
  value: Array<Record<string, unknown>>;
  onChange: (next: Array<Record<string, unknown>>) => void;
  locked: boolean;
}) {
  const minCount = field.groupMinCount ?? 0;
  const maxCount = field.groupMaxCount ?? 6;
  const groupFields = field.groupFields ?? [];

  // Pad to minCount on first render so required cards exist.
  const list = value.length < minCount
    ? [...value, ...Array(minCount - value.length).fill(0).map(() => ({}))]
    : value;

  function patchCard(idx: number, k: string, v: unknown) {
    const next = list.map((card, i) => i === idx ? { ...card, [k]: v } : card);
    onChange(next);
  }
  function removeCard(idx: number) {
    if (list.length <= minCount) return;
    const next = list.filter((_, i) => i !== idx);
    onChange(next);
  }
  function addCard() {
    if (list.length >= maxCount) return;
    onChange([...list, {}]);
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-gray-800">
          {field.label} {field.required ? <span className="text-rose-600">*</span> : null}
        </label>
        {field.help ? <p className="text-[11px] text-gray-500 mt-0.5">{field.help}</p> : null}
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-gray-500 italic">None added. Skip this step entirely if there are none.</p>
      ) : null}
      <div className="space-y-3">
        {list.map((card, idx) => (
          <div key={idx} className="rounded-md border border-gray-200 bg-gray-50/40 p-3">
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-xs font-semibold text-gray-700">
                {field.groupSingularLabel ?? 'Entry'} #{idx + 1}
              </div>
              {list.length > minCount ? (
                <button type="button" onClick={() => removeCard(idx)} disabled={locked} className="text-[11px] text-rose-600 hover:text-rose-800 underline disabled:opacity-50">
                  Remove
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {groupFields.map((sub) => (
                <div key={sub.key} className={sub.width === 'full' ? 'sm:col-span-2' : ''}>
                  <FieldRenderer field={sub} value={(card as Record<string, unknown>)[sub.key]} onChange={(v) => patchCard(idx, sub.key, v)} locked={locked} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {list.length < maxCount ? (
        <button type="button" onClick={addCard} disabled={locked} className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
          + Add another {(field.groupSingularLabel ?? 'entry').toLowerCase()}
        </button>
      ) : (
        <p className="text-[11px] text-gray-500 italic">Maximum of {maxCount} reached.</p>
      )}
    </div>
  );
}

// ── Step 2: Students ─────────────────────────────────────────────────
function StudentsStep({
  students, inputs, onChange, locked,
}: {
  students: StudentLite[];
  inputs: Record<string, { include: boolean; tuition: string; ask: string }>;
  onChange: (next: Record<string, { include: boolean; tuition: string; ask: string }>) => void;
  locked: boolean;
}) {
  function patch(id: string, key: 'include' | 'tuition' | 'ask', v: string | boolean) {
    onChange({ ...inputs, [id]: { ...inputs[id], [key]: v as never } });
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">Check each child attending this school for the year you&rsquo;re applying. Enter the tuition you&rsquo;re being charged and how much aid you&rsquo;re requesting per student.</p>
      <ul className="space-y-3">
        {students.map((s) => {
          const v = inputs[s.id];
          const name = s.preferred_name?.trim() || s.first_name;
          return (
            <li key={s.id} className="rounded-md border border-gray-200 bg-white p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
                <input type="checkbox" checked={v.include} onChange={(e) => patch(s.id, 'include', e.target.checked)} disabled={locked} className="h-4 w-4" />
                {name} {s.last_name}
              </label>
              {v.include ? (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-gray-600">Current tuition for this student</span>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">$</span>
                      <input type="number" min="0" step="0.01" value={v.tuition} onChange={(e) => patch(s.id, 'tuition', e.target.value)} disabled={locked} className={`${inputCls} pl-7`} />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-gray-600">Aid requested for this student</span>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">$</span>
                      <input type="number" min="0" step="0.01" value={v.ask} onChange={(e) => patch(s.id, 'ask', e.target.value)} disabled={locked} className={`${inputCls} pl-7`} />
                    </div>
                  </label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Step 7: Final + interactive doc checklist ───────────────────────
function FinalStep({
  fields, values, patch, requiredDocs, applicationId, initialFiles, locked,
}: {
  fields: WizardField[];
  values: Record<string, unknown>;
  patch: (key: string, value: unknown) => void;
  requiredDocs: string[];
  applicationId: string | null;
  initialFiles: UploadedFile[];
  locked: boolean;
}) {
  // Local file state so uploads + deletes feel immediate. We refresh
  // from /api/financial-aid/upload-doc?application_id=… after every
  // change to stay consistent with the server.
  const [files, setFiles] = useState<UploadedFile[]>(initialFiles);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [otherType, setOtherType] = useState<string>('other');
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!applicationId) return;
    const r = await fetch(`/api/financial-aid/upload-doc?application_id=${applicationId}`);
    const j = await r.json();
    if (r.ok && Array.isArray(j.files)) setFiles(j.files);
  }

  async function upload(documentType: string, file: File) {
    if (!applicationId) return;
    setUploadingType(documentType); setErr(null);
    try {
      const fd = new FormData();
      fd.set('application_id', applicationId);
      fd.set('document_type', documentType);
      fd.set('file', file);
      const r = await fetch('/api/financial-aid/upload-doc', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `Upload failed (${r.status})`); return; }
      await refresh();
    } finally {
      setUploadingType(null);
    }
  }

  async function remove(fileId: string) {
    if (!confirm('Delete this file? You can re-upload if you change your mind.')) return;
    const r = await fetch(`/api/financial-aid/upload-doc?file_id=${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (r.ok) await refresh();
  }

  const filesByType = files.reduce<Record<string, UploadedFile[]>>((acc, f) => {
    (acc[f.document_type] ??= []).push(f); return acc;
  }, {});

  // "Other supporting docs" — everything not in the required list.
  const requiredSet = new Set(requiredDocs);
  const otherFiles = files.filter((f) => !requiredSet.has(f.document_type));

  return (
    <div className="space-y-5">
      <GenericFields fields={fields} values={values} patch={patch} locked={locked} />

      {requiredDocs.length > 0 ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4">
          <h3 className="text-sm font-semibold text-blue-900 flex items-center gap-1">
            <FileUp className="h-4 w-4" /> Required documents
          </h3>
          <p className="text-[11px] text-blue-800 mt-0.5 mb-3">
            Upload each item directly here. PDF or image (JPG / PNG / HEIC), up to 10MB per file. You can upload more than one file per category if needed.
          </p>
          {!applicationId ? (
            <p className="text-xs text-amber-800 italic">Save the wizard once first (next or prev), then upload here.</p>
          ) : (
            <ul className="space-y-2">
              {requiredDocs.map((k) => {
                const d = FA_DOCUMENT_CATALOG_MAP[k];
                if (!d) return null;
                const uploaded = filesByType[k] ?? [];
                const done = uploaded.length > 0;
                return (
                  <li key={k} className={`rounded px-3 py-2 ${done ? 'bg-emerald-50 border border-emerald-200' : 'bg-white border border-amber-200'}`}>
                    <div className="flex items-start gap-2">
                      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-700 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-slate-900">{d.label}</div>
                        <div className="text-[11px] text-slate-600">{d.hint}</div>
                      </div>
                      <label className="inline-flex items-center gap-1 rounded border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 cursor-pointer">
                        {uploadingType === k ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileUp className="h-3 w-3" />}
                        {done ? 'Add another' : 'Upload'}
                        <input
                          type="file"
                          accept="application/pdf,image/*,.heic,.heif"
                          className="hidden"
                          disabled={locked || !!uploadingType}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) upload(k, f);
                            e.target.value = '';   // allow re-selecting the same file
                          }}
                        />
                      </label>
                    </div>
                    {uploaded.length > 0 ? (
                      <ul className="mt-2 pl-6 space-y-1">
                        {uploaded.map((f) => (
                          <li key={f.id} className="flex items-center gap-2 text-[11px] text-slate-700">
                            <FileText className="h-3 w-3 text-slate-400" />
                            <span className="flex-1 truncate">{f.original_filename}</span>
                            <span className="text-slate-400">{fmtBytes(f.size_bytes)}</span>
                            <button type="button" onClick={() => remove(f.id)} disabled={locked} className="text-rose-600 hover:text-rose-800 hover:underline disabled:opacity-50">delete</button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {/* Other supporting docs — anything beyond the required list */}
      {applicationId ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1">
            <FileUp className="h-4 w-4" /> Other supporting documents (optional)
          </h3>
          <p className="text-[11px] text-slate-600 mt-0.5 mb-2">
            Anything else the committee should see. Pick a category, then upload.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={otherType}
              onChange={(e) => setOtherType(e.target.value)}
              disabled={locked}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              {Object.entries(FA_DOCUMENT_CATALOG_MAP).map(([k, d]) => (
                <option key={k} value={k}>{d.label}</option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1 rounded border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 cursor-pointer">
              {uploadingType === otherType ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileUp className="h-3 w-3" />}
              Upload
              <input
                type="file"
                accept="application/pdf,image/*,.heic,.heif"
                className="hidden"
                disabled={locked || !!uploadingType}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(otherType, f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {otherFiles.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {otherFiles.map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-[11px] text-slate-700 rounded bg-slate-50 px-2 py-1">
                  <FileText className="h-3 w-3 text-slate-400" />
                  <span className="text-slate-500 text-[10px] uppercase tracking-wide">{f.document_type.replace(/_/g, ' ')}</span>
                  <span className="flex-1 truncate">{f.original_filename}</span>
                  <span className="text-slate-400">{fmtBytes(f.size_bytes)}</span>
                  <button type="button" onClick={() => remove(f.id)} disabled={locked} className="text-rose-600 hover:text-rose-800 hover:underline disabled:opacity-50">delete</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {err ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {err}
        </div>
      ) : null}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const inputCls = 'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none disabled:bg-gray-100';
