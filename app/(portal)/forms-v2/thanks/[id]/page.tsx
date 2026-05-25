// /forms-v2/thanks/[id] — parent landing page after a successful
// non-payment form submission. Renders the school's custom
// confirmation message (if configured) and, if a confirmation_redirect_url
// is set, auto-redirects to it after 3 seconds while showing a
// manual "Continue" button as a fallback.
//
// Reached via FormRenderer's router.push after a 2xx submit. This page
// is read-only — no DB writes happen here.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CheckCircle2, ExternalLink, Home } from 'lucide-react';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

interface ResultRow {
  submission_id: string;
  is_test: boolean;
  family_id: string | null;
  form_display_name: string;
  form_slug: string;
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
}

export default async function FormThanksPage({ params }: { params: Params }) {
  const session = await readSession();
  if (!session) redirect('/login');

  const { id } = await params;

  const { rows } = await query<ResultRow>(
    `SELECT s.id AS submission_id, s.is_test, s.family_id,
            d.display_name AS form_display_name,
            d.slug AS form_slug,
            d.confirmation_message,
            d.confirmation_redirect_url
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.id = $1 AND s.school_id = $2`,
    [id, session.school_id],
  );
  if (rows.length === 0) notFound();
  const r = rows[0];

  // Hard guard: a parent must own this submission (or it's a test row
  // which has no family — shouldn't reach the parent portal anyway).
  if (!r.is_test && r.family_id && r.family_id !== session.family_id) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-zinc-50 flex items-start justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white shadow-sm p-6 sm:p-8 space-y-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-7 w-7 text-emerald-600 mt-1 shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Thanks — we got your form!</h1>
            <p className="text-xs text-zinc-500 mt-1">
              Submitted just now &middot; <span className="font-mono">{r.form_slug}</span>
            </p>
          </div>
        </div>

        {r.confirmation_message ? (
          <div className="rounded-md bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-800 whitespace-pre-wrap">
            {r.confirmation_message}
          </div>
        ) : (
          <p className="text-sm text-zinc-600">
            Your <strong>{r.form_display_name}</strong> submission was received. The office will be in touch if anything additional is needed.
          </p>
        )}

        {r.confirmation_redirect_url ? (
          <>
            {/* HTML meta-refresh handles the auto-redirect without JS.
                When JS is on, the client-side ContinueButton below
                accelerates it for a snappy UX. */}
            <meta httpEquiv="refresh" content={`3;url=${r.confirmation_redirect_url}`} />
            <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-center justify-between gap-3 flex-wrap">
              <span>
                Redirecting you to your school&rsquo;s next-steps page in a moment&hellip;
              </span>
              <a
                href={r.confirmation_redirect_url}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Continue now <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        ) : null}

        <div className="flex items-center gap-3 pt-2 border-t border-zinc-100 text-sm">
          <Link
            href="/home"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-zinc-700 hover:bg-zinc-50"
          >
            <Home className="h-4 w-4" /> Back to your portal
          </Link>
          <Link
            href="/forms-v2/history"
            className="text-zinc-600 hover:text-zinc-800 hover:underline"
          >
            View your submissions
          </Link>
        </div>
      </div>
    </main>
  );
}
