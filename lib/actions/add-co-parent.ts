// Server action — logged-in parent adds a co-parent to their family.
// The inviter must own the family_id in their session — there's no
// path to add a parent to someone else's family.
//
// Order of writes:
//   1. Create GHL contact (source of truth — anything we'd put in our
//      DB without a GHL contact would get clobbered by the next sync).
//   2. Insert local parents row with the returned ghl_contact_id.
//   3. Send the new parent a welcome email with a 7-day sign-in link.
//   4. Audit log.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadGhlClient } from '@/lib/ghl/client';
import { createContact } from '@/lib/ghl/contacts';
import { sendCoParentWelcomeEmail } from '@/lib/auth/co-parent-invite';

interface Result {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function addCoParentAction(formData: FormData): Promise<void> {
  const result = await inner(formData);
  const url = new URL('/family', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Co-parent added.');
  else url.searchParams.set('err', result.error ?? 'Could not add co-parent.');
  redirect(`${url.pathname}${url.search}`);
}

async function inner(formData: FormData): Promise<Result> {
  try {
    const session = await readSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    const firstName = String(formData.get('first_name') ?? '').trim();
    const lastName = String(formData.get('last_name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const phone = String(formData.get('phone') ?? '').trim();
    const rawRole = String(formData.get('role') ?? 'parent').trim();
    const role = (['parent', 'guardian', 'other'].includes(rawRole) ? rawRole : 'parent') as
      'parent' | 'guardian' | 'other';
    const sendInvite = formData.get('send_invite') !== '0';

    if (!firstName || !lastName) {
      return { ok: false, error: 'First and last name are required.' };
    }
    if (!email) {
      return { ok: false, error: 'Email is required so the school (and your co-parent) can sign in.' };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'That email doesn\'t look quite right — double-check the spelling.' };
    }

    // Don't allow duplicates on the same family.
    const { rows: dupes } = await query<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM parents
        WHERE family_id = $1
          AND LOWER(email) = $2
          AND status = 'active'`,
      [session.family_id, email],
    );
    if (dupes.length > 0) {
      return {
        ok: false,
        error: `A parent with that email is already on this family (${dupes[0].first_name}).`,
      };
    }

    // Look up inviter — used for the welcome email signature.
    const { rows: inviterRows } = await query<{ first_name: string }>(
      `SELECT first_name FROM parents WHERE id = $1`,
      [session.parent_id],
    );
    if (inviterRows.length === 0) return { ok: false, error: 'Inviter parent record missing.' };
    const inviterFirstName = inviterRows[0].first_name;

    // 1) GHL contact create.
    const client = await loadGhlClient(session.school_id);
    let ghlContactId: string;
    try {
      ghlContactId = await createContact(client, {
        firstName, lastName, email,
        phone: phone || undefined,
        source: 'Parent Portal — added co-parent',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // GHL returns 4xx on duplicate email — surface that clearly.
      const friendly = /duplicate|already exists|exists/i.test(msg)
        ? `That email is already a contact at the school. Ask the office to link it to your family.`
        : `Could not create the contact in the school's CRM: ${msg}`;
      return { ok: false, error: friendly };
    }

    // 2) Insert parent row. is_primary stays false — the inviter keeps
    //    primary status (and the partial unique index would block a
    //    second primary anyway).
    const { rows: insertRows } = await query<{ id: string }>(
      `INSERT INTO parents
         (family_id, school_id, ghl_contact_id, first_name, last_name,
          email, phone, role, is_primary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 'active')
       RETURNING id`,
      [
        session.family_id, session.school_id, ghlContactId,
        firstName, lastName, email, phone || null, role,
      ],
    );
    const newParentId = insertRows[0].id;

    // 3) Audit log.
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'add_co_parent', $4::jsonb)`,
      [
        session.school_id,
        session.parent_id,
        session.family_id,
        JSON.stringify({
          new_parent_id: newParentId,
          new_parent_email: email,
          ghl_contact_id: ghlContactId,
          sent_invite: sendInvite,
        }),
      ],
    );

    // 4) Welcome email — best-effort. If it fails, the parent row is
    //    already there; the inviter can resend later via the standard
    //    login flow.
    let emailSent = false;
    if (sendInvite) {
      try {
        const { rows: schoolRows } = await query<{
          name: string;
          support_email: string | null;
        }>(
          `SELECT s.name, b.support_email
             FROM schools s
             LEFT JOIN school_branding b ON b.school_id = s.id
            WHERE s.id = $1`,
          [session.school_id],
        );
        const schoolName = schoolRows[0]?.name ?? 'Family Portal';
        const supportEmail = schoolRows[0]?.support_email ?? null;

        const hdr = await headers();
        const proto = hdr.get('x-forwarded-proto') ?? 'https';
        const host = hdr.get('x-forwarded-host') ?? hdr.get('host') ?? '';
        const origin = host ? `${proto}://${host}` : '';

        await sendCoParentWelcomeEmail({
          newParentId,
          newParentEmail: email,
          newParentFirstName: firstName,
          invitingParentFirstName: inviterFirstName,
          schoolId: session.school_id,
          schoolName,
          supportEmail,
          origin,
        });
        emailSent = true;
      } catch (err) {
        console.warn('[add-co-parent] welcome email failed:', err);
      }
    }

    revalidatePath('/family');
    revalidatePath('/home');
    return {
      ok: true,
      message: emailSent
        ? `${firstName} was added and emailed a sign-in link.`
        : sendInvite
          ? `${firstName} was added. The welcome email didn't send — they can sign in at the portal's login page using their email.`
          : `${firstName} was added.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
