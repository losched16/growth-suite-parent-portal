// /cosign/[token] — public counter-signature page for Parent 2.
//
// No login: the token IS the credential (emailed to the co-signer). We show
// the completed agreement read-only so they see exactly what they're signing,
// Parent 1's signature, and a typed-signature box. Posting it hits
// /api/portal-forms/cosign which records the signature and finalizes.
//
// States: awaiting → show the agreement + sign box; signed → thank-you;
// missing/invalid token → a neutral "link isn't valid" message.

import { headers } from 'next/headers';
import { CheckCircle2, AlertCircle, ShieldCheck } from 'lucide-react';
import { query } from '@/lib/db';
import { loadBrandingByHost } from '@/lib/branding';
import type { FormFieldBlock } from '@/lib/forms/types';

export const dynamic = 'force-dynamic';

type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ err?: string }>;

interface Row {
  id: string;
  cosign_status: string | null;
  cosign_name: string | null;
  responses: Record<string, unknown> | null;
  form_name: string;
  field_schema: FormFieldBlock[];
  school_name: string;
  student: string | null;
  submitter: string | null;
}

function val(responses: Record<string, unknown>, key: string): string {
  const v = responses[key];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(String).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function Shell({
  children, brandColor,
}: { children: React.ReactNode; brandColor: string }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-10" style={{ ['--brand' as string]: brandColor }}>
      <div className="mx-auto w-full max-w-2xl">{children}</div>
    </main>
  );
}

export default async function CoSignPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const { err } = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const branding = await loadBrandingByHost(host);
  const brandColor = branding?.primary_color ?? '#047857';

  const { rows } = await query<Row>(
    `SELECT s.id, s.cosign_status, s.cosign_name, s.responses,
            d.display_name AS form_name, d.field_schema,
            sch.name AS school_name,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student,
            NULLIF(BTRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS submitter
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       JOIN schools sch ON sch.id = s.school_id
       LEFT JOIN students st ON st.id = s.student_id
       LEFT JOIN parents p ON p.id = s.parent_id
      WHERE s.cosign_token = $1
      LIMIT 1`,
    [token],
  );
  const row = rows[0];

  // Invalid / unknown token.
  if (!row) {
    return (
      <Shell brandColor={brandColor}>
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <AlertCircle className="mx-auto h-8 w-8 text-amber-500" />
          <h1 className="mt-3 text-xl font-semibold text-zinc-900">This signing link isn&rsquo;t valid</h1>
          <p className="mt-2 text-sm text-zinc-600">
            The link may have expired or already been used. If you believe this is a mistake, contact the school office.
          </p>
        </div>
      </Shell>
    );
  }

  // Already signed.
  if (row.cosign_status === 'signed') {
    return (
      <Shell brandColor={brandColor}>
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
          <h1 className="mt-3 text-xl font-semibold text-zinc-900">All signed — thank you!</h1>
          <p className="mt-2 text-sm text-zinc-600">
            Your signature on the <strong>{row.form_name}</strong>{row.student ? <> for {row.student}</> : null} at {row.school_name} has been recorded.
            The agreement is now fully signed. You can close this page.
          </p>
        </div>
      </Shell>
    );
  }

  // Awaiting → render the completed agreement read-only + the sign box.
  const responses = row.responses ?? {};
  const schema = Array.isArray(row.field_schema) ? row.field_schema : [];
  const submitter = row.submitter ?? 'The other parent/guardian';

  return (
    <Shell brandColor={brandColor}>
      <div className="space-y-4">
        <header className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-7 w-7 shrink-0" style={{ color: brandColor }} />
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">Add your signature</h1>
              <p className="mt-1 text-sm text-zinc-600">
                {submitter} completed and signed the <strong>{row.form_name}</strong>
                {row.student ? <> for <strong>{row.student}</strong></> : null} at {row.school_name}.
                Because you share legal decision-making authority, your signature is needed to finalize it.
                Please review the completed agreement below, then sign.
              </p>
            </div>
          </div>
        </header>

        {/* Read-only completed agreement */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Completed agreement</h2>
          <div className="space-y-2 text-sm">
            {schema.map((block, i) => (
              <ReadOnlyBlock key={i} block={block} responses={responses} brandColor={brandColor} />
            ))}
          </div>
        </section>

        {/* Signature box */}
        <section className="rounded-xl border-2 bg-white p-6 shadow-sm" style={{ borderColor: brandColor }}>
          <h2 className="text-base font-semibold text-zinc-900">Your signature</h2>
          {err === 'missing_signature' ? (
            <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              Please type your full legal name to sign.
            </div>
          ) : null}
          <form action="/api/portal-forms/cosign" method="POST" className="mt-3 space-y-3">
            <input type="hidden" name="token" value={token} />
            <label htmlFor="signature" className="block text-sm font-medium text-zinc-700">
              Type your full legal name to sign:
            </label>
            <input
              id="signature" name="signature" type="text" required autoFocus
              defaultValue={row.cosign_name ?? ''}
              placeholder="Your full legal name"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2"
              style={{ ['--tw-ring-color' as string]: brandColor }}
            />
            <p className="text-xs text-zinc-500">
              By typing my full legal name above, I agree that this constitutes my legal electronic signature —
              equivalent to a handwritten signature — and that I have read, understand, and agree to this agreement.
            </p>
            <button
              type="submit"
              className="rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              style={{ background: brandColor }}
            >
              Sign &amp; finalize
            </button>
          </form>
        </section>
      </div>
    </Shell>
  );
}

// One block of the completed agreement, read-only.
function ReadOnlyBlock({
  block, responses, brandColor,
}: { block: FormFieldBlock; responses: Record<string, unknown>; brandColor: string }) {
  const b = block as FormFieldBlock & {
    type: string; key?: string; label?: string; text?: string;
  };

  if (b.type === 'header') {
    return b.text || b.label ? <h2 className="pt-2 text-lg font-semibold text-zinc-900">{b.text || b.label}</h2> : null;
  }
  if (b.type === 'section') {
    return b.label ? (
      <h3 className="mt-4 border-b border-zinc-100 pb-1 text-sm font-semibold" style={{ color: brandColor }}>{b.label}</h3>
    ) : null;
  }
  if (b.type === 'paragraph') {
    return b.text ? <p className="text-xs leading-relaxed text-zinc-500 whitespace-pre-wrap">{b.text}</p> : null;
  }
  if (!b.key) return null;

  const v = val(responses, b.key);

  if (b.type === 'checkbox') {
    const checked = v === '1' || v.toLowerCase() === 'yes' || v === 'true';
    return (
      <div className="flex items-start gap-2">
        <span className={checked ? 'text-emerald-600' : 'text-zinc-300'}>{checked ? '☑' : '☐'}</span>
        <span className="text-zinc-700">{b.label}</span>
      </div>
    );
  }

  if (b.type === 'signature_typed' || b.type === 'signature_drawn') {
    if (!v) return null;
    const signedAt = val(responses, `${b.key}_signed_at`);
    return (
      <div className="rounded-md bg-zinc-50 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{b.label || 'Signature'}</div>
        <div className="font-semibold text-zinc-900" style={{ fontFamily: 'cursive' }}>{v}</div>
        {signedAt ? <div className="text-[11px] text-zinc-400">Signed {signedAt.slice(0, 10)}</div> : null}
      </div>
    );
  }

  // Generic labeled value — skip empties to keep the review clean.
  if (!v) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-zinc-500">{b.label}:</span>
      <span className="font-medium text-zinc-900">{v}</span>
    </div>
  );
}
