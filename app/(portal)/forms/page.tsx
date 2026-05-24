// /forms — completion tracker + click-through to fill missing forms.
//
// Each form row shows:
//   - title + description
//   - completion badge (Complete / Pending) — with date if known
//   - "Fill out this form" button (links to school's hosted form URL)
// Per-student forms expand to show one status per student.

import { CheckCircle2, Circle, FileText, ExternalLink, AlertCircle, Upload, Download, Trash2, Paperclip } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { loadFormsForFamily, type FormStatus } from '@/lib/form-tracker';
import { loadFamilyUploads, type UploadRow } from '@/lib/uploads-list';
import { loadStudentsForFamily } from '@/lib/family-data';
import { uploadDocumentAction, deleteUploadAction } from '@/lib/actions/upload-document';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function FormsPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const { msg, err } = await searchParams;
  const [result, uploads, students, schoolForms] = await Promise.all([
    loadFormsForFamily({
      schoolId: id.parent.school_id,
      familyId: id.parent.family_id,
      parentId: id.parent.id,
    }),
    loadFamilyUploads(id.parent.family_id),
    loadStudentsForFamily(id.parent.family_id),
    query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM school_forms
       WHERE school_id = $1 AND is_active = true ORDER BY position, display_name`,
      [id.parent.school_id],
    ).then((r) => r.rows),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Forms &amp; Documents</h1>
        <p className="mt-1 text-sm text-gray-600">
          {result.total === 0
            ? 'No forms configured by your school yet.'
            : `${result.completed} of ${result.total} forms complete (${result.pct_complete}%)`}
        </p>
      </header>

      {msg ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
      ) : null}
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      {/* Progress bar */}
      {result.total > 0 ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${result.pct_complete}%`, background: 'var(--brand)' }}
          />
        </div>
      ) : null}

      {/* Forms list */}
      {result.forms.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h2 className="text-base font-semibold text-gray-900">No forms yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Your school hasn&apos;t added any forms to track here yet. Check back later or
            {id.branding.support_email ? (
              <> reach out to{' '}
              <a href={`mailto:${id.branding.support_email}`} className="underline" style={{ color: 'var(--brand)' }}>
                {id.branding.support_email}
              </a>{' '}with questions.</>
            ) : (
              <> ask the school office.</>
            )}
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          {result.forms.map((f) => <FormCard key={f.form.id} status={f} />)}
        </section>
      )}

      {/* Documents area — real uploads */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">Documents</h2>
          <span className="text-[11px] text-gray-500">
            {uploads.length} upload{uploads.length === 1 ? '' : 's'} · max 10 MB per file
          </span>
        </div>

        {/* Upload form */}
        <form action={uploadDocumentAction} encType="multipart/form-data" className="space-y-2 border-b border-gray-100 bg-gray-50 px-5 py-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">File</span>
              <input
                type="file"
                name="file"
                required
                accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx,.xls,.xlsx,.txt,application/pdf,image/*,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                className="mt-0.5 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white"
                style={{ ['--file-bg' as string]: 'var(--brand)' }}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Display name (optional)</span>
              <input
                type="text"
                name="display_name"
                placeholder="e.g. Immunization records — fall checkup"
                maxLength={200}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">For student (optional)</span>
              <select
                name="student_id"
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
              >
                <option value="">— family-wide —</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.preferred_name || s.first_name} {s.last_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">For form (optional)</span>
              <select
                name="form_id"
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
              >
                <option value="">— not tied to a form —</option>
                {schoolForms.map((f) => (
                  <option key={f.id} value={f.id}>{f.display_name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Notes (optional)</span>
            <input
              type="text"
              name="notes"
              placeholder="Anything the school office should know"
              maxLength={1000}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--brand)' }}
          >
            <Upload className="h-4 w-4" /> Upload document
          </button>
        </form>

        {/* List */}
        {uploads.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-500">
            No documents uploaded yet. Use the form above to send the school an immunization record,
            custody paper, medical form, or anything else they&apos;ve asked for.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {uploads.map((u) => <UploadRowItem key={u.id} u={u} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function UploadRowItem({ u }: { u: UploadRow }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <a
            href={`/api/uploads/${u.id}`}
            className="font-medium text-gray-900 hover:underline"
          >
            {u.display_name}
          </a>
          {u.acknowledged_at ? (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
              acknowledged
            </span>
          ) : u.ghl_synced_at ? (
            <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700">
              sent to school
            </span>
          ) : u.ghl_sync_error ? (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800" title={u.ghl_sync_error}>
              syncing…
            </span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
              sending…
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-500">
          {fmtBytes(u.size_bytes)} · {fmtMime(u.mime_type)} · uploaded {fmtRelative(u.uploaded_at)}
          {u.uploaded_by_name ? ` by ${u.uploaded_by_name}` : ''}
          {u.student_name ? ` · for ${u.student_name}` : ''}
          {u.form_name ? ` · for "${u.form_name}"` : ''}
        </div>
        {u.notes ? <div className="mt-0.5 text-[11px] text-gray-600 italic">&ldquo;{u.notes}&rdquo;</div> : null}
      </div>
      <a
        href={`/api/uploads/${u.id}`}
        className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
      >
        <Download className="h-3 w-3" /> Download
      </a>
      <form action={deleteUploadAction}>
        <input type="hidden" name="upload_id" value={u.id} />
        <button
          type="submit"
          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </form>
    </li>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMime(m: string): string {
  if (m === 'application/pdf') return 'PDF';
  if (m.startsWith('image/')) return m.slice(6).toUpperCase();
  if (m.includes('wordprocessingml')) return 'DOCX';
  if (m.includes('spreadsheetml')) return 'XLSX';
  if (m === 'application/msword') return 'DOC';
  if (m === 'application/vnd.ms-excel') return 'XLS';
  if (m === 'text/plain') return 'TXT';
  return m;
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return d.toLocaleDateString();
}

function FormCard({ status }: { status: FormStatus }) {
  const f = status.form;
  return (
    <article className={`overflow-hidden rounded-lg border ${status.is_complete ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5">
          {status.is_complete ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <Circle className="h-5 w-5 text-gray-300" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{f.display_name}</h3>
            <StatusBadge isComplete={status.is_complete} />
          </div>
          {f.description ? (
            <p className="mt-1 text-xs text-gray-600">{f.description}</p>
          ) : null}

          {/* Per-student detail */}
          {f.per_student && status.per_student_statuses.length > 0 ? (
            <ul className="mt-2 divide-y divide-gray-100 rounded border border-gray-100 bg-white text-xs">
              {status.per_student_statuses.map((ps) => (
                <li key={ps.student_id} className="flex items-center justify-between px-3 py-1.5">
                  <span className="font-medium text-gray-900">{ps.student_name}</span>
                  <span className="flex items-center gap-1.5">
                    {ps.completed ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                        <span className="text-emerald-700">Complete{ps.completed_value ? ` · ${fmtMaybeDate(ps.completed_value)}` : ''}</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-3 w-3 text-amber-500" />
                        <span className="text-amber-700">Pending</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Family-level completion timestamp */}
          {!f.per_student && status.family_status?.completed && status.family_status.completed_value ? (
            <p className="mt-1 text-[11px] text-emerald-700">
              Submitted {fmtMaybeDate(status.family_status.completed_value)}
            </p>
          ) : null}

          {/* Fill-out button */}
          {f.fill_out_url && !status.is_complete ? (
            <div className="mt-3">
              <a
                href={f.fill_out_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: 'var(--brand)' }}
              >
                Fill out this form <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ) : f.fill_out_url && status.is_complete ? (
            <div className="mt-3">
              <a
                href={f.fill_out_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline text-gray-500 hover:text-gray-700"
              >
                Re-submit if needed
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function StatusBadge({ isComplete }: { isComplete: boolean }) {
  if (isComplete) {
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
        Complete
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
      Pending
    </span>
  );
}

function fmtMaybeDate(s: string): string {
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return s;
}
