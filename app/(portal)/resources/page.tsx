// /resources — school-uploaded reference materials (supply lists,
// calendar, parent handbook, classroom info, etc.).
//
// Read-only for parents — they download / view. Schools manage the
// list from /school/{locationId}/resources in the operator dashboard.
// Listed in document categories (the school sets these on upload);
// items without a category fall into "Other".

import Link from 'next/link';
import { FileText, FileImage, FileSpreadsheet, Download, BookOpen, Folder } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface DocRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

export default async function ResourcesPage() {
  const id = await requireParent();

  const { rows } = await query<DocRow>(
    `SELECT id, title, description, category, original_filename, mime_type,
            size_bytes, uploaded_at
       FROM school_documents
      WHERE school_id = $1 AND is_active = true
      ORDER BY COALESCE(NULLIF(category,''), 'zzz_other'),
               position, title`,
    [id.parent.school_id],
  );

  // Group by category; items with null/empty category land in "Other".
  const byCategory = new Map<string, DocRow[]>();
  for (const d of rows) {
    const cat = d.category && d.category.trim() ? d.category : 'Other';
    const ex = byCategory.get(cat) ?? [];
    ex.push(d);
    byCategory.set(cat, ex);
  }
  // Sort categories alphabetically but pin "Other" to the bottom.
  const categories = [...byCategory.keys()].sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">{id.branding.nav_labels?.['/resources'] ?? 'Important Documents'}</h1>
        <p className="text-sm text-gray-600">
          Helpful reference materials from {id.school.name} — calendars,
          handbooks, supply lists, schedules, and other docs to keep handy.
          Click to view, or use the download button to save a copy.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <Folder className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h2 className="text-base font-semibold text-gray-900">Nothing here yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Your school hasn&apos;t posted any documents here yet. Things like the
            supply list, school calendar, and parent handbook will appear here
            once they&apos;re uploaded.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {categories.map((cat) => (
            <section key={cat} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {cat}
              </h2>
              <ul className="space-y-2">
                {(byCategory.get(cat) ?? []).map((d) => (
                  <DocRow key={d.id} doc={d} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function DocRow({ doc }: { doc: DocRow }) {
  const Icon = pickIcon(doc.mime_type);
  const viewHref = `/api/school-resources/${doc.id}`;
  const downloadHref = `/api/school-resources/${doc.id}?download=1`;
  return (
    <li>
      <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-gray-300 hover:bg-gray-50/50 transition">
        <div className="mt-0.5 text-gray-400">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={viewHref}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm font-semibold text-gray-900 hover:underline"
            style={{ color: 'var(--brand, #047857)' }}
          >
            {doc.title}
          </Link>
          {doc.description ? (
            <p className="mt-0.5 text-xs text-gray-600">{doc.description}</p>
          ) : null}
          <p className="mt-0.5 text-[11px] text-gray-500">
            {doc.original_filename} · {fmtBytes(doc.size_bytes)} · added {fmtDate(doc.uploaded_at)}
          </p>
        </div>
        <a
          href={downloadHref}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          download
          title="Download a copy"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </a>
      </div>
    </li>
  );
}

function pickIcon(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') {
    return FileSpreadsheet;
  }
  if (mime === 'application/pdf') return BookOpen;
  return FileText;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
