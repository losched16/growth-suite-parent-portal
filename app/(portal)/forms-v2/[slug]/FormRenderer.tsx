'use client';

// Dynamic form renderer. Takes a FormDefinition + prefill context +
// optional student picker (for per_student forms) and renders the
// appropriate inputs. Submits to /api/portal-forms/submit.
//
// Also handles two migration-related UX states:
//   1) "Complete via legacy form" lock-state per student (or per family)
//      — shown when a legacy_imported submission exists. User can click
//      "Update my answers" to override and re-submit.
//   2) Migration flag banner — shown at the top with kind-specific copy
//      for each open flag on this family/form. Includes the 1-tap
//      emergency-contacts-per-student confirm flow.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Check, AlertCircle, CheckCircle2, FileText, Edit3, CreditCard, Minus, Plus } from 'lucide-react';
import type { FormDefinition, FormFieldBlock, PrefillSource } from '@/lib/forms/types';
import { resolvePrefill, isBlockVisible, type PrefillContext } from '@/lib/forms/prefill';
import { PaymentMethodGate } from './PaymentMethodGate';
import { evaluatePayment } from '@/lib/forms/payment-eval';
import { fmtCents } from '@/lib/billing/fee-math';

interface StudentOption {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  // Per-student admission date — feeds the student.date_of_admission
  // prefill source. May be null when school hasn't set it yet (the
  // DHS Agreement field falls back to letting the parent type it in).
  date_of_admission?: string | null;
  // Full metadata bag — powers `meta:<key>` prefill sources.
  metadata?: Record<string, unknown> | null;
}

export interface ExistingSubmission {
  id: string;
  submitted_at: string;
  status: 'submitted' | 'paid' | 'pending_payment' | 'legacy_imported';
  is_legacy: boolean;
  // The submission's responses jsonb. Used to pre-fill form fields when
  // the parent clicks "Update my answers" on a legacy or previous
  // submission. Keys map to field_schema keys.
  responses: Record<string, unknown>;
  // Addendum metadata. is_addendum=true means this row is a partial
  // update of parent_submission_id, touching only addendum_fields.
  is_addendum: boolean;
  parent_submission_id: string | null;
  addendum_fields: string[] | null;
  // Who submitted it. Used to surface a "your co-parent last filled
  // this out — you're about to overwrite their answers" warning. Null
  // for legacy / system-imported rows.
  submitter_parent_id: string | null;
  submitter_name: string | null;
}

export interface MigrationFlag {
  id: string;
  kind: string;
  message: string;
  payload: Record<string, unknown>;
}

interface Props {
  definition: FormDefinition;
  students: StudentOption[];                          // per-student forms only
  parent: PrefillContext['parent'];
  // Family guardians (primary + co-parent), GHL-synced. Powers live ea_pg1_*/
  // ea_pg2_* prefill for brand-new families with no frozen ea_* snapshot.
  guardians?: PrefillContext['guardians'];
  // Logged-in parent's id, used to detect "the OTHER parent in my
  // family submitted this last" → show a co-parent-overwrite warning.
  currentParentId: string;
  healthByStudentId: Record<string, PrefillContext['health']>;
  // Per-student active enrollment data. Populates enrollment.* prefill
  // sources (program, plan, amounts, due dates) on the Tuition Agreement
  // form (and any other form that opts into them). Empty record when
  // the family has no active enrollments on file.
  enrollmentByStudentId?: Record<string, PrefillContext['enrollment']>;
  existingByStudentId: Record<string, ExistingSubmission[]>;
  familyExisting: ExistingSubmission[];               // family-level forms
  flagsByStudentId: Record<string, MigrationFlag[]>;
  familyFlags: MigrationFlag[];
  // Family-level emergency contact #1 pulled from the most-recent emergency-
  // medical submission. Used by the 1-tap "Same for this child" widget when
  // an emergency_contacts_per_student_review flag is active.
  familyEmergencyContact: { name: string; phone: string; relationship: string } | null;
  // Operator-initiated invite context. When present, the form pre-fills
  // the listed fields with the operator's values, locks the student
  // selector to the targeted student, and remembers the invite id so
  // submit can mark it consumed.
  inviteContext?: {
    id: string;
    prefill: Record<string, string>;
    studentId: string | null;
  } | null;
  // Students who already have an active tuition plan. For these the
  // agreement is review-and-sign (locked fields, no calculator/billing);
  // students NOT in this list are brand-new families who get editable
  // fields + the live tuition calculator. Mirrors the submit guardrail.
  existingPlanStudentIds?: string[];
  // Whether the school's billing is live. In dry-run the new-family
  // calculator still shows, but the submit button doesn't promise payment.
  billingActive?: boolean;
  // Card-on-file gate (enrollment agreement). When the form's payment_config
  // sets require_payment_method_on_file, submission is blocked until a card is
  // saved. These seed/enable that gate.
  hasPaymentMethodOnFile?: boolean;
  cardEnabled?: boolean;
  achEnabled?: boolean;
  // Student ids whose enrollment fee is already paid (FACTS ledger import or
  // a paid Growth Suite invoice). The payment schedule shows "Paid" for these
  // instead of a future charge.
  enrollmentFeePaidStudentIds?: string[];
  // When set, a SUBMITTED form that can't be re-edited (resubmission_allowed
  // = false) tells the parent to email this address for a change instead of
  // showing an "Update my answers" button. DGM: admissions@ — the school
  // pushes an amendment rather than letting parents self-edit the enrollment.
  changeRequestEmail?: string | null;
}

