// /new-application — landing page for EXISTING portal families applying
// for an additional child (a sibling not yet enrolled).
//
// Opt-in per school via settings.new_application_form_slug (also gates
// the nav item in the portal layout). The page explains who the
// application is for, shows the children already on file (no
// application needed for them), and links to the application form in
// the forms hub. The form itself handles the safe GHL writeback
// (next_empty_slot — new child lands in the first open student slot,
// existing children untouched).

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { FilePlus, Users, ArrowRight } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function NewApplicationPage() {
  const id = await requireParent();

  const { rows: cfg } = await query<{ slug: string | null }>(
    `SELECT settings->>'new_application_form_slug' AS slug FROM schools WHERE id = $1`,
    [id.parent.school_id],
  );
  const slug = cfg[0]?.slug;
  if (!slug) notFound();

  const { rows: formRows } = await query<{ display_name: string; description: string | null; is_active: boolean }>(
    `SELECT display_name, description, is_active FROM portal_form_definitions
      WHERE school_id = $1 AND slug = $2`,
    [id.parent.school_id, slug],
  );
  const form = formRows[0];
  if (!form || !form.is_active) notFound();

  const { rows: kids } = await query<{ name: string }>(
    `SELECT CONCAT_WS(' ', COALESCE(NULLIF(preferred_name,''), first_name), last_name) AS name
       FROM students
      WHERE family_id = $1 AND status = 'active'
      ORDER BY first_name`,
    [id.parent.family_id],
  );

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <FilePlus className="h-6 w-6" style={{ color: 'var(--brand)' }} />
        <h1 className="text-2xl font-bold text-gray-900">New Student Application</h1>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <p className="text-sm text-gray-700">
          Applying for a child who isn&rsquo;t enrolled yet? Complete the application below.
          It&rsquo;s the same admissions application new families fill out — but since your
          family is already with us, you only need to tell us about the <strong>new child</strong>.
          Your parent and family contact information is already on file and won&rsquo;t be
          asked for again (or changed).
        </p>

        {kids.length > 0 ? (
          <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
            <p className="text-xs font-semibold text-gray-600 flex items-center gap-1.5 mb-1">
              <Users className="h-3.5 w-3.5" /> Already on file — no application needed:
            </p>
            <p className="text-sm text-gray-800">{kids.map((k) => k.name).join(', ')}</p>
          </div>
        ) : null}

        {form.description ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{form.description}</p>
        ) : null}

        <p className="text-sm text-gray-700">
          After you submit, our admissions team reviews the application and will reach out
          about next steps. Applying for more than one new child? Submit one application
          per child.
        </p>

        <Link
          href={`/forms-v2/${encodeURIComponent(slug)}`}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          style={{ background: 'var(--brand)' }}
        >
          Start the application <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
