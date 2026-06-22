// /help — in-portal walkthrough for parents. First-time visitors land
// here from the welcome email's "How does this work?" link; returning
// parents can open it from the Help nav item any time.
//
// Layout: progressive disclosure via native <details> so a parent can
// scan section headers and only open what they need. No client JS.

import Link from 'next/link';
import { BookOpen, HelpCircle, Mail, Phone, Users, FileText, Heart, ShieldCheck, Lock } from 'lucide-react';
import { requireParent } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export default async function HelpPage() {
  const id = await requireParent();
  const b = id.branding;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <BookOpen className="h-6 w-6" style={{ color: 'var(--brand)' }} />
          Help &amp; Walkthrough
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          A quick guide to the {b.display_name} Family Portal. Most parents only need
          the first two sections — the rest is here if you need it.
        </p>
      </header>

      {/* Quick start — everyone reads this */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: 'var(--brand)' }}>1</span>
          Quick start — your first 5 minutes
        </h2>
        <ol className="mt-3 space-y-2 text-sm text-gray-700 list-decimal pl-5">
          <li>
            <span className="font-medium">Open your Home page.</span>{' '}
            <Link href="/home" className="underline" style={{ color: 'var(--brand-fg)' }}>Go now →</Link>
            <br />
            <span className="text-[12px] text-gray-500">
              It shows your kids, the forms you still need to submit, and your contact info at a glance.
            </span>
          </li>
          <li>
            <span className="font-medium">Look for anything in red or yellow.</span>
            <br />
            <span className="text-[12px] text-gray-500">
              Green check ✓ means you&rsquo;re done. A red or yellow badge means we&rsquo;re still
              missing something — usually a form for the upcoming school year.
            </span>
          </li>
          <li>
            <span className="font-medium">Tap each missing form and fill it out.</span>
            <br />
            <span className="text-[12px] text-gray-500">
              Most fields will pre-fill from what you submitted in previous years. You can
              save and come back later — your progress sticks.
            </span>
          </li>
          <li>
            <span className="font-medium">Check your family record.</span>{' '}
            <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Open Family →</Link>
            <br />
            <span className="text-[12px] text-gray-500">
              Make sure both parents are listed, your phone is current, and your emergency
              contacts are who you want them to be.
            </span>
          </li>
        </ol>
      </section>

      {/* What's where — quick map */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">What&rsquo;s where</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MapCard
            icon={Users}
            title="Family"
            description="Your kids, your contact info, the other parent, emergency contacts, and pickup people."
            href="/family"
          />
          <MapCard
            icon={FileText}
            title="Forms"
            description="Every required form for the year. Green = done. Click into any form to fill it out or print a copy."
            href="/forms-v2"
          />
          <MapCard
            icon={BookOpen}
            title="Important Documents"
            description="Things the school wants you to be able to download — handbook, calendar, etc."
            href="/resources"
          />
        </div>
      </section>

      {/* FAQ — collapsible */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Common questions</h2>

        <div className="space-y-2">
          <FaqItem
            q="I already filled out everything last year — do I have to do it all again?"
            a={
              <>
                No. We pre-filled your forms with what you submitted before. Open each form
                to confirm it&rsquo;s still accurate and add anything new (an updated phone,
                a new allergy, etc.). If your Home page shows everything green, you&rsquo;re
                already done.
              </>
            }
          />
          <FaqItem
            q="The other parent / my spouse isn't listed on my family record. How do I add them?"
            a={
              <>
                Go to <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Family</Link>,
                scroll down to the <span className="font-medium">&ldquo;Add another parent&rdquo;</span> section
                (it&rsquo;s collapsed — click to open). Only their first and last name are
                required. If you want them to have their own portal access, add their email
                too — they can then sign in at the login page with that email and set their
                own password.
              </>
            }
          />
          <FaqItem
            q="Can my spouse / co-parent have their own login?"
            a={
              <>
                Yes. Each parent can sign in with their own email and their own password —
                they&rsquo;ll see the same family info you do. Make sure both parents are
                listed on the <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Family</Link> page
                with their email addresses, then each of you signs in separately and sets a
                password the first time.
              </>
            }
          />
          <FaqItem
            q="How do I add emergency contacts?"
            a={
              <>
                On the <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Family</Link> page
                there&rsquo;s an Emergency Contacts card. Click <span className="font-medium">Add contacts</span>{' '}
                (or <span className="font-medium">Edit / add more</span>) — it takes you to the
                Emergency Medical form where you can list up to 5 contacts, plus a free-form
                section for any extras. You can also set a contact to apply to only some of
                your kids (useful for blended families).
              </>
            }
          />
          <FaqItem
            q="Who can pick up my kids? How do I add Grandma to the list?"
            a={
              <>
                Go to <Link href="/settings/pickup-people" className="underline" style={{ color: 'var(--brand-fg)' }}>Family → Authorized Pickup People</Link>.
                Pickup people are separate from emergency contacts. Add their name, phone,
                relationship, and (for multi-kid families) which students they&rsquo;re
                authorized to pick up.
              </>
            }
          />
          <FaqItem
            q="My child has an allergy / medical condition. Where do I record that?"
            a={
              <>
                It&rsquo;s captured on your school&rsquo;s health forms — open{' '}
                <Link href="/forms-v2" className="underline" style={{ color: 'var(--brand-fg)' }}>Forms</Link>{' '}
                and look for the health / medical form (for many families that&rsquo;s the
                Child Health Report or Emergency Contact form). Fill in allergies,
                medications, and provider details there. Your student&rsquo;s card on the{' '}
                <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Family</Link> page
                also shows what&rsquo;s on file.
              </>
            }
          />
          <FaqItem
            q="Why don't I see a form that another parent told me about?"
            a={
              <>
                Some forms only apply to certain children — for example, kindergarten-only
                forms, or a care agreement that only applies to toddlers and extended-care
                students. Your <Link href="/forms-v2" className="underline" style={{ color: 'var(--brand-fg)' }}>Forms</Link> list
                only shows the forms <span className="font-medium">your</span> child actually
                needs, so you won&rsquo;t see ones that don&rsquo;t apply. If you think a form
                is missing, contact the office.
              </>
            }
          />
          <FaqItem
            q="Can I download / print a form I submitted?"
            a={
              <>
                Open the <Link href="/forms-v2" className="underline" style={{ color: 'var(--brand-fg)' }}>Forms</Link> page,
                click into a completed form, and use the &ldquo;Print / Save as PDF&rdquo;
                button at the top. Your browser&rsquo;s print dialog has a &ldquo;Save as
                PDF&rdquo; option in the destination dropdown.
              </>
            }
          />
          <FaqItem
            q="How do I sign in? / I forgot my password."
            a={
              <>
                Go to the <a href="/login" className="underline" style={{ color: 'var(--brand-fg)' }}>sign-in page</a>{' '}
                and enter your email. The first time, you&rsquo;ll be asked to{' '}
                <span className="font-medium">create a password</span> — after that, you sign
                in with your email and that password. Forgot it? Email the school office
                {b.support_email ? <> at <a href={`mailto:${b.support_email}`} className="underline">{b.support_email}</a></> : null}
                {' '}and they&rsquo;ll reset it so you can set a new one.
              </>
            }
          />
          <FaqItem
            q="The school office can see what I submit, right? When?"
            a={
              <>
                Yes — as soon as you hit Submit. The school office gets an email
                notification on every form submission, and the form appears in their
                dashboard immediately. Edits you make to your family info (phone, address,
                emergency contacts) also flow through in real time.
              </>
            }
          />
          <FaqItem
            q="My co-parent and I are separated — can I keep my contact info private from them?"
            a={
              <>
                Yes. On the <Link href="/family" className="underline" style={{ color: 'var(--brand-fg)' }}>Family</Link> page,
                check the <span className="font-medium">&ldquo;Keep my contact info private from the other parent(s)&rdquo;</span>
                {' '}box on your own card. The school office always sees your full record;
                the other parent will only see your name and role.
              </>
            }
          />
          <FaqItem
            q="I don't see one of my kids listed — what now?"
            a={
              <>
                Email the office at{' '}
                {b.support_email ? (
                  <a href={`mailto:${b.support_email}`} className="underline">{b.support_email}</a>
                ) : (
                  'the school office'
                )}{' '}
                with your kid&rsquo;s full name and date of birth. They&rsquo;ll add the
                student to your family record and it will show up here.
              </>
            }
          />
        </div>
      </section>

      {/* Privacy + security note */}
      <section className="rounded-lg border border-gray-200 bg-gray-50/40 p-4">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-gray-500" />
          Privacy &amp; security
        </h2>
        <ul className="mt-2 space-y-1 text-[12px] text-gray-700 list-disc pl-5">
          <li>Your information is visible only to {b.display_name} staff and the parents on your family record.</li>
          <li>You sign in with your own email and a password you choose — keep it private to you.</li>
          <li>You&rsquo;re signed out automatically if you&rsquo;re inactive for a long stretch — sign back in any time.</li>
          <li>If you suspect someone got access they shouldn&rsquo;t have, email the office to reset your password.</li>
        </ul>
      </section>

      {/* Contact card */}
      <section className="rounded-lg border-2 p-5" style={{ borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <HelpCircle className="h-5 w-5" style={{ color: 'var(--brand-fg)' }} />
          Still stuck? Get in touch.
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          The fastest way to get help is to email or call the school office directly.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {b.support_email ? (
            <a
              href={`mailto:${b.support_email}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              style={{ color: 'var(--brand-fg)' }}
            >
              <Mail className="h-4 w-4" /> {b.support_email}
            </a>
          ) : null}
          {b.support_phone ? (
            <a
              href={`tel:${b.support_phone}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              style={{ color: 'var(--brand-fg)' }}
            >
              <Phone className="h-4 w-4" /> {b.support_phone}
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MapCard({ icon: Icon, title, description, href }: {
  icon: typeof Users;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--brand-soft)', color: 'var(--brand-fg)' }}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        <div className="mt-0.5 text-[12px] text-gray-600">{description}</div>
      </div>
    </Link>
  );
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-gray-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 hover:bg-gray-50 list-none flex items-center gap-2">
        <span className="text-gray-400 text-xs transition-transform" aria-hidden>▸</span>
        {q}
      </summary>
      <div className="border-t border-gray-100 px-4 py-3 text-sm text-gray-700 leading-relaxed">
        {a}
      </div>
    </details>
  );
}
