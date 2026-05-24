// /forms-v2/print/{id} — printable HTML view of a single submission.
//
// Renders the form definition's display blocks side-by-side with the
// parent's saved responses. Drawn signatures show inline as <img>;
// typed signatures show italic serif with the signed-at timestamp.
// File uploads link to /api/portal-forms/file/{id}.
//
// Designed for browser "Print → Save as PDF". A small action bar (no-print)
// at the top has a Print button + Back link.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import type { FormFieldBlock } from '@/lib/forms/types';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';

interface SubRow {
  id: string;
  family_id: string;
  school_id: string;
  form_definition_id: string;
  form_slug: string;
  form_name: string;
  form_description: string | null;
  field_schema: FormFieldBlock[];
  student_first_name: string | null;
  student_last_name: string | null;
  student_preferred_name: string | null;
  parent_first_name: string;
  parent_last_name: string;
  parent_email: string | null;
  responses: Record<string, unknown>;
  status: string;
  academic_year: string;
  submitted_at: string;
  voided_at: string | null;
  voided_reason: string | null;
  fee_amount_charged: string | null;
  payment_status: string | null;
}

interface FileRow {
  id: string;
  field_key: string;
  display_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
}

type PageParams = Promise<{ id: string }>;

export default async function PrintSubmissionPage({ params }: { params: PageParams }) {
  const { id: submissionId } = await params;
  const me = await requireParent();

  const subs = (await query<SubRow>(
    `SELECT
       s.id, s.family_id, s.school_id, s.form_definition_id,
       d.slug AS form_slug, d.display_name AS form_name,
       d.description AS form_description, d.field_schema,
       st.first_name AS student_first_name, st.last_name AS student_last_name,
       st.preferred_name AS student_preferred_name,
       p.first_name AS parent_first_name, p.last_name AS parent_last_name,
       p.email AS parent_email,
       s.responses, s.status, s.academic_year, s.submitted_at,
       s.voided_at, s.voided_reason, s.fee_amount_charged, s.payment_status
     FROM portal_form_submissions s
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     LEFT JOIN students st ON st.id = s.student_id
     LEFT JOIN parents p ON p.id = s.parent_id
     WHERE s.id = $1`,
    [submissionId],
  )).rows;
  const sub = subs[0];
  if (!sub) notFound();
  if (sub.family_id !== me.parent.family_id) notFound();

  const files = (await query<FileRow>(
    `SELECT id, field_key, display_name, original_filename, mime_type, size_bytes
     FROM portal_form_submission_files
     WHERE submission_id = $1
     ORDER BY uploaded_at`,
    [sub.id],
  )).rows;
  const filesByField = new Map<string, FileRow[]>();
  for (const f of files) {
    const ex = filesByField.get(f.field_key) ?? [];
    ex.push(f);
    filesByField.set(f.field_key, ex);
  }

  const studentName = sub.student_first_name
    ? `${sub.student_preferred_name || sub.student_first_name} ${sub.student_last_name}`
    : null;

  return (
    <div className="bg-white text-gray-900">
      {/* Print-only stylesheet — strip the portal chrome on print */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print { display: none !important; }
          body, html { background: #fff !important; }
          .print-container { padding: 0 !important; }
          .print-page { box-shadow: none !important; border: none !important; }
        }
      ` }} />

      {/* Action bar */}
      <div className="no-print flex flex-wrap items-center gap-2 mb-4">
        <Link href="/forms-v2/history" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-3 w-3" /> Back to history
        </Link>
        <div className="flex-1" />
        <PrintButton />
      </div>

      <article className="print-page rounded-lg border border-gray-200 bg-white p-8 max-w-3xl mx-auto print-container">
        <header className="border-b border-gray-200 pb-4 mb-5">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-xl font-semibold">{sub.form_name}</h1>
            <span className="text-[11px] uppercase tracking-wide text-gray-500">
              {sub.status} · {sub.academic_year}
            </span>
          </div>
          {sub.form_description ? (
            <p className="mt-2 text-xs text-gray-600 whitespace-pre-wrap">{sub.form_description}</p>
          ) : null}
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
            <dt className="text-gray-500">Submitted</dt>
            <dd>{fmtDateTime(sub.submitted_at)}</dd>
            <dt className="text-gray-500">Submitted by</dt>
            <dd>{sub.parent_first_name} {sub.parent_last_name}{sub.parent_email ? ` (${sub.parent_email})` : ''}</dd>
            {studentName ? (<>
              <dt className="text-gray-500">For student</dt>
              <dd>{studentName}</dd>
            </>) : null}
            {sub.fee_amount_charged && Number(sub.fee_amount_charged) > 0 ? (<>
              <dt className="text-gray-500">Fee</dt>
              <dd>${Number(sub.fee_amount_charged).toFixed(2)}{sub.payment_status ? ` · ${sub.payment_status}` : ''}</dd>
            </>) : null}
            {sub.voided_at ? (<>
              <dt className="text-gray-500">Voided</dt>
              <dd className="text-red-700">{fmtDateTime(sub.voided_at)}{sub.voided_reason ? ` — ${sub.voided_reason}` : ''}</dd>
            </>) : null}
          </dl>
        </header>

        <div className="space-y-4">
          {sub.field_schema.map((block, i) => (
            <PrintBlock
              key={i}
              block={block}
              responses={sub.responses}
              filesByField={filesByField}
            />
          ))}
        </div>

        <footer className="mt-8 border-t border-gray-200 pt-3 text-[10px] text-gray-500">
          Form ID: {sub.id} · Definition: {sub.form_slug}
        </footer>
      </article>
    </div>
  );
}

function PrintBlock({
  block, responses, filesByField,
}: {
  block: FormFieldBlock;
  responses: Record<string, unknown>;
  filesByField: Map<string, { id: string; display_name: string; original_filename: string; mime_type: string; size_bytes: number }[]>;
}) {
  switch (block.type) {
    case 'header':
      return <h2 className="text-base font-semibold border-b border-gray-100 pb-1 mt-4">{block.text}</h2>;
    case 'paragraph':
      return <p className="text-xs text-gray-700 whitespace-pre-wrap">{block.text}</p>;
    case 'section':
      return (
        <div className="border-t border-gray-200 pt-2">
          <h3 className="text-sm font-semibold">{block.label}</h3>
          {block.description ? <p className="text-[11px] text-gray-500">{block.description}</p> : null}
        </div>
      );
  }

  // All other blocks have a key + label.
  const value = responses[block.key];

  return (
    <div className="grid grid-cols-3 gap-3 text-sm">
      <div className="text-xs font-medium text-gray-500 pt-0.5">{block.label}</div>
      <div className="col-span-2">
        <ResponseValue block={block} value={value} files={filesByField.get(block.key) ?? []} responses={responses} />
      </div>
    </div>
  );
}

function ResponseValue({
  block, value, files, responses,
}: {
  block: FormFieldBlock;
  value: unknown;
  files: { id: string; display_name: string; original_filename: string; mime_type: string; size_bytes: number }[];
  responses: Record<string, unknown>;
}) {
  if (!('key' in block)) return null;

  switch (block.type) {
    case 'signature_drawn': {
      const v = typeof value === 'string' ? value : '';
      if (v.startsWith('data:image/')) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v} alt="signature" className="h-16 border border-gray-300 rounded bg-white" />
        );
      }
      return <em className="text-gray-400">no signature</em>;
    }
    case 'signature_typed': {
      const v = typeof value === 'string' ? value : '';
      const signedAt = typeof responses[`${block.key}_signed_at`] === 'string'
        ? String(responses[`${block.key}_signed_at`]) : null;
      if (!v) return <em className="text-gray-400">no signature</em>;
      return (
        <div>
          <span className="font-serif italic text-base">{v}</span>
          {signedAt ? (
            <span className="ml-2 text-[10px] text-gray-500">signed {fmtDateTime(signedAt)}</span>
          ) : null}
        </div>
      );
    }
    case 'multi_checkbox': {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length === 0) return <em className="text-gray-400">none</em>;
      return <span>{arr.map((v) => labelFor(block.options, String(v))).join(', ')}</span>;
    }
    case 'checkbox':
      return value === true ? <span>✓ Yes</span> : <em className="text-gray-400">no</em>;
    case 'file_upload': {
      if (files.length === 0) return <em className="text-gray-400">no file</em>;
      return (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id}>
              <a
                href={`/api/portal-forms/file/${f.id}?inline=1`}
                className="inline-flex items-center gap-1 text-blue-700 underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Paperclip className="h-3 w-3" />
                {f.original_filename}
                <span className="text-[10px] text-gray-500 ml-1">({fmtBytes(f.size_bytes)})</span>
              </a>
            </li>
          ))}
        </ul>
      );
    }
    case 'select':
    case 'radio': {
      const v = typeof value === 'string' ? value : '';
      if (!v) return <em className="text-gray-400">—</em>;
      return <span>{labelFor(block.options, v)}</span>;
    }
    default: {
      if (value == null || value === '') return <em className="text-gray-400">—</em>;
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    }
  }
}

function labelFor(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
