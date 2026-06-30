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
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface ResultRow {
  submission_id: string;
  is_test: boolean;
  family_id: string | null;
  form_display_name: string;
  form_slug: string;
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
  // The submission's student — surfaced so the confirmation can show the
  // grade + student ID the parent needs for FACTS account setup.
  student_first: string | null;
  student_last: string | null;
  student_preferred: string | null;
  student_grade: string | null;
  student_sid: string | null;
  // Co-sign state: 'awaiting' until the second guardian signs.
  cosign_status: string | null;
  cosign_name: string | null;
  cosign_email: string | null;
}

export default async function FormThanksPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const session = await readSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const { msg, err } = await searchParams;
  const msgBanner = msg === 'cosign_resent' ? (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      Signature request re-sent.
    </div>
  ) : err === 'cosign_resend_failed' ? (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      We couldn&rsquo;t resend the email just now. Please contact the school office.
    </div>
  ) : null;

  const { rows } = await query<ResultRow>(
    `SELECT s.id AS submission_id, s.is_test, s.family_id,
            d.display_name AS form_display_name,
            d.slug AS form_slug,
            d.confirmation_message,
            d.confirmation_redirect_url,
            st.first_name AS student_first,
            st.last_name AS student_last,
            st.preferred_name AS student_preferred,
            st.metadata->>'grade_level' AS student_grade,
            st.metadata->>'student_id' AS student_sid,
            s.cosign_status,
            s.cosign_name,
            s.cosign_email
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       LEFT JOIN students st ON st.id = s.student_id AND st.school_id = s.school_id
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

        {r.cosign_status === 'awaiting' ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-semibold mb-1">One more signature needed</div>
            We&rsquo;ve emailed{r.cosign_name ? <> <strong>{r.cosign_name}</strong></> : ' the second parent/guardian'}
            {r.cosign_email ? <> at <span className="font-mono">{r.cosign_email}</span></> : null} a secure link to review
            and add their signature. <strong>The enrollment isn&rsquo;t final until they sign.</strong> You&rsquo;ll get an
            email once it&rsquo;s fully complete.
            <form action="/api/portal-forms/cosign/resend" method="POST" className="mt-2">
              <input type="hidden" name="submission_id" value={r.submission_id} />
              <button type="submit" className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100">
                Didn&rsquo;t get it? Resend the email
              </button>
            </form>
          </div>
        ) : null}

        {msgBanner}

        {r.confirmation_message ? (
          <div className="rounded-md bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-800 whitespace-pre-wrap">
            {r.confirmation_message}
          </div>
        ) : (
          <p className="text-sm text-zinc-600">
            Your <strong>{r.form_display_name}</strong> submission was received. The office will be in touch if anything additional is needed.
          </p>
        )}

        {/* The grade + student ID the parent needs to set up FACTS — shown
            only when we have them on file for this submission's student. */}
        {(r.student_grade || r.student_sid) ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <div className="font-semibold mb-1.5">For your FACTS account setup:</div>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-y-1 gap-x-4">
              {(r.student_preferred || r.student_first) ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-emerald-700">Student</dt>
                  <dd className="font-semibold">{[(r.student_preferred || r.student_first), r.student_last].filter(Boolean).join(' ')}</dd>
                </div>
              ) : null}
              {r.student_grade ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-emerald-700">Grade</dt>
                  <dd className="font-semibold">{r.student_grade}</dd>
                </div>
              ) : null}
              {r.student_sid ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-emerald-700">Student ID</dt>
                  <dd className="font-semibold font-mono">{r.student_sid}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

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
