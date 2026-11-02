// "How it works" card for admissions schools: 1) application, 2) upload documents.

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import type { ApplicantStepsState } from '@/lib/forms/applicant-next-steps';

export function ApplicantSteps({ state, showLinks = true }: { state: ApplicantStepsState; showLinks?: boolean }) {
  const { step1Done, formSlug, docNames, supportEmail, contactName } = state;
  const circle = (n: number, active: boolean) => (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${active ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-500'}`}>{n}</span>
  );
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">How applying works</h2>
      <ol className="mt-3 space-y-4">
        <li className="flex gap-3">
          {step1Done ? <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" /> : circle(1, true)}
          <div className="text-sm">
            <div className="font-medium text-gray-900">
              Fill out the application{step1Done ? ' — submitted' : ''}
            </div>
            <p className="mt-0.5 text-gray-600">
              {step1Done
                ? 'Thank you. To apply for another child, submit the application again.'
                : 'Complete the application for your child. Your progress is saved as you go.'}
            </p>
            {!step1Done && showLinks ? (
              <Link href={`/forms-v2/${formSlug}`} className="mt-1 inline-block text-sm font-medium underline">Start the application</Link>
            ) : null}
          </div>
        </li>
        <li className={`flex gap-3 ${step1Done ? '' : 'opacity-70'}`}>
          {circle(2, step1Done)}
          <div className="text-sm">
            <div className="font-medium text-gray-900">Submit your required forms</div>
            <p className="mt-0.5 text-gray-600">
              {step1Done
                ? 'The document forms are now open. Open each one and upload your files:'
                : 'Family documents can be uploaded now; the documents for your child open as soon as your application is submitted:'}
            </p>
            {docNames.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-gray-700">
                {docNames.map((n) => <li key={n}>{n}</li>)}
              </ul>
            ) : null}
            {step1Done && showLinks ? (
              <Link href="/forms-v2" className="mt-1 inline-block text-sm font-medium underline">Go to Forms</Link>
            ) : null}
          </div>
        </li>
      </ol>
      {supportEmail ? (
        <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
          Questions? Contact {contactName ? <>{contactName} at </> : null}
          <a href={`mailto:${supportEmail}`} className="underline">{supportEmail}</a>
        </p>
      ) : null}
    </section>
  );
}
