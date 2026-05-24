// /forms-v2/history — every submission this family has made.
//
// Lists newest-first with submitter, student, status, and links to
// print / re-submit. Voided / refunded submissions show with a strike
// so the parent can see what happened.

import Link from 'next/link';
import { ArrowLeft, Printer, FileText, AlertTriangle } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface SubRow {
  id: string;
  form_definition_id: string;
  form_slug: string;
  form_name: string;
  student_first_name: string | null;
  student_last_name: string | null;
  student_preferred_name: string | null;
  parent_first_name: string;
  parent_last_name: string;
  status: string;
  submitted_at: string;
  voided_at: string | null;
  voided_reason: string | null;
  fee_amount_charged: string | null;
  payment_status: string | null;
  is_addendum: boolean;
  parent_submission_id: string | null;
  addendum_fields: string[] | null;
}

type SearchParams = Promise<{ submitted?: string }>;

export default async function FormsHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const { submitted } = await searchParams;

  const rows = (await query<SubRow>(
    `SELECT
       s.id,
       s.form_definition_id,
       d.slug AS form_slug,
       d.display_name AS form_name,
       st.first_name AS student_first_name,
       st.last_name AS student_last_name,
       st.preferred_name AS student_preferred_name,
       p.first_name AS parent_first_name,
       p.last_name AS parent_last_name,
       s.status,
       s.submitted_at,
       s.voided_at,
       s.voided_reason,
       s.fee_amount_charged,
       s.payment_status,
       s.is_addendum,
       s.parent_submission_id,
       s.addendum_fields
     FROM portal_form_submissions s
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     LEFT JOIN students st ON st.id = s.student_id
     LEFT JOIN parents p ON p.id = s.parent_id
     WHERE s.family_id = $1
     ORDER BY s.submitted_at DESC
     LIMIT 200`,
    [id.parent.family_id],
  )).rows;

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <Link
          href="/forms-v2"
          className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="h-3 w-3" /> Back to forms
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Submission history</h1>
        <p className="mt-1 text-sm text-gray-600">
          {rows.length === 0
            ? 'You haven\'t submitted any forms yet.'
            : `${rows.length} ${rows.length === 1 ? 'submission' : 'submissions'} on file for your family.`}
        </p>
      </header>

      {submitted ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Submitted! Your latest entry is at the top.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <p className="text-sm text-gray-600">No submissions yet.</p>
          <Link
            href="/forms-v2"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: 'var(--brand)' }}
          >
            Browse forms
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {rows.map((r) => <HistoryRow key={r.id} r={r} />)}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({ r }: { r: SubRow }) {
  const voided = r.status === 'voided';
  const studentName = r.student_first_name
    ? `${r.student_preferred_name || r.student_first_name} ${r.student_last_name}`
    : null;

  return (
    <li
      className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
        r.is_addendum ? 'border-l-4 border-violet-300 bg-violet-50/30 ml-4' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/forms-v2/print/${r.id}`}
            className={`text-sm font-medium hover:underline ${voided ? 'text-gray-500 line-through' : 'text-gray-900'}`}
          >
            {r.is_addendum ? '↳ ' : ''}{r.form_name}
          </Link>
          <StatusBadge status={r.status} paymentStatus={r.payment_status} />
          {r.is_addendum ? (
            <span
              className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800"
              title={r.addendum_fields && r.addendum_fields.length > 0
                ? `Updated ${r.addendum_fields.length} field${r.addendum_fields.length === 1 ? '' : 's'}: ${r.addendum_fields.join(', ')}`
                : 'Partial update of an earlier submission'}
            >
              ✎ Partial update
              {r.addendum_fields ? ` (${r.addendum_fields.length})` : ''}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-500">
          {fmtDateTime(r.submitted_at)}
          {studentName ? ` · for ${studentName}` : ''}
          {' · by '}{r.parent_first_name} {r.parent_last_name}
          {r.fee_amount_charged && Number(r.fee_amount_charged) > 0
            ? ` · $${Number(r.fee_amount_charged).toFixed(2)}`
            : ''}
        </div>
        {voided && r.voided_reason ? (
          <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-red-700">
            <AlertTriangle className="h-3 w-3" /> Voided: {r.voided_reason}
          </div>
        ) : null}
      </div>
      <Link
        href={`/forms-v2/print/${r.id}`}
        className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
      >
        <Printer className="h-3 w-3" /> View / print
      </Link>
    </li>
  );
}

function StatusBadge({ status, paymentStatus }: { status: string; paymentStatus: string | null }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    submitted: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Submitted' },
    paid: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Paid' },
    pending_payment: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending payment' },
    draft: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Draft' },
    voided: { bg: 'bg-red-100', text: 'text-red-800', label: 'Voided' },
  };
  const cfg = map[status] ?? { bg: 'bg-gray-100', text: 'text-gray-700', label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cfg.text}`}>
      {cfg.label}
      {paymentStatus && status !== 'voided' && paymentStatus !== 'paid' ? ` · ${paymentStatus}` : ''}
    </span>
  );
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