export function FormRenderer({
  definition, students, parent, guardians, currentParentId, healthByStudentId,
  enrollmentByStudentId,
  existingByStudentId, familyExisting,
  flagsByStudentId, familyFlags,
  familyEmergencyContact,
  inviteContext,
  existingPlanStudentIds,
  billingActive,
  hasPaymentMethodOnFile,
  cardEnabled,
  achEnabled,
  enrollmentFeePaidStudentIds,
  changeRequestEmail,
}: Props) {
  const router = useRouter();
  // If we have an operator invite that targets a specific student, the
  // student picker is locked to that child. Otherwise, prefer to land on
  // the first student WITHOUT any submission on file — the one who still
  // needs the form. Without this, parents like Rachel landed on the
  // already-submitted student and had to manually flip to the empty one.
  const firstEmptyStudent = students.find(
    (s) => !(existingByStudentId[s.id] ?? []).length,
  );
  const initialStudentId =
    inviteContext?.studentId
    ?? firstEmptyStudent?.id
    ?? students[0]?.id
    ?? '';
  const [studentId, setStudentId] = useState<string>(initialStudentId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Keys of required fields flagged empty on the last submit attempt, so we can
  // highlight each one inline (in red) instead of only naming them in a banner.
  const [missingFields, setMissingFields] = useState<Set<string>>(new Set());
  // Per-student: which students has the parent explicitly chosen to
  // "update my answers" for? Until this is set, a legacy-complete student
  // shows the lock state instead of the form fields.
  const [updateModeStudents, setUpdateModeStudents] = useState<Set<string>>(new Set());
  // Family-level forms: same idea but a single boolean.
  const [familyUpdateMode, setFamilyUpdateMode] = useState(false);

  // Addendum mode: parent picks specific fields to update on an existing
  // submission instead of re-doing the whole form. Three states:
  //   off      → CTA banner shown (if applicable); form renders normally
  //   picking  → field-picker UI replaces the form body
  //   editing  → form renders ONLY the picked fields + signature
  const [addendumMode, setAddendumMode] = useState<'off' | 'picking' | 'editing'>('off');
  const [addendumFields, setAddendumFields] = useState<Set<string>>(new Set());

  // Live responses snapshot — used to drive the running payment total.
  // Populated by onChange on the form element from FormData. We keep
  // inputs uncontrolled (defaultValue) so existing fields don't change
  // behavior; pricing fields read from this state for live updates.
  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const refreshResponses = useCallback(() => {
    // Defer to next tick so React's state updates from nested
    // controlled components (like TuitionCalculator's internal addon
    // state, which writes into a hidden input value) have flushed to
    // the DOM before we read FormData. Without this, clicking an addon
    // checkbox snapshots the OLD hidden-input value and the live total
    // appears stale until the next interaction.
    setTimeout(() => {
      if (!formRef.current) return;
      const fd = new FormData(formRef.current);
      const next: Record<string, unknown> = {};
      for (const block of definition.field_schema) {
        if (!('key' in block)) continue;
        if (block.type === 'multi_checkbox' || block.type === 'multi_pricing') {
          next[block.key] = fd.getAll(`${block.key}[]`).map(String);
        } else {
          const v = fd.get(block.key);
          next[block.key] = v == null ? '' : String(v);
        }
      }
      setResponses(next);
      // Clear the "required" highlight from any flagged field the parent has
      // now filled in, so the red ring disappears as they fix each one.
      setMissingFields((prev) => {
        if (prev.size === 0) return prev;
        const still = new Set(
          [...prev].filter((k) => {
            const v = next[k];
            return v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
          }),
        );
        return still.size === prev.size ? prev : still;
      });
    }, 0);
  }, [definition.field_schema]);

  const selectedStudent = useMemo(
    () => students.find((s) => s.id === studentId),
    [students, studentId],
  );

  // Existing/imported family (already has a tuition plan) → review-and-sign:
  // fields stay locked, no calculator, no billing. A brand-new family (no
  // plan) gets editable fields + the live tuition calculator. Matches the
  // server-side guardrail exactly so display and billing never disagree.
  const isExistingFamily = !!selectedStudent
    && (existingPlanStudentIds ?? []).includes(selectedStudent.id);

  // Only NEW families see the payment engine. The button only promises
  // payment when billing is actually live (in dry-run a new family's plan
  // is created as drafts with no charge). `display_only` forms collect NO
  // payment at all — they still show the schedule (below) but submit like a
  // normal form, so they're excluded from the payment engine here.
  const paymentConfigured = !!definition.payment_config
    && !isExistingFamily
    && definition.payment_config?.display_only !== true;
  const paymentRequired = paymentConfigured
    && definition.payment_config?.mode === 'required'
    && (billingActive ?? false);
  const liveEval = useMemo(
    () => paymentConfigured ? evaluatePayment(definition, responses) : null,
    [definition, responses, paymentConfigured],
  );

  // Payment schedule — computed whenever the form has a payment config,
  // INDEPENDENT of whether billing is live, because showing the schedule does
  // not charge anyone. Lets parents see exactly when each installment is due
  // before they leave a card on file.
  const hasPayCfg = !!(definition.payment_config && definition.payment_config.lines?.length);
  const scheduleEval = useMemo(
    () => (hasPayCfg ? evaluatePayment(definition, responses) : null),
    [definition, responses, hasPayCfg],
  );
  // Installment (enrollment) flow — a payment plan is chosen, so NOTHING is
  // charged at submit; tuition autopays per the schedule. Drives the submit
  // button copy so it never implies a lump-sum payment now.
  const hasInstallmentPlan = ['monthly', 'semi_annual', 'annual']
    .includes(String(responses['payment_plan'] ?? ''));
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>([]);
  useEffect(() => {
    if (!hasPayCfg) return;
    fetch('/api/billing/tuition-grids?include_plans=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.plans) setPlanTemplates(d.plans as PlanTemplate[]); })
      .catch(() => { /* schedule simply won't render */ });
  }, [hasPayCfg]);
  const scheduleYear = definition.slug.match(/(\d{4}-\d{2})/)?.[1] ?? currentAcademicYear();

  // Card-on-file gate: when the form requires a saved payment method, block
  // submit until one exists. Seeded from the server check; flipped true when
  // the parent saves a card inline, or returns from a 3-D Secure redirect
  // (?pm_added=1). Keyed off the client confirm — never the webhook — so a
  // broken webhook can't trap a parent who has saved a card.
  const requireMethod = definition.payment_config?.require_payment_method_on_file === true
    && definition.payment_config?.display_only !== true;
  const [methodOnFile, setMethodOnFile] = useState<boolean>(!!hasPaymentMethodOnFile);
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pm_added') === '1') {
      setMethodOnFile(true);
    }
  }, []);

  const prefillCtx: PrefillContext = useMemo(() => ({
    parent,
    guardians,
    student: selectedStudent
      ? {
          first_name: selectedStudent.first_name,
          last_name: selectedStudent.last_name,
          preferred_name: selectedStudent.preferred_name,
          date_of_birth: selectedStudent.date_of_birth,
          date_of_admission: selectedStudent.date_of_admission ?? null,
          metadata: selectedStudent.metadata ?? null,
        }
      : undefined,
    health: selectedStudent ? healthByStudentId[selectedStudent.id] : undefined,
    enrollment: selectedStudent ? enrollmentByStudentId?.[selectedStudent.id] : undefined,
  }), [parent, guardians, selectedStudent, healthByStudentId, enrollmentByStudentId]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    // Co-parent overwrite confirmation. If the most recent submission
    // was made by a co-parent (not the current parent), block the
    // submit until they explicitly acknowledge the overwrite. Plain
    // window.confirm to keep this lightweight — no extra dependency.
    const submittedByCoParent = !!(
      latest
      && !latest.is_legacy
      && latest.submitter_parent_id
      && latest.submitter_parent_id !== currentParentId
    );
    if (submittedByCoParent) {
      const who = latest!.submitter_name ?? 'the other parent';
      const ok = window.confirm(
        `${who} last filled out this form on ${fmtDate(latest!.submitted_at)}.\n\n`
        + `Submitting will overwrite their answers with yours. Continue?`,
      );
      if (!ok) return;
    }

    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData(e.currentTarget);
      fd.set('form_definition_id', definition.id);
      if (definition.per_student && studentId) fd.set('student_id', studentId);

      // Comprehensive client-side required-field validation. Native HTML
      // validation doesn't cover our custom components (pricing selects,
      // signatures, multi-checkbox) or conditionally-shown fields, which
      // let a parent submit an incomplete form — and an incomplete payment
      // form makes the server's billing/proration choke and the request
      // hang. We check every VISIBLE required block against the submitted
      // FormData and stop with a clear, named notification.
      const blocksToShow = definition.field_schema.filter((block) => {
        if (addendumMode !== 'editing') return true;
        if (!('key' in block)) return true;
        if (block.type === 'signature_drawn' || block.type === 'signature_typed') return true;
        return addendumFields.has(block.key);
      });
      // Snapshot of submitted values for conditional-visibility checks
      // (so we never flag a field that's hidden by visible_when).
      const fdValues: Record<string, unknown> = {};
      for (const k of new Set([...fd.keys()])) {
        fdValues[k.endsWith('[]') ? k.slice(0, -2) : k] = k.endsWith('[]') ? fd.getAll(k) : fd.get(k);
      }
      const missing: Array<{ key: string; label: string }> = [];
      for (const block of blocksToShow) {
        if (!('key' in block) || !('required' in block) || !block.required) continue;
        const vw = 'visible_when' in block ? block.visible_when : undefined;
        if (!isBlockVisible(vw, fdValues)) continue; // hidden → not required
        const key = block.key;
        const single = fd.get(key);
        const hasSingle = typeof single === 'string' ? single.trim() !== '' : single != null;
        const hasMulti = fd.getAll(`${key}[]`).length > 0;
        if (!hasSingle && !hasMulti) {
          missing.push({ key, label: ('label' in block && block.label) ? String(block.label) : key });
        }
      }
      if (missing.length > 0) {
        setMissingFields(new Set(missing.map((m) => m.key)));
        setErr(
          `${missing.length} required field${missing.length === 1 ? '' : 's'} still ${missing.length === 1 ? 'needs' : 'need'} an answer — ${missing.length === 1 ? "it's" : "they're"} highlighted in red below.`,
        );
        setBusy(false);
        const first = missing[0].key;
        const el = formRef.current
          ?.querySelector(`[name="${first}"], [name="${first}[]"]`)
          ?.closest('label, fieldset, div');
        if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      setMissingFields(new Set());

      // Hard timeout so a slow/stuck server can never leave the parent
      // staring at an infinite "Submitting…" spinner. 90s is far longer
      // than a healthy submit (incl. invoice generation) ever needs.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      let r: Response;
      try {
        r = await fetch('/api/portal-forms/submit', { method: 'POST', body: fd, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        // Try to read a structured JSON error so we can show the
        // server's validation detail to the parent — much more useful
        // than dumping the raw response body.
        let friendly = 'Could not save. Please review the form and try again.';
        try {
          const body = await r.json();
          if (body && typeof body === 'object') {
            if (Array.isArray((body as { detail?: unknown }).detail)) {
              friendly = ((body as { detail: string[] }).detail).join(' · ');
            } else if (typeof (body as { detail?: unknown }).detail === 'string') {
              friendly = String((body as { detail: string }).detail);
            } else if (typeof (body as { error?: unknown }).error === 'string') {
              friendly = String((body as { error: string }).error).replace(/_/g, ' ');
            }
          }
        } catch {
          // Body wasn't JSON; fall back to the generic message.
        }
        throw new Error(friendly);
      }
      // For payment-required forms, the server returns JSON with the
      // invoice id to redirect to. For all other forms we land on the
      // thanks page (which renders the school's custom confirmation
      // message + optional auto-redirect URL, falling back to a default
      // "Submitted" message when neither is configured).
      const ct = r.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const body = await r.json().catch(() => ({} as Record<string, unknown>));
        if (typeof body.redirect_to_invoice_id === 'string') {
          const returnTo = `/forms-v2/thanks/${encodeURIComponent(String(body.id ?? ''))}`;
          router.push(`/billing/pay/${body.redirect_to_invoice_id}?return_to=${encodeURIComponent(returnTo)}`);
          return;
        }
        // Successful non-payment submission. The submit endpoint
        // returns the new submission id; the thanks page resolves the
        // school's confirmation_message + redirect_url from it.
        if (typeof body.id === 'string' && body.id.length > 0) {
          router.push(`/forms-v2/thanks/${encodeURIComponent(body.id)}`);
          return;
        }
      }
      router.push('/forms-v2/history?submitted=' + encodeURIComponent(definition.slug));
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError'
        ? 'The server took too long to respond, so your form was NOT submitted. Please check your connection and try again.'
        : (e instanceof Error ? e.message : 'Submission failed');
      setErr(msg);
      setBusy(false);
    }
  }

  // What does the current selection (or the family) have on file?
  const relevantExisting: ExistingSubmission[] = definition.per_student
    ? (existingByStudentId[studentId] ?? [])
    : familyExisting;
  const latest = relevantExisting[0];
  const hasLegacy = relevantExisting.some((s) => s.is_legacy);
  const hasNative = relevantExisting.some((s) => !s.is_legacy);

  // For addendum support: the "parent" submission is the most recent
  // native, non-addendum submission. Addendums chain off of it.
  const parentSubmission = relevantExisting.find(
    (s) => !s.is_legacy && !s.is_addendum,
  ) ?? null;
  const addendumOfferable = !!definition.allow_addendum
    && !!parentSubmission
    && addendumMode === 'off';

  // Should we show the lock state instead of the form?
  //
  // Yes when there's ANY prior submission (legacy OR native) AND the
  // user hasn't clicked "Update my answers" yet. Without the
  // hasNative branch, a parent who already submitted natively would
  // re-open the form to a blank canvas, retype everything, and
  // accidentally create a duplicate submission — Rachel's exact
  // experience on May 18 in Wooster testing. With the lock state
  // showing for natives too, they get a "you already submitted on X,
  // click to update" interstitial that pre-fills on click.
  const inUpdateMode = definition.per_student
    ? updateModeStudents.has(studentId)
    : familyUpdateMode;
  // Forms that allow multiple independent submissions (e.g. Medication
  // Authorization — one per medication) never lock: the parent always gets
  // a fresh blank form to file another, and prior submissions are kept.
  const allowMultiple = definition.allow_multiple_submissions;
  const showLockState = (hasLegacy || hasNative) && !inUpdateMode && !allowMultiple;

  // Active flags for the current view
  const activeFlags: MigrationFlag[] = definition.per_student
    ? [...(flagsByStudentId[studentId] ?? []), ...familyFlags]
    : familyFlags;

  // Format date helper
  function fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function startUpdateMode() {
    if (definition.per_student) {
      const next = new Set(updateModeStudents);
      next.add(studentId);
      setUpdateModeStudents(next);
    } else {
      setFamilyUpdateMode(true);
    }
  }

  // First-mount snapshot so the live total reflects default values
  // (e.g. a pre-checked checkbox or a pricing select default) before
  // the user changes anything.
  useEffect(() => {
    refreshResponses();
    // Re-run when the student changes too — defaults can reference
    // student-scoped fields and refresh affects layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onChange={refreshResponses}
      // Disable the browser's native one-field-at-a-time validation so our
      // own comprehensive check runs: it understands custom components
      // (pricing selects, signatures) and conditional visibility, lists
      // EVERY missing required field at once, and scrolls to the first.
      noValidate
      className="space-y-5"
    >
      {/* Operator-invite banner — surfaces when the parent landed here
          via a magic link from the admissions office. */}
      {inviteContext ? (
        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-3 text-sm">
          <div className="font-semibold text-emerald-900">
            👋 Welcome — your enrollment is started
          </div>
          <p className="mt-1 text-xs text-emerald-800">
            The admissions team has pre-filled
            {Object.keys(inviteContext.prefill).length > 0
              ? ` ${Object.keys(inviteContext.prefill).length} field${Object.keys(inviteContext.prefill).length === 1 ? '' : 's'} for you. `
              : ' some details for you. '}
            Please review, complete the rest of the form, sign, and submit. You can edit
            any pre-filled value if it's incorrect.
          </p>
        </div>
      ) : null}

      {/* Per-student picker with completion badges */}
      {definition.per_student && students.length > 0 ? (
        <fieldset className="rounded-lg border border-gray-200 bg-white p-4">
          <legend className="px-1 text-sm font-semibold text-gray-900">For which student?</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {students.map((s) => {
              const subs = existingByStudentId[s.id] ?? [];
              const sLegacy = subs.some((x) => x.is_legacy);
              const sNative = subs.some((x) => !x.is_legacy);
              const sFlags = flagsByStudentId[s.id]?.length ?? 0;
              return (
                <label
                  key={s.id}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer ${
                    studentId === s.id
                      ? 'border-emerald-600 bg-emerald-50'
                      : 'border-gray-300 bg-white hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="_student_picker"
                    value={s.id}
                    checked={studentId === s.id}
                    onChange={() => setStudentId(s.id)}
                    className="h-4 w-4 text-emerald-600"
                  />
                  <span className="text-sm font-medium text-gray-900">
                    {s.preferred_name || s.first_name} {s.last_name}
                  </span>
                  {sNative ? (
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                      <CheckCircle2 className="h-3 w-3" /> done
                    </span>
                  ) : sLegacy ? (
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                      <FileText className="h-3 w-3" /> legacy
                    </span>
                  ) : null}
                  {sFlags > 0 ? (
                    <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800" title={`${sFlags} item(s) to review`}>
                      ⚠ {sFlags}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {/* Migration flag banners */}
      {activeFlags.length > 0 ? (
        <div className="space-y-2">
          {activeFlags.map((f) => {
            // The emergency-contact flag has its own rich widget instead of
            // just a banner. It writes to the student's Health Profile.
            //
            // Suppress on a student's view if THAT student already has a
            // native (non-legacy) submission on file. Rachel reported on
            // 5/18 that seeing "Same for Charlotte" on Charlotte's already-
            // filled page was confusing — the widget should appear where
            // it's actionable, i.e. on the sibling whose page is still
            // empty. We also surface the filled sibling's name in the
            // widget so the parent has clear context for the "Same as…"
            // option ("Same as Charlotte's emergency contact on file?").
            if (f.kind === 'emergency_contacts_per_student_review' && selectedStudent) {
              const subs = existingByStudentId[selectedStudent.id] ?? [];
              const selectedHasNative = subs.some((s) => !s.is_legacy);
              if (selectedHasNative) return null;
              // Find a sibling with any submission on file (native or
              // legacy) so we can label the action "Same as <sibling>".
              const filledSibling = students.find((s) =>
                s.id !== selectedStudent.id
                && (existingByStudentId[s.id] ?? []).length > 0,
              );
              const siblingName = filledSibling
                ? (filledSibling.preferred_name || filledSibling.first_name)
                : null;
              return (
                <EmergencyContactsConfirmWidget
                  key={f.id}
                  flagId={f.id}
                  studentName={selectedStudent.preferred_name || selectedStudent.first_name}
                  familyContact={familyEmergencyContact}
                  siblingOnFileName={siblingName}
                />
              );
            }
            return (
              <FlagBanner
                key={f.id}
                flag={f}
                studentName={selectedStudent ? (selectedStudent.preferred_name || selectedStudent.first_name) : null}
              />
            );
          })}
        </div>
      ) : null}

      {/* Lock state shown when a parent has a prior submission on file
          (legacy OR native). Tells them what they did + offers Update.
          Native submissions get the friendlier "your answers are
          preloaded for review" message; legacy gets the
          "answers aren't viewable here" caveat (we lack field-level
          data on those imports for some forms). Either way, clicking
          Update reveals the form pre-filled with whatever responses we
          have.

          If the LAST submitter wasn't the current parent (i.e. their
          co-parent), the headline + body text adjusts so the current
          parent knows their changes will overwrite their co-parent's
          answers. Pairs with the in-form warning banner below. */}
      {/* Multiple-submissions forms (e.g. Medication Authorization): no
          lock, just a note of how many are already on file. The blank form
          renders below so the parent can add another. */}
      {allowMultiple && relevantExisting.length > 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-700 mt-0.5" />
            <p className="text-sm text-emerald-900">
              You&rsquo;ve submitted this form <strong>{relevantExisting.length}</strong>{' '}
              {relevantExisting.length === 1 ? 'time' : 'times'}
              {definition.per_student && selectedStudent
                ? <> for {selectedStudent.preferred_name || selectedStudent.first_name}</>
                : null}. To add another, just fill out the form below — each one is saved separately.
            </p>
          </div>
        </div>
      ) : null}
      {(() => {
        const submittedByCoParent = !!(
          latest
          && !latest.is_legacy
          && latest.submitter_parent_id
          && latest.submitter_parent_id !== currentParentId
        );
        if (!showLockState || !latest) return null;
        // Re-editable forms keep the "Update my answers" flow. Forms locked
        // after submission (resubmission_allowed=false, e.g. the enrollment
        // agreement) instead tell the parent to email the office for a change.
        const canUpdate = definition.resubmission_allowed !== false;
        return (
        <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-blue-700 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-blue-900">
                {latest.is_legacy
                  ? `Complete · submitted via legacy form on ${fmtDate(latest.submitted_at)}`
                  : submittedByCoParent
                    ? `Complete · ${latest.submitter_name ?? 'the other parent'} submitted this on ${fmtDate(latest.submitted_at)}`
                    : `Complete · you submitted this on ${fmtDate(latest.submitted_at)}`}
              </h3>
              <p className="mt-1 text-xs text-blue-800">
                {definition.per_student && selectedStudent
                  ? `${selectedStudent.preferred_name || selectedStudent.first_name}'s submission is on file with the school. `
                  : 'Your submission is on file with the school. '}
                {!canUpdate
                  ? <>This is final and can&rsquo;t be changed here. To request a change, {changeRequestEmail
                      ? <>email <a href={`mailto:${changeRequestEmail}`} className="font-semibold underline">{changeRequestEmail}</a></>
                      : <>contact the school office</>} and they&rsquo;ll send you an amendment form.</>
                  : latest.is_legacy
                  ? <>Your previous answers aren&rsquo;t viewable here, but you can update them in the new portal if anything has changed.</>
                  : submittedByCoParent
                    ? <>Click <strong>Update my answers</strong> to make changes &mdash; the form below will be pre-filled with {latest.submitter_name ?? 'their'} answers. <strong>Anything you change will overwrite their entry.</strong></>
                    : <>Click <strong>Update my answers</strong> to review and change anything &mdash; your previous answers will be pre-filled.</>}
              </p>
              {canUpdate ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={startUpdateMode}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800"
                  >
                    <Edit3 className="h-3.5 w-3.5" /> Update my answers
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Co-parent overwrite warning. Appears when:
            - the parent is past the lock state (i.e. actively editing), AND
            - the prior submission was made by someone OTHER than the
              logged-in parent.
          Pairs with the lock-state copy above so the parent hits both
          messages: one before clicking Update, one while editing. */}
      {(() => {
        const submittedByCoParent = !!(
          latest
          && !latest.is_legacy
          && latest.submitter_parent_id
          && latest.submitter_parent_id !== currentParentId
        );
        if (!submittedByCoParent || showLockState) return null;
        return (
          <div className="rounded-md border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Heads up:</span>{' '}
              {latest.submitter_name ?? 'The other parent'} filled out this form on {fmtDate(latest.submitted_at)}.
              The fields below are pre-filled with their answers — anything you
              change and submit will overwrite their entry. Only edit fields you actually
              need to update.
            </div>
          </div>
        );
      })()}

      {/* Addendum CTA — only when the form supports it AND the parent
          (or family) already has a submission on file. */}
      {!showLockState && addendumOfferable ? (
        <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h4 className="text-sm font-semibold text-violet-900">
                Just need to update a few things?
              </h4>
              <p className="mt-0.5 text-xs text-violet-800">
                Your last submission is on file from {fmtDate(parentSubmission!.submitted_at)}.
                Instead of re-doing the whole form, you can submit a partial update for just
                the fields that changed.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setAddendumMode('picking');
                setAddendumFields(new Set());
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
            >
              <Edit3 className="h-3.5 w-3.5" /> Update specific fields
            </button>
          </div>
        </div>
      ) : null}

      {/* Addendum picker — replaces the form body until the parent picks
          which fields they want to update. */}
      {!showLockState && addendumMode === 'picking' && parentSubmission ? (
        <div className="rounded-lg border-2 border-violet-300 bg-white p-4">
          <h3 className="text-sm font-semibold text-violet-900">
            Pick the fields you want to update
          </h3>
          <p className="mt-1 text-xs text-violet-700">
            Only the fields you check below will be shown on the next screen. Everything else
            stays as it was on your previous submission.
          </p>
          <ul className="mt-3 space-y-1">
            {definition.field_schema
              .filter((b): b is Extract<FormFieldBlock, { key: string; label: string }> => 'key' in b && 'label' in b)
              .map((block) => (
                <li key={block.key}>
                  <label className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-violet-50 has-[:checked]:border-violet-500 has-[:checked]:bg-violet-50/50">
                    <input
                      type="checkbox"
                      checked={addendumFields.has(block.key)}
                      onChange={(e) => {
                        const next = new Set(addendumFields);
                        if (e.target.checked) next.add(block.key);
                        else next.delete(block.key);
                        setAddendumFields(next);
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-violet-600"
                    />
                    <span className="text-gray-900">{block.label}</span>
                    <span className="ml-auto text-[10px] text-gray-400 font-mono">{block.key}</span>
                  </label>
                </li>
              ))}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAddendumMode('off')}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={addendumFields.size === 0}
              onClick={() => setAddendumMode('editing')}
              className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
            >
              Continue to fill {addendumFields.size > 0 ? `(${addendumFields.size} field${addendumFields.size === 1 ? '' : 's'})` : ''}
            </button>
          </div>
        </div>
      ) : null}

      {/* Schema blocks — only shown when NOT in lock state AND NOT in
          addendum picker mode. Display-only blocks (header/paragraph/
          section) render normally. Keyed blocks render only the ones
          included in addendumFields when in addendum editing mode. */}
      {!showLockState && addendumMode !== 'picking' ? (
        <>
          {hasLegacy && inUpdateMode ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              You&rsquo;re updating answers from a previous submission. The form fields
              below are pre-filled with what we already have. Review, update what needs to change, and submit.
            </div>
          ) : null}
          {addendumMode === 'editing' ? (
            <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800 flex items-center justify-between gap-3">
              <span>
                <strong>Partial update.</strong> Only the {addendumFields.size} field
                {addendumFields.size === 1 ? '' : 's'} you picked are shown. Everything else
                stays as it was. Sign and submit when done.
              </span>
              <button
                type="button"
                onClick={() => setAddendumMode('picking')}
                className="text-[11px] text-violet-700 underline hover:text-violet-900 whitespace-nowrap"
              >
                ← Change fields
              </button>
            </div>
          ) : null}
          {definition.field_schema
            // New families fill the form fresh — strip the review-only lock
            // so their pricing/plan fields are editable. Existing families
            // keep the locked, pre-filled review.
            .map((block) => {
              if (isExistingFamily) return block; // existing families: all locks stay
              if (!('readOnly' in block) || !block.readOnly) return block;
              // New families get editable fields — EXCEPT a field flagged
              // `lock_when_prefilled` (e.g. enrollment_start_date) stays
              // locked when the contact record already provides a value. If
              // the contact has no value, we leave it editable so the parent
              // can supply it (and billing/proration isn't left date-less).
              const lockWhenPrefilled = (block as { lock_when_prefilled?: boolean }).lock_when_prefilled === true;
              if (lockWhenPrefilled && 'prefill' in block && block.prefill) {
                const v = resolvePrefill(block.prefill, prefillCtx);
                if (v && String(v).trim() !== '') return block; // contact set it → keep locked
              }
              return { ...block, readOnly: false };
            })
            .filter((block) => {
              if (addendumMode !== 'editing') return true;
              // Keep display-only blocks visible for context.
              if (!('key' in block)) return true;
              // In addendum mode, only render picked keyed blocks PLUS
              // any signature blocks (always needed to re-sign).
              if (block.type === 'signature_drawn' || block.type === 'signature_typed') return true;
              return addendumFields.has(block.key);
            })
            // Conditional visibility: drop blocks whose `visible_when` rule
            // isn't satisfied by the live form values. Hidden → not rendered,
            // not submitted, not required (the submit route skips them too).
            .filter((block) =>
              isBlockVisible(('visible_when' in block ? block.visible_when : undefined), responses),
            )
            // `hide_when_empty`: drop opt-in line items whose resolved prefill
            // is empty, so e.g. a "Scholarship — credit" row only appears for
            // families that actually have one — not as a blank row on every
            // contract. Opt-in per field, so no other form is affected.
            .filter((block) => {
              if (!('hide_when_empty' in block) || !block.hide_when_empty) return true;
              const src = 'prefill' in block ? block.prefill : undefined;
              if (!src) return true;
              const v = resolvePrefill(src, prefillCtx);
              return !(v == null || String(v).trim() === '');
            })
            .map((block, i) => {
              // STABLE key per block (its field key), NOT the filtered array
              // index — with uncontrolled inputs + conditional visibility an
              // index key makes React reconcile a field against whatever block
              // now sits at that index when something above it hides.
              const bKey = 'key' in block && block.key ? String(block.key) : null;
              const isMissing = bKey != null && missingFields.has(bKey);
              return (
                <div
                  key={bKey ?? `pos-${i}`}
                  className={isMissing ? 'rounded-lg p-2 -m-2 ring-2 ring-rose-400 bg-rose-50/40 scroll-mt-4' : undefined}
                >
                  <BlockRenderer
                    block={block}
                    prefillCtx={prefillCtx}
                    formResponses={responses}
                    students={students}
                    legacyResponses={
                      addendumMode === 'editing'
                        ? (parentSubmission?.responses ?? null)
                        : (inUpdateMode
                            ? (latest?.responses ?? null)
                            // Invite pre-fill: operator-set values seed the
                            // form's defaults. Parent can still edit them.
                            : (inviteContext?.prefill ?? null))
                    }
                  />
                  {isMissing ? (
                    <p className="mt-1 text-xs font-medium text-rose-600">This field is required.</p>
                  ) : null}
                </div>
              );
            })}
          {/* Hidden marker for operator-initiated invites — lets the
              submit route mark this invite consumed. */}
          {inviteContext ? (
            <input type="hidden" name="__invite_id" value={inviteContext.id} />
          ) : null}

          {/* Hidden markers — picked up by the submit route. */}
          {addendumMode === 'editing' && parentSubmission ? (
            <>
              <input type="hidden" name="__addendum" value="1" />
              <input type="hidden" name="__parent_submission_id" value={parentSubmission.id} />
              <input
                type="hidden"
                name="__addendum_fields"
                value={[...addendumFields].join(',')}
              />
            </>
          ) : null}
        </>
      ) : null}

      {/* Discount code field — only shown when the form has a
          payment_config. The server validates the code against the
          school's discount_policies at invoice creation; an invalid
          code is silently ignored (no error, no discount). */}
      {!showLockState && paymentConfigured && addendumMode !== 'picking' && !definition.payment_config?.hide_discount_code ? (
        <details className="rounded-md border border-gray-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-gray-700">
            Have a discount code?
          </summary>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              name="__redemption_code"
              placeholder="Enter code"
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm uppercase tracking-wider focus:border-emerald-600 focus:outline-none"
            />
            <span className="text-[11px] text-gray-500">Applied at checkout</span>
          </div>
        </details>
      ) : null}

      {/* Live payment summary — shows running total derived from
          the current responses. Only rendered when the form has a
          payment_config. */}
      {!showLockState && paymentConfigured && liveEval && addendumMode !== 'picking' ? (
        <PaymentSummary
          eval={liveEval}
          required={paymentRequired}
        />
      ) : null}

      {/* Dated payment schedule — shows after a plan is chosen / prefilled,
          even in dry-run. Explicitly states it does NOT bill today. */}
      {!showLockState && scheduleEval && addendumMode !== 'picking' ? (
        <PaymentSchedule
          eval={scheduleEval}
          planValue={String(responses['payment_plan'] ?? '')}
          plans={planTemplates}
          academicYear={scheduleYear}
          enrollmentFeePaid={
            definition.per_student
              ? (enrollmentFeePaidStudentIds ?? []).includes(studentId)
              : (enrollmentFeePaidStudentIds ?? []).length > 0
          }
        />
      ) : null}

      {/* Card-on-file gate — required before submit when the form opts in.
          Saving a card does NOT charge (SetupIntent). */}
      {!showLockState && requireMethod && addendumMode !== 'picking' ? (
        <PaymentMethodGate
          hasMethodOnFile={methodOnFile}
          cardEnabled={cardEnabled ?? true}
          achEnabled={achEnabled ?? true}
          onSaved={() => setMethodOnFile(true)}
        />
      ) : null}

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" /> {err}
        </div>
      ) : null}

      {!showLockState && addendumMode !== 'picking' ? (
        <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
          <button
            type="submit"
            disabled={
              busy
              || (definition.per_student && !studentId)
              || (paymentRequired && (liveEval?.subtotal_cents ?? 0) <= 0)
              || (requireMethod && !methodOnFile)
            }
            className="rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
            style={{ background: addendumMode === 'editing' ? '#6d28d9' : 'var(--brand)' }}
          >
            {paymentRequired ? <CreditCard className="h-4 w-4" /> : null}
            {busy
              ? 'Submitting…'
              : addendumMode === 'editing'
                ? `Submit update (${addendumFields.size} field${addendumFields.size === 1 ? '' : 's'})`
                : paymentRequired
                  ? (hasInstallmentPlan
                      // Enrollment / installment flow: nothing is charged at
                      // submit — the saved card autopays per the schedule.
                      ? 'Submit enrollment'
                      : (liveEval && liveEval.subtotal_cents > 0
                          ? `Continue to payment — ${fmtCents(liveEval.subtotal_cents)}`
                          : 'Continue to payment'))
                  : (hasLegacy && inUpdateMode ? 'Update submission' : 'Submit form')}
          </button>
          {requireMethod && !methodOnFile ? (
            <span className="text-[11px] text-amber-700">
              Add a payment method above to submit — you won&rsquo;t be charged today.
            </span>
          ) : paymentRequired ? (
            <span className="text-[11px] text-gray-500">
              {hasInstallmentPlan
                ? 'No charge today — your saved payment method is billed automatically per the schedule above.'
                : 'You’ll review fees and choose a payment method on the next screen.'}
            </span>
          ) : definition.fee_amount ? (
            <span className="text-[11px] text-gray-500">
              A ${definition.fee_amount.toFixed(2)} fee applies — you&apos;ll be marked as pending payment.
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

// ─── Live payment summary panel ──────────────────────────────────────
// Shown at the bottom of any form with a payment_config. Reads the
// already-evaluated lines (computed in the parent via evaluatePayment)
// and renders a clean breakdown. Does NOT include processing fees or
// the platform setup fee — those are applied at the /billing/pay step
// once the parent picks a rail.
function PaymentSummary({
  eval: result,
  required,
}: {
  eval: ReturnType<typeof evaluatePayment>;
  required: boolean;
}) {
  if (result.lines.length === 0) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
        {required
          ? 'Select your options above to see the total.'
          : 'No charges yet — make a selection above if any options have a fee.'}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 mb-2">
        {required ? 'Payment summary' : 'Running total'}
      </div>
      <ul className="space-y-1.5">
        {result.lines.map((l, i) => {
          const isCredit = l.amount_cents < 0;
          return (
            <li
              key={i}
              className={`flex items-center justify-between text-sm ${isCredit ? 'text-blue-700' : 'text-gray-800'}`}
            >
              <span>
                {l.description}
                {l.quantity > 1 ? (
                  <span className="text-xs text-gray-500"> × {l.quantity}</span>
                ) : null}
              </span>
              <span className={`tabular-nums ${isCredit ? 'font-semibold' : 'font-medium'}`}>
                {isCredit ? '−' : ''}{fmtCents(Math.abs(l.amount_cents))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-emerald-200 pt-2 text-sm">
        <span className="font-semibold text-gray-900">Subtotal</span>
        <span className="font-semibold text-gray-900 tabular-nums">{fmtCents(result.subtotal_cents)}</span>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        Processing fees (if applicable) will be shown on the payment screen.
      </p>
    </div>
  );
}

// ─── Payment schedule panel ──────────────────────────────────────────
// Shown once a payment plan is chosen (or prefilled). Splits the recurring
// total across the chosen plan's installment dates so parents see exactly
// when each payment is due — and makes crystal clear NOTHING is charged on
// submit. One-time fees (enrollment fee) are pulled out of the split since
// they're billed separately, not spread across installments.
interface PlanTemplate {
  id: string;
  slug: string;
  display_name: string;
  installments: number;
  cadence: string;
  discount_bp: number;
  schedule_months: string[] | null;
  first_due_month_day: string | null;
}
interface ScheduleRow { n: number; date: Date | null; amount_cents: number }

function currentAcademicYear(): string {
  // June onward rolls into the next school year (matches enrollment cadence).
  const now = new Date();
  const y = now.getFullYear();
  const sy = now.getMonth() + 1 >= 6 ? y : y - 1;
  return `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`;
}

function matchPlanTemplate(value: string, plans: PlanTemplate[]): PlanTemplate | null {
  const v = value.trim().toLowerCase();
  if (!v || plans.length === 0) return null;
  return plans.find((p) => p.slug.toLowerCase() === v)
    ?? plans.find((p) => p.display_name.toLowerCase() === v)
    ?? plans.find((p) => v.includes('month') && p.slug === 'monthly')
    ?? plans.find((p) => v.includes('annual') && p.slug === 'annual')
    ?? plans.find((p) => v.includes('semi') && p.slug.startsWith('semi'))
    ?? null;
}

function computeSchedule(recurringCents: number, plan: PlanTemplate, academicYear: string): ScheduleRow[] {
  if (recurringCents <= 0) return [];
  const months = plan.schedule_months && plan.schedule_months.length ? plan.schedule_months : null;
  const startYear = parseInt((academicYear || '').split('-')[0], 10);
  const day = plan.first_due_month_day ? parseInt(plan.first_due_month_day.split('-')[1] || '1', 10) : 1;
  const dates: Date[] = [];
  if (Number.isFinite(startYear) && months) {
    let year = startYear;
    let prev: number | null = null;
    for (const mm of months) {
      const m = parseInt(mm, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) continue;
      if (prev !== null && m < prev) year++; // wrapped into the next calendar year
      prev = m;
      const lastDom = new Date(Date.UTC(year, m, 0)).getUTCDate();
      dates.push(new Date(Date.UTC(year, m - 1, Math.min(day, lastDom))));
    }
  }
  const n = dates.length || Math.max(1, plan.installments || 1);
  const per = Math.floor(recurringCents / n);
  const out: ScheduleRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ n: i + 1, date: dates[i] ?? null, amount_cents: i === n - 1 ? recurringCents - per * (n - 1) : per });
  }
  return out;
}

function fmtSchedDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const ONE_TIME_CATEGORIES = new Set(['enrollment_fee']);

function PaymentSchedule({
  eval: result, planValue, plans, academicYear, enrollmentFeePaid,
}: {
  eval: ReturnType<typeof evaluatePayment>;
  planValue: string;
  plans: PlanTemplate[];
  academicYear: string;
  enrollmentFeePaid: boolean;
}) {
  const plan = matchPlanTemplate(planValue, plans);
  // One-time fees (enrollment fee) are billed separately, not spread across
  // installments — pull them out so the recurring schedule is just tuition.
  // Everything else (tuition, admin fee, add-ons, discounts) is the recurring
  // breakdown we show so the parent sees exactly what makes up each payment.
  const oneTimeLines = result.lines.filter((l) => l.category && ONE_TIME_CATEGORIES.has(l.category));
  const recurringLines = result.lines.filter((l) => !(l.category && ONE_TIME_CATEGORIES.has(l.category)));
  const feeCents = oneTimeLines.reduce((s, l) => s + l.amount_cents, 0);
  const recurringCents = result.subtotal_cents - feeCents;
  if (!plan || recurringCents <= 0) return null;
  const sched = computeSchedule(recurringCents, plan, academicYear);
  if (sched.length === 0) return null;
  const first = sched[0];
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-800 mb-1">
        Your payment schedule — {plan.display_name}
      </div>
      <p className="text-xs font-medium text-blue-900 mb-2">
        You will <span className="underline">not</span> be charged today. We save your payment method and
        automatically collect each payment on its due date below.
      </p>

      {/* Breakdown of what makes up the annual total — tuition, admin fee,
          add-ons, discounts — so parents see exactly what they're paying. */}
      <div className="rounded-md bg-white/70 border border-blue-100 px-3 py-2 mb-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
          What you&rsquo;re paying{sched.length > 1 ? ` (per year, split into ${sched.length} payments)` : ''}
        </div>
        <ul className="space-y-0.5">
          {recurringLines.map((l, i) => {
            const isCredit = l.amount_cents < 0;
            return (
              <li key={i} className={`flex items-center justify-between text-sm ${isCredit ? 'text-blue-700' : 'text-gray-800'}`}>
                <span>{l.description}{l.quantity > 1 ? <span className="text-xs text-gray-500"> × {l.quantity}</span> : null}</span>
                <span className="tabular-nums">{isCredit ? '−' : ''}{fmtCents(Math.abs(l.amount_cents))}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 flex items-center justify-between border-t border-gray-200 pt-1 text-sm font-semibold text-gray-900">
          <span>Annual total</span>
          <span className="tabular-nums">{fmtCents(recurringCents)}</span>
        </div>
      </div>

      {/* Enrollment fee — a one-time fee shown SEPARATELY from the recurring
          plan, with an explicit paid/unpaid status so a family that already
          paid it isn't confused into thinking they'll be charged it again. */}
      {feeCents > 0 ? (
        enrollmentFeePaid ? (
          <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
            <span>
              <strong>Enrollment fee — already paid.</strong> Your one-time {fmtCents(feeCents)} enrollment fee
              is on file as paid. It is <span className="underline">not</span> in the schedule below, and you
              will not be charged it again.
            </span>
          </div>
        ) : (
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start justify-between gap-2">
            <span>
              <strong>Enrollment fee — due.</strong> A one-time {fmtCents(feeCents)} enrollment fee is due at
              enrollment (separate from the schedule below).
            </span>
            <span className="tabular-nums font-semibold shrink-0">{fmtCents(feeCents)}</span>
          </div>
        )
      ) : null}

      <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-800 mb-1">Payment schedule</div>
      <ul className="space-y-1">
        {sched.map((s) => (
          <li key={s.n} className="flex items-center justify-between text-sm text-gray-800">
            <span>
              Payment {s.n}{sched.length > 1 ? ` of ${sched.length}` : ''}
              {s.date ? ` — due ${fmtSchedDate(s.date)}` : ''}
            </span>
            <span className="tabular-nums font-medium">{fmtCents(s.amount_cents)}</span>
          </li>
        ))}
      </ul>
      {first?.date ? (
        <p className="mt-2 text-[11px] text-gray-600">
          First payment of {fmtCents(first.amount_cents)} is due {fmtSchedDate(first.date)}. Nothing is charged when you submit this form.
        </p>
      ) : null}
    </div>
  );
}

// ─── Emergency-Contacts-Per-Student 1-tap widget ─────────────────────
// Shown inside per-student forms when the flag
// `emergency_contacts_per_student_review` is active for the selected
// student. Lets the parent confirm "same as family" with one tap, or
// edit a different contact specifically for this child.
function EmergencyContactsConfirmWidget({
  flagId, studentName, familyContact, siblingOnFileName,
}: {
  flagId: string;
  studentName: string;
  familyContact: { name: string; phone: string; relationship: string } | null;
  // When a sibling already has a submission on file, surface their name
  // so the "Same as…" button reads "Same as Charlotte" instead of just
  // "Same for Natalie" — fixes Rachel's "what's this asking about?"
  // confusion from Wooster testing.
  siblingOnFileName?: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'editing' | 'submitting' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(familyContact?.name ?? '');
  const [phone, setPhone] = useState(familyContact?.phone ?? '');
  const [rel, setRel] = useState(familyContact?.relationship ?? '');

  async function resolve(action: 'same_as_family' | 'different') {
    if (mode === 'submitting') return;
    setMode('submitting');
    setErr(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === 'different') {
        body.emergency_contact = { name, phone, relationship: rel };
      }
      const r = await fetch(`/api/portal-forms/migration-flag/${flagId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || 'Could not save');
      }
      setMode('done');
      // Refresh server data so the flag disappears
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
      setMode('editing');
    }
  }

  if (mode === 'done') {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 flex items-start gap-2">
        <CheckCircle2 className="h-4 w-4 mt-0.5" />
        Saved for {studentName}. Thanks for confirming.
      </div>
    );
  }

  const hasFamily = !!(familyContact && (familyContact.name || familyContact.phone));

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">⚠️</span>
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-amber-900">
            Confirm emergency contact for {studentName}
          </h4>
          <p className="mt-1 text-xs text-amber-800">
            {siblingOnFileName
              ? <>You already have emergency contact information on file from {siblingOnFileName}&rsquo;s submission. Confirm the same contact applies to {studentName}, or enter a different one.</>
              : <>Your emergency contacts were entered before we supported per-student capture. Please confirm the same contact applies to {studentName}, or enter a different one.</>}
          </p>

          {hasFamily ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-2 text-xs">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">On file for the family</div>
              <div className="font-medium text-gray-900">{familyContact!.name || '(no name on file)'}</div>
              <div className="text-gray-700">{familyContact!.phone || '(no phone)'}</div>
              {familyContact!.relationship ? (
                <div className="text-[11px] text-gray-500 italic">{familyContact!.relationship}</div>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-gray-600 italic">
              We don&rsquo;t have a family-level emergency contact on file. Please enter one for {studentName} below.
            </div>
          )}

          {mode !== 'editing' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {hasFamily ? (
                <button
                  type="button"
                  onClick={() => resolve('same_as_family')}
                  disabled={mode === 'submitting'}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                >
                  {siblingOnFileName
                    ? `Same as ${siblingOnFileName}`
                    : `Use this contact for ${studentName}`}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setMode('editing')}
                disabled={mode === 'submitting'}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
              >
                {hasFamily ? `Different for ${studentName}` : `Enter for ${studentName}`}
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Emergency contact name"
                className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <input
                type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone"
                className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <input
                type="text" value={rel} onChange={(e) => setRel(e.target.value)}
                placeholder="Relationship to student (e.g. Grandparent)"
                className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resolve('different')}
                  disabled={!name && !phone}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  Save for {studentName}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('idle')}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {err ? <p className="mt-2 text-xs text-red-700">{err}</p> : null}
        </div>
      </div>
    </div>
  );
}

// ─── Migration flag banner ─────────────────────────────────────────────
function FlagBanner({ flag, studentName }: { flag: MigrationFlag; studentName: string | null }) {
  // Format message: replace generic placeholders with the active student name where useful
  let msg = flag.message;
  let title = 'Action needed';
  if (flag.kind === 'emergency_contacts_per_student_review') {
    title = 'Confirm emergency contacts per student';
  } else if (flag.kind === 'missing_submission_for_student') {
    title = 'Submission needed';
  } else if (flag.kind === 'possible_student_data_collision') {
    title = 'Multiple submissions on file';
  } else if (flag.kind === 'student_attribution_unknown') {
    title = 'Help us confirm which child';
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-start gap-2">
        <span className="text-base">⚠️</span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-amber-900">{title}</div>
          <div className="mt-0.5 text-xs text-amber-800">{msg}</div>
        </div>
      </div>
    </div>
  );
}

function BlockRenderer({
  block, prefillCtx, legacyResponses, formResponses, students,
}: {
  block: FormFieldBlock;
  prefillCtx: PrefillContext;
  legacyResponses: Record<string, unknown> | null;
  // Snapshot of the entire form's current values, used by conditional
  // rendering (e.g. PricingSelect's visible_when option filter).
  formResponses: Record<string, unknown>;
  // Family's students — fed into the student_applicability block so
  // each emergency contact (or any future "applies to which kid" field)
  // can render a dynamic checkbox list scoped to this family.
  students: StudentOption[];
}) {
  switch (block.type) {
    case 'header':
      return <h2 className="text-lg font-semibold text-gray-900 border-b border-gray-100 pb-2">{block.text}</h2>;
    case 'paragraph': {
      const cls =
        block.emphasis === 'warning' ? 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900' :
        block.emphasis === 'note'    ? 'rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700' :
                                       'text-sm text-gray-700 whitespace-pre-wrap';
      return <p className={cls}>{block.text}</p>;
    }
    case 'section':
      // Section heading — must be visually prominent. Originally it was a
      // skinny gray top-border with small bold text, which Rachel
      // overlooked entirely during Wooster testing ("I can only add ONE
      // emergency contact"). The fix: make sections look like clearly
      // labeled cards so each one reads as its own group of fields.
      return (
        <div className="mt-4 rounded-md bg-gray-50 border-l-4 border-emerald-500 px-3 py-2">
          <h3 className="text-base font-semibold text-gray-900">{block.label}</h3>
          {block.description ? <p className="mt-0.5 text-xs text-gray-600">{block.description}</p> : null}
        </div>
      );
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
      // student_specific=true (and >1 student) → render one input per
      // student, named `<key>__<student_id>`. Lets Wooster's medical
      // form capture per-kid values without forcing the whole form to
      // be filled once per student.
      if (block.student_specific && students.length > 1) {
        return (
          <FieldShell block={block}>
            <StudentSplitWrapper students={students}>
              {(s) => (
                <TextInput
                  block={{ ...block, key: `${block.key}__${s.id}` }}
                  prefillCtx={prefillCtx}
                  legacyResponses={legacyResponses}
                />
              )}
            </StudentSplitWrapper>
          </FieldShell>
        );
      }
      return <FieldShell block={block}><TextInput block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'textarea':
      if (block.student_specific && students.length > 1) {
        return (
          <FieldShell block={block}>
            <StudentSplitWrapper students={students}>
              {(s) => (
                <Textarea
                  block={{ ...block, key: `${block.key}__${s.id}` }}
                  prefillCtx={prefillCtx}
                  legacyResponses={legacyResponses}
                />
              )}
            </StudentSplitWrapper>
          </FieldShell>
        );
      }
      return <FieldShell block={block}><Textarea block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'number':
      return <FieldShell block={block}><NumberInput block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'date':
      return <FieldShell block={block}><DateInput block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'select':
      return <FieldShell block={block}><SelectInput block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'radio':
      return <FieldShell block={block}><RadioGroup block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'checkbox':
      return <SingleCheckbox block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} />;
    case 'multi_checkbox':
      // student_specific=true (and >1 student) → render one full checkbox
      // set per student, each labeled with the kid's name. Lets Wooster's
      // Media Permission form allow different channel grants per child.
      if (block.student_specific && students.length > 1) {
        return (
          <FieldShell block={block}>
            <StudentSplitWrapper students={students}>
              {(s) => (
                <MultiCheckbox
                  block={{ ...block, key: `${block.key}__${s.id}` }}
                  legacyResponses={legacyResponses}
                />
              )}
            </StudentSplitWrapper>
          </FieldShell>
        );
      }
      return <FieldShell block={block}><MultiCheckbox block={block} legacyResponses={legacyResponses} /></FieldShell>;
    case 'student_applicability':
      return <FieldShell block={block}><StudentApplicability block={block} students={students} legacyResponses={legacyResponses} /></FieldShell>;
    case 'file_upload':
      return <FieldShell block={block}><FileInput block={block} legacyResponses={legacyResponses} /></FieldShell>;
    case 'signature_drawn':
      return <FieldShell block={block}><SignatureDrawn block={block} /></FieldShell>;
    case 'signature_typed':
      return <FieldShell block={block}><SignatureTyped block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} /></FieldShell>;
    case 'signature_stamp':
      return <SignatureStamp block={block} />;
    case 'pricing_select':
      return <FieldShell block={block}><PricingSelect block={block} prefillCtx={prefillCtx} legacyResponses={legacyResponses} formResponses={formResponses} /></FieldShell>;
    case 'multi_pricing':
      return <FieldShell block={block}><MultiPricing block={block} legacyResponses={legacyResponses} /></FieldShell>;
    case 'quantity_pricing':
      return <FieldShell block={block}><QuantityPricing block={block} legacyResponses={legacyResponses} /></FieldShell>;
    case 'tuition_calculator':
      return <FieldShell block={block}><TuitionCalculator block={block} legacyResponses={legacyResponses} /></FieldShell>;
  }
}

// Helper: read the legacy value for a field, returning null if absent
// or not a string. Used to override the schema's prefill default when
// the parent is in update mode.
function legacyVal(legacyResponses: Record<string, unknown> | null, key: string): string | null {
  if (!legacyResponses) return null;
  const v = legacyResponses[key];
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : '';
  return null;
}

// Any interactive (keyed) block — excludes header/paragraph/section.
type KeyedBlock = Extract<FormFieldBlock, { key: string }>;

function FieldShell({
  block,
  children,
}: {
  block: KeyedBlock;
  children: React.ReactNode;
}) {
  const locked = 'readOnly' in block && block.readOnly === true;
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800 inline-flex items-center gap-1.5">
        {block.label} {block.required ? <span className="text-rose-600">*</span> : null}
        {locked ? (
          <span
            title="This value is set by the school. To change it, please contact the office."
            className="text-xs text-amber-700"
            aria-label="Set by the school"
          >
            🔒
          </span>
        ) : null}
      </span>
      {block.help ? <span className="block text-[11px] text-gray-500 mt-0.5">{block.help}</span> : null}
      {children}
    </label>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200 disabled:bg-gray-50';

// Visual lock for `readOnly: true` fields — value still submits (HTML
// readOnly preserves form-encoded value, unlike disabled) but the input
// looks visibly locked so parents know it's not editable. A tiny lock
// icon + "set by school" hint is shown next to the label via
// FieldShell's readOnly branch.
const inputClsReadOnly =
  'mt-1 block w-full rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700 cursor-not-allowed focus:outline-none';

// Locked display for choice fields (select / radio / pricing_select).
// HTML `readOnly` is a no-op on <select> and radio groups, so we render
// the resolved value as a static, clearly-locked box plus a hidden input
// that still submits the value. `label` is the human option label;
// `value` is what posts.
function LockedChoice({ name, value, label }: { name: string; value: string; label: string }) {
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <div className={inputClsReadOnly}>{label || value || '—'}</div>
    </>
  );
}

type LegacyProp = { legacyResponses: Record<string, unknown> | null };

function TextInput({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'text' | 'email' | 'tel' | 'url' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  const typeMap: Record<string, string> = { text: 'text', email: 'email', tel: 'tel', url: 'url' };
  const locked = block.readOnly === true;
  return (
    <input
      type={typeMap[block.type]}
      name={block.key}
      required={block.required}
      defaultValue={defaultValue}
      readOnly={locked}
      maxLength={'max_length' in block ? block.max_length : undefined}
      placeholder={'placeholder' in block ? block.placeholder : ''}
      className={locked ? inputClsReadOnly : inputCls}
    />
  );
}

// Render the same input N times — once per student in the family — and
// label each one with the student's name. Used by `student_specific`
// text / textarea fields. Each child input is responsible for its own
// per-student key (the caller mints `<key>__<student_id>`).
function StudentSplitWrapper({
  students, children,
}: {
  students: StudentOption[];
  children: (s: StudentOption) => React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">
        We&rsquo;ll capture this <strong>separately for each of your children</strong> —
        leave any kid&rsquo;s box blank if it doesn&rsquo;t apply.
      </p>
      {students.map((s) => {
        const display = `${(s.preferred_name?.trim() || s.first_name)} ${s.last_name}`.trim();
        return (
          <div key={s.id} className="rounded-md border border-emerald-200 bg-emerald-50/30 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-emerald-800 font-semibold mb-1">
              {display}
            </div>
            {children(s)}
          </div>
        );
      })}
    </div>
  );
}

function Textarea({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'textarea' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  const locked = block.readOnly === true;
  return (
    <textarea
      name={block.key}
      required={block.required}
      defaultValue={defaultValue}
      readOnly={locked}
      rows={block.rows ?? 3}
      placeholder={block.placeholder ?? ''}
      className={locked ? inputClsReadOnly : inputCls}
    />
  );
}

function NumberInput({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'number' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  const locked = block.readOnly === true;
  return (
    <input
      type="number"
      name={block.key}
      required={block.required}
      defaultValue={defaultValue}
      readOnly={locked}
      min={block.min}
      max={block.max}
      step={block.step ?? 1}
      placeholder={block.placeholder ?? ''}
      className={locked ? inputClsReadOnly : inputCls}
    />
  );
}

function DateInput({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'date' }>; prefillCtx: PrefillContext } & LegacyProp) {
  // A `prefill: "today"` date is a SIGNING / SUBMISSION date — it's always
  // auto-stamped to today and locked, for EVERY family. Two reasons we
  // can't just rely on `readOnly`: (1) HTML `readOnly` is a no-op on a
  // native <input type="date"> (the picker still changes it), and (2) for
  // new families the renderer strips `readOnly`. So we key off the prefill
  // itself and render a locked display + hidden input — no back-dating.
  const lockToday = block.prefill === 'today';
  const rawValue = lockToday
    ? resolvePrefill('today', prefillCtx)
    : ((legacyVal(legacyResponses, block.key) ?? resolvePrefill(block.prefill, prefillCtx))
        || (typeof block.default === 'string' ? block.default : ''));
  // A native <input type="date"> (and our locked display) needs a bare
  // YYYY-MM-DD. A prefilled date sourced from synced metadata can arrive as a
  // full ISO timestamp (e.g. "2026-08-03T00:00:00.000Z") — which the input
  // rejects, rendering blank. A blank + locked + required field is a dead end
  // (can't edit, can't submit), so take just the date part. Non-ISO values
  // (already YYYY-MM-DD, or empty) pass through untouched.
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(rawValue);
  const defaultValue = isoDate ? isoDate[1] : rawValue;
  const locked = lockToday || block.readOnly === true;
  if (locked) {
    return <LockedChoice name={block.key} value={defaultValue} label={fmtDateDisplay(defaultValue)} />;
  }
  return (
    <input
      type="date"
      name={block.key}
      required={block.required}
      defaultValue={defaultValue}
      min={block.min}
      max={block.max}
      className={inputCls}
    />
  );
}

// Format a YYYY-MM-DD value for the locked display, avoiding the UTC
// off-by-one you get from new Date("YYYY-MM-DD").
function fmtDateDisplay(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  if (!m) return v || '—';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(dt.getTime())) return v;
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function SelectInput({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'select' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  // Lock when explicitly readOnly, OR when lock_if_prefilled is set AND we
  // actually have a value (existing families) — new families get the
  // editable dropdown to fill it in.
  const locked = block.readOnly === true || (block.lock_if_prefilled === true && !!defaultValue);
  if (locked) {
    const opt = block.options.find((o) => o.value === defaultValue);
    return <LockedChoice name={block.key} value={defaultValue} label={opt?.label ?? ''} />;
  }
  return (
    <select name={block.key} required={block.required} defaultValue={defaultValue || ''} className={inputCls}>
      <option value="">— select —</option>
      {block.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function RadioGroup({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'radio' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  const locked = block.readOnly === true || (block.lock_if_prefilled === true && !!defaultValue);
  if (locked) {
    const opt = block.options.find((o) => o.value === defaultValue);
    return <LockedChoice name={block.key} value={defaultValue} label={opt?.label ?? ''} />;
  }
  return (
    <div className="mt-1 space-y-1">
      {block.options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={block.key}
            value={o.value}
            defaultChecked={defaultValue === o.value}
            required={block.required}
            className="h-4 w-4 text-emerald-600"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function SingleCheckbox({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'checkbox' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const legacy = legacyResponses?.[block.key];
  // Prior-submission value wins; otherwise honor the schema's prefill source
  // so a checkbox can default-on from data (e.g. pg2_present pre-checks when
  // the family has a second guardian synced from GHL).
  const prefilled = resolvePrefill((block as { prefill?: Parameters<typeof resolvePrefill>[0] }).prefill, prefillCtx);
  const checked = legacy === true || legacy === 'true' || legacy === '1'
    || prefilled === '1' || prefilled === 'true';
  // Hidden derived checkbox: no visible UI, just submits its derived value so
  // OTHER fields can gate on it — e.g. pg2_present auto-reveals the Parent 2
  // section when a co-parent is on the contact, with no manual "add P/G 2" box.
  if ((block as { hidden?: boolean }).hidden === true) {
    return <input type="hidden" name={block.key} defaultValue={checked ? '1' : ''} />;
  }
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name={block.key}
        value="1"
        required={block.required}
        defaultChecked={checked}
        className="mt-0.5 h-4 w-4 rounded border-gray-300"
      />
      <span className="text-gray-800">
        {block.label} {block.required ? <span className="text-rose-600">*</span> : null}
        {block.help ? <span className="block text-[11px] text-gray-500 mt-0.5">{block.help}</span> : null}
      </span>
    </label>
  );
}

function MultiCheckbox({ block, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'multi_checkbox' }> } & LegacyProp) {
  const raw = legacyResponses?.[block.key];
  const checkedSet = new Set<string>(Array.isArray(raw) ? raw.map(String) : []);
  return (
    <div className="mt-1 space-y-1">
      {block.options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name={`${block.key}[]`}
            value={o.value}
            defaultChecked={checkedSet.has(o.value)}
            className="h-4 w-4 rounded border-gray-300"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

// Per-student applicability checkbox group. Options = family's students
// plus an "All students" sentinel. Uses controlled state so checking
// "All" both grays-out and unchecks the individual rows. Stores the
// selection under `<key>[]` so the server's existing multi_checkbox
// path picks it up as an array.
function StudentApplicability({
  block, students, legacyResponses,
}: {
  block: Extract<FormFieldBlock, { type: 'student_applicability' }>;
  students: StudentOption[];
} & LegacyProp) {
  // Seed from previous submission if present, otherwise apply the
  // schema's default_selection.
  const raw = legacyResponses?.[block.key];
  const initial = (() => {
    if (Array.isArray(raw)) return raw.map(String);
    if (block.default_selection === 'all') return ['all'];
    return [];
  })();
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const allChecked = selected.has('all');

  function toggle(value: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (value === 'all') {
        if (on) {
          // Selecting "All" clears individuals — they're implied.
          return new Set(['all']);
        } else {
          next.delete('all');
          return next;
        }
      }
      // Individual student toggle — implicitly leaves "all" mode.
      next.delete('all');
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  // Empty-family guard. If the family has no students on file, treat
  // the EC as applying to "all" by default — we don't surface a UI for
  // a no-op picker.
  if (students.length === 0) {
    return (
      <div className="mt-1 text-xs italic text-gray-500">
        No students on file yet — this contact will apply to any future student you add.
        <input type="hidden" name={`${block.key}[]`} value="all" />
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-1.5 rounded-md border border-gray-200 bg-gray-50/40 px-3 py-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          name={`${block.key}[]`}
          value="all"
          checked={allChecked}
          onChange={(e) => toggle('all', e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span>All students in our family ({students.length})</span>
      </label>
      <div className={`ml-6 space-y-1 ${allChecked ? 'opacity-50' : ''}`}>
        {students.map((s) => {
          const display = s.preferred_name || s.first_name;
          return (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={`${block.key}[]`}
                value={s.id}
                checked={!allChecked && selected.has(s.id)}
                disabled={allChecked}
                onChange={(e) => toggle(s.id, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              {display} {s.last_name}
            </label>
          );
        })}
      </div>
      {selected.size === 0 ? (
        <p className="mt-1 text-[11px] text-amber-700">
          Pick at least one student — or check &ldquo;All students&rdquo; if this contact applies to every child.
        </p>
      ) : null}
    </div>
  );
}

function FileInput({ block, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'file_upload' }> } & LegacyProp) {
  // Legacy submissions stored uploads as URLs under "<key>_url" (e.g.
  // medical_admin_form_url for the medications form). Surface that URL
  // as a "previously uploaded" note so parents know we already have the
  // file on record — they only need to upload again if it's changed.
  const legacyUrl = legacyVal(legacyResponses, `${block.key}_url`);
  return (
    <div>
      {legacyUrl ? (
        <div className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <span className="font-medium">Previously uploaded:</span>{' '}
          <a
            href={legacyUrl}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-blue-700"
          >
            View file on record
          </a>{' '}
          <span className="text-blue-700">— only upload again if it&apos;s changed.</span>
        </div>
      ) : null}
      <input
        type="file"
        name={block.key}
        accept={block.accept ?? '.pdf,.jpg,.jpeg,.png'}
        multiple={block.multiple}
        // Required only if no previous file is on record. With a legacy
        // URL present, the parent's already on file — uploading again is
        // optional.
        required={block.required && !legacyUrl}
        className="block w-full text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-gray-200"
      />
    </div>
  );
}

// Plain text input. No state, no preview, no canvas, no hidden inputs,
// no React anything. Just a dumb HTML <input name={block.key}> that
// submits whatever the parent types as the signature value. The
// renderers downstream (parent print + admin submission view) detect
// plain text and display in script font on read.
//
// Why this minimal: previous typed-with-preview implementation had
// parents reporting they couldn't submit. Stripped to bare HTML so
// nothing about React state or hidden inputs can fail. If the parent
// can type into a text box, the form will submit.
function SignatureDrawn({ block }: { block: Extract<FormFieldBlock, { type: 'signature_drawn' }> }) {
  return (
    <div className="space-y-1">
      <input
        type="text"
        name={block.key}
        required={block.required}
        placeholder="Type your full legal name"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
      />
      <p className="text-[11px] text-gray-500">
        By typing your name above, you are signing this form electronically.
        This e-signature has the same legal effect as a handwritten one.
      </p>
    </div>
  );
}

// ─── Pricing blocks (Phase 3) ────────────────────────────────────────
// All three of these mount inside the same uncontrolled <form>. They
// emit standard form inputs (radio / checkbox / number) so the parent
// form's onChange picks them up via FormData.

function PricingSelect({
  block, prefillCtx, legacyResponses, formResponses,
}: { block: Extract<FormFieldBlock, { type: 'pricing_select' }>; prefillCtx: PrefillContext; formResponses: Record<string, unknown> } & LegacyProp) {
  // Resolve the pre-selected option: prior/invite response first, then the
  // schema's prefill source (e.g. `meta:ea_program_tuition`).
  const legacy = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx)) || '';
  if (block.readOnly === true) {
    const opt = block.options.find((o) => o.value === legacy);
    const label = opt ? `${opt.label} — ${fmtCents(opt.amount_cents)}` : '';
    return <LockedChoice name={block.key} value={legacy} label={label} />;
  }
  // Filter options by `visible_when` (e.g. grade-based tuition filter).
  const visibleOptions = block.options.filter((o) => {
    if (!o.visible_when) return true;
    const v = formResponses[o.visible_when.field];
    if (v == null || v === '') return true;  // not picked yet → show
    return o.visible_when.equals.includes(String(v));
  });
  return (
    <div className="mt-1 space-y-1.5">
      {visibleOptions.length === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No options match your selection above. If this looks wrong, contact the school.
        </div>
      ) : null}
      {visibleOptions.map((o) => {
        const labelText = block.show_price_in_label && o.amount_cents
          ? `${o.label} — ${fmtCents(o.amount_cents)}`
          : o.label;
        return (
          <label
            key={o.value}
            className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40"
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={block.key}
                value={o.value}
                defaultChecked={legacy === o.value}
                required={block.required}
                className="h-4 w-4 text-emerald-600"
              />
              <span className="text-gray-900">{labelText}</span>
            </span>
            {!block.show_price_in_label && o.amount_cents ? (
              <span className="text-xs font-semibold tabular-nums text-emerald-700">
                {fmtCents(o.amount_cents)}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

function MultiPricing({
  block, legacyResponses,
}: { block: Extract<FormFieldBlock, { type: 'multi_pricing' }> } & LegacyProp) {
  const raw = legacyResponses?.[block.key];
  const checkedSet = new Set<string>(Array.isArray(raw) ? raw.map(String) : []);
  return (
    <div className="mt-1 space-y-1.5">
      {block.options.map((o) => (
        <label
          key={o.value}
          className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40"
        >
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              name={`${block.key}[]`}
              value={o.value}
              defaultChecked={checkedSet.has(o.value)}
              className="h-4 w-4 rounded border-gray-300 text-emerald-600"
            />
            <span className="text-gray-900">{o.label}</span>
          </span>
          <span className="text-xs font-semibold tabular-nums text-emerald-700">
            {fmtCents(o.amount_cents)}
          </span>
        </label>
      ))}
    </div>
  );
}

function QuantityPricing({
  block, legacyResponses,
}: { block: Extract<FormFieldBlock, { type: 'quantity_pricing' }> } & LegacyProp) {
  const legacy = legacyVal(legacyResponses, block.key);
  const initial = legacy != null && legacy !== '' ? Math.max(0, parseInt(legacy, 10) || 0) : (block.min ?? 0);
  const [qty, setQty] = useState<number>(initial);
  const min = block.min ?? 0;
  const max = block.max ?? 99;
  function bump(d: number) {
    const next = Math.min(max, Math.max(min, qty + d));
    setQty(next);
  }
  return (
    <div className="mt-1 flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
      <div>
        <div className="text-gray-900">
          {block.unit_label} — <span className="text-emerald-700 font-semibold">{fmtCents(block.unit_amount_cents)}</span> each
        </div>
        {qty > 0 ? (
          <div className="text-[11px] text-gray-500 tabular-nums">
            {qty} × {fmtCents(block.unit_amount_cents)} = {fmtCents(qty * block.unit_amount_cents)}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => bump(-1)}
          disabled={qty <= min}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          aria-label="Decrease"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <input
          type="number"
          name={block.key}
          value={qty}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) setQty(Math.min(max, Math.max(min, n)));
            else setQty(min);
          }}
          required={block.required}
          min={min}
          max={max}
          className="w-14 rounded-md border border-gray-300 bg-white px-2 py-1 text-center text-sm tabular-nums focus:border-emerald-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => bump(1)}
          disabled={qty >= max}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          aria-label="Increase"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// Tuition calculator — fetches the school's published tuition_grids
// rows (with their payment_plans + addons) and lets the parent pick a
// grid + plan + addons. The selected configuration is serialised as
// JSON into the hidden input named `block.key`, where the server (and
// the payment-eval helper) reads it.
interface TuitionGridApiRow {
  id: string;
  display_name: string;
  academic_year: string;
  program: string | null;
  grade_level: string | null;
  annual_tuition_cents: number;
  addons: Array<{ key: string; label: string; amount_cents: number; required?: boolean }>;
}
interface PaymentPlanApiRow {
  id: string;
  slug: string;
  display_name: string;
  installments: number;
  cadence: string;
  discount_bp: number;
}
interface TuitionCalcState {
  tuition_grid_id: string | null;
  display_name: string;
  annual_tuition_cents: number;
  plan_slug: string | null;
  plan_label: string | null;
  plan_discount_bp: number;
  // `paid: true` addons are already-paid line items (e.g. enrollment
  // deposit collected at contract signing). They're carried in the
  // calc so the parent can see them in the breakdown, but they are
  // NOT included in total_cents.
  addons: Array<{ key: string; label: string; amount_cents: number; paid?: boolean }>;
  total_cents: number;
}

function TuitionCalculator({
  block, legacyResponses,
}: { block: Extract<FormFieldBlock, { type: 'tuition_calculator' }> } & LegacyProp) {
  const [grids, setGrids] = useState<TuitionGridApiRow[] | null>(null);
  const [plans, setPlans] = useState<PaymentPlanApiRow[]>([]);
  const [paidAddonCats, setPaidAddonCats] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [gridId, setGridId] = useState<string>('');
  const [addonKeys, setAddonKeys] = useState<Set<string>>(new Set());
  const [planSlug, setPlanSlug] = useState<string>('');

  // Hydrate from a prior submission if available
  useEffect(() => {
    const raw = legacyResponses?.[block.key];
    if (!raw) return;
    try {
      const parsed: TuitionCalcState = typeof raw === 'string' ? JSON.parse(raw) : raw as TuitionCalcState;
      if (parsed.tuition_grid_id) setGridId(parsed.tuition_grid_id);
      if (parsed.plan_slug) setPlanSlug(parsed.plan_slug);
      if (Array.isArray(parsed.addons)) {
        setAddonKeys(new Set(parsed.addons.map((a) => a.key ?? a.label)));
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (block.academic_year) qs.set('academic_year', block.academic_year);
    if (block.program) qs.set('program', block.program);
    if (block.grade_level) qs.set('grade_level', block.grade_level);
    if (block.include_plan_picker) qs.set('include_plans', '1');
    fetch(`/api/billing/tuition-grids?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<{
          grids: TuitionGridApiRow[];
          plans: PaymentPlanApiRow[];
          paid_addon_categories?: string[];
        }>;
      })
      .then((d) => {
        setGrids(d.grids);
        setPlans(d.plans ?? []);
        setPaidAddonCats(new Set(d.paid_addon_categories ?? []));
        // Auto-select if only one option
        if (d.grids.length === 1 && !gridId) setGridId(d.grids[0].id);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Could not load tuition options'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.academic_year, block.program, block.grade_level, block.include_plan_picker]);

  const selectedGrid = grids?.find((g) => g.id === gridId) ?? null;

  // When a grid is selected, auto-tick (a) required addons and
  // (b) addons that have already been paid for. The parent can't toggle
  // either off — required ones because they're mandatory, paid ones
  // because they're already part of the contract.
  useEffect(() => {
    if (!selectedGrid) return;
    const next = new Set(addonKeys);
    let changed = false;
    for (const a of selectedGrid.addons) {
      const shouldTick = a.required || paidAddonCats.has(a.key);
      if (shouldTick && !next.has(a.key)) {
        next.add(a.key);
        changed = true;
      }
    }
    if (changed) setAddonKeys(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrid?.id, paidAddonCats]);

  const selectedPlan = plans.find((p) => p.slug === planSlug) ?? null;

  const calcState: TuitionCalcState = useMemo(() => {
    if (!selectedGrid) {
      return {
        tuition_grid_id: null,
        display_name: '',
        annual_tuition_cents: 0,
        plan_slug: null,
        plan_label: null,
        plan_discount_bp: 0,
        addons: [],
        total_cents: 0,
      };
    }
    const base = selectedGrid.annual_tuition_cents;
    const discountBp = selectedPlan?.discount_bp ?? 0;
    const discounted = base - Math.round(base * discountBp / 10000);
    const checkedAddons = selectedGrid.addons
      .filter((a) => addonKeys.has(a.key))
      .map((a) => ({
        key: a.key,
        label: a.label,
        amount_cents: a.amount_cents,
        // Already-paid addons (e.g. enrollment deposit collected at
        // contract signing) carry a `paid: true` flag. They appear in
        // the breakdown but DON'T add to the amount the family owes
        // right now.
        paid: paidAddonCats.has(a.key),
      }));
    // Only unpaid addons count toward what the family owes.
    const addonTotal = checkedAddons
      .filter((a) => !a.paid)
      .reduce((s, a) => s + a.amount_cents, 0);
    return {
      tuition_grid_id: selectedGrid.id,
      display_name: selectedGrid.display_name,
      annual_tuition_cents: base,
      plan_slug: selectedPlan?.slug ?? null,
      plan_label: selectedPlan?.display_name ?? null,
      plan_discount_bp: discountBp,
      addons: checkedAddons,
      total_cents: discounted + addonTotal,
    };
  }, [selectedGrid, selectedPlan, addonKeys]);

  const hiddenJson = JSON.stringify(calcState);

  // When calcState changes (grid pick, plan pick, or addon toggle), the
  // hidden input below gets a new value via React. Unnamed-checkbox
  // addon clicks do trigger a bubbling change event, BUT React's
  // synthetic event fires before the re-render commits — so the form's
  // onChange handler would snapshot the OLD hidden-input value.
  // Dispatch our own bubbling change event AFTER the commit so the
  // form's onChange picks up the fresh JSON. useEffect always runs
  // post-commit (after React has updated the DOM).
  const hiddenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!hiddenRef.current) return;
    hiddenRef.current.dispatchEvent(new Event('change', { bubbles: true }));
  }, [hiddenJson]);

  if (loadErr) {
    return (
      <div className="mt-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        {loadErr}
      </div>
    );
  }
  if (grids === null) {
    return (
      <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Loading tuition options…
      </div>
    );
  }
  if (grids.length === 0) {
    return (
      <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        No tuition options are published yet. Please contact the school.
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-3">
      {/* Hidden field — the actual value the form submits */}
      <input
        ref={hiddenRef}
        type="hidden"
        name={block.key}
        value={hiddenJson}
        required={block.required}
      />

      {/* Grid (program / grade) selection */}
      {grids.length > 1 ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Program</div>
          <div className="space-y-1.5">
            {grids.map((g) => (
              <label
                key={g.id}
                className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`__tuition_grid_${block.key}`}
                    value={g.id}
                    checked={gridId === g.id}
                    onChange={() => setGridId(g.id)}
                    className="h-4 w-4 text-emerald-600"
                  />
                  <span className="text-gray-900">{g.display_name}</span>
                </span>
                <span className="text-xs font-semibold tabular-nums text-emerald-700">
                  {fmtCents(g.annual_tuition_cents)} / yr
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {/* Plan picker */}
      {block.include_plan_picker && plans.length > 0 && selectedGrid ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Payment plan</div>
          <div className="space-y-1.5">
            {plans.map((p) => {
              const discounted = selectedGrid.annual_tuition_cents
                - Math.round(selectedGrid.annual_tuition_cents * p.discount_bp / 10000);
              const perInstall = p.installments > 0 ? Math.round(discounted / p.installments) : discounted;
              return (
                <label
                  key={p.slug}
                  className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`__tuition_plan_${block.key}`}
                      value={p.slug}
                      checked={planSlug === p.slug}
                      onChange={() => setPlanSlug(p.slug)}
                      className="h-4 w-4 text-emerald-600"
                    />
                    <span>
                      <span className="text-gray-900">{p.display_name}</span>
                      {p.discount_bp > 0 ? (
                        <span className="ml-1.5 inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                          save {(p.discount_bp / 100).toFixed(p.discount_bp % 100 ? 1 : 0)}%
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="text-right">
                    <div className="text-xs font-semibold tabular-nums text-gray-900">{fmtCents(discounted)} / yr</div>
                    {p.installments > 1 ? (
                      <div className="text-[10px] text-gray-500 tabular-nums">{fmtCents(perInstall)} × {p.installments}</div>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Addons */}
      {selectedGrid && selectedGrid.addons.length > 0 ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Add-ons</div>
          <div className="space-y-1.5">
            {selectedGrid.addons.map((a) => {
              const isPaid = paidAddonCats.has(a.key);
              const isLocked = a.required || isPaid;
              return (
                <label
                  key={a.key}
                  className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                    isPaid
                      ? 'border-blue-200 bg-blue-50/40 cursor-default'
                      : 'border-gray-200 bg-white cursor-pointer hover:bg-gray-50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50/40'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={addonKeys.has(a.key)}
                      disabled={isLocked}
                      onChange={(e) => {
                        const next = new Set(addonKeys);
                        if (e.target.checked) next.add(a.key);
                        else next.delete(a.key);
                        setAddonKeys(next);
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-emerald-600"
                    />
                    <span className="text-gray-900">
                      {a.label}
                      {a.required && !isPaid ? <span className="ml-1 text-[10px] text-gray-500">(required)</span> : null}
                      {isPaid ? (
                        <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                          ✓ Already paid
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className={`text-xs font-semibold tabular-nums ${isPaid ? 'text-blue-700 line-through' : 'text-emerald-700'}`}>
                    {fmtCents(a.amount_cents)}
                  </span>
                </label>
              );
            })}
          </div>
          {/* If any addon is paid, surface a brief explainer so the
              parent understands why their total doesn't include it. */}
          {selectedGrid.addons.some((a) => paidAddonCats.has(a.key)) ? (
            <p className="mt-2 text-[11px] text-gray-500 italic">
              Items marked "Already paid" were collected previously (e.g. at enrollment-contract signing) and are credited toward your total below.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Computed total */}
      {selectedGrid ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm">
          <div className="flex items-center justify-between font-semibold text-emerald-900">
            <span>Annual total{calcState.plan_label ? ` (${calcState.plan_label})` : ''}</span>
            <span className="tabular-nums">{fmtCents(calcState.total_cents)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SignatureTyped({ block, prefillCtx, legacyResponses }: { block: Extract<FormFieldBlock, { type: 'signature_typed' }>; prefillCtx: PrefillContext } & LegacyProp) {
  const defaultValue = (legacyVal(legacyResponses, block.key)
    ?? resolvePrefill(block.prefill, prefillCtx))
    || (typeof block.default === 'string' ? block.default : '');
  return (
    <div className="space-y-2">
      {block.acknowledgment ? (
        <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          {block.acknowledgment}
        </p>
      ) : null}
      <input
        type="text"
        name={block.key}
        required={block.required}
        defaultValue={defaultValue}
        placeholder="Type your full legal name"
        className={inputCls + ' font-serif italic'}
      />
      {/* Track when the signature was applied — server reads from form data */}
      <input type="hidden" name={`${block.key}_signed_at`} value={new Date().toISOString()} />
    </div>
  );
}

// Pre-signed operator signature — display-only, no submission data.
// Renders the signer's name in a script font with their title + the
// (fixed) date below. Used for school-side signatures that don't vary
// per parent (e.g. Head of School pre-signing a DHS Agreement that
// every family must sign).
function SignatureStamp({ block }: { block: Extract<FormFieldBlock, { type: 'signature_stamp' }> }) {
  const date = new Date(block.signed_date + 'T12:00:00');
  const dateLabel = Number.isNaN(date.getTime())
    ? block.signed_date
    : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <div className="mt-6 border-t border-gray-200 pt-5">
      <div
        className="text-4xl text-gray-900 leading-none"
        style={{ fontFamily: 'var(--font-signature), "Dancing Script", "Brush Script MT", "Lucida Handwriting", cursive' }}
      >
        {block.signer_name}
      </div>
      <div className="mt-1.5 text-xs text-gray-600 border-t border-gray-200 pt-1 inline-block min-w-[16rem]">
        <span className="font-semibold">{block.signer_name}</span>
        {block.signer_title ? <span className="text-gray-500"> — {block.signer_title}</span> : null}
        <span className="text-gray-500"> · Signed {dateLabel}</span>
      </div>
    </div>
  );
}
