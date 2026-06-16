// Server action — logged-in parent adds another parent to their
// family record. The framing is family-record completeness, not
// invites: only first / last name are required. Email + portal access
// are optional.
//
// Storage model — Wooster (and most Montessori schools we've seen)
// stores parent 2 as CUSTOM FIELDS on the primary parent's GHL
// contact, not as a separate contact. We mirror that:
//
//   parent_2_first_name, parent_2_last_name, parent_2_cell_phone
//     → written to the inviter's GHL contact via custom-field PUT
//
//   parents table row
//     → inserted locally with ghl_contact_id = NULL (parent 2 doesn't
//       own a GHL contact; their identity lives on the primary's)
//
// If the inviter provides an email AND opts to send a sign-in link,
// we mint a 7-day magic-link token + send via Resend (GHL Conversations
// can't email a contact-less recipient).

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadGhlClient } from '@/lib/ghl/client';
import { updateContactCustomFields } from '@/lib/ghl/writes';
import { sendCoParentWelcomeEmail } from '@/lib/auth/co-parent-invite';

interface Result {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function addCoParentAction(formData: FormData): Promise<void> {
  const result = await inner(formData);
  const url = new URL('/family', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Saved.');
  else url.searchParams.set('err', result.error ?? 'Could not save.');
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
    const sendInvite = formData.get('send_invite') === '1';

    if (!firstName || !lastName) {
      return { ok: false, error: 'First and last name are required.' };
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'That email doesn\'t look quite right — double-check it or leave it blank.' };
    }

    // Soft dedupe: don't add the same name twice to a family. (Email
    // dedupe handled separately if an email was provided.)
    const { rows: nameDupes } = await query<{ id: string }>(
      `SELECT id FROM parents
        WHERE family_id = $1
          AND LOWER(first_name) = LOWER($2)
          AND LOWER(last_name) = LOWER($3)
          AND status = 'active'`,
      [session.family_id, firstName, lastName],
    );
    if (nameDupes.length > 0) {
      return {
        ok: false,
        error: `${firstName} ${lastName} is already on your family record. Refresh to see them.`,
      };
    }
    if (email) {
      const { rows: emailDupes } = await query<{ first_name: string }>(
        `SELECT first_name FROM parents
          WHERE family_id = $1 AND LOWER(email) = $2 AND status = 'active'`,
        [session.family_id, email],
      );
      if (emailDupes.length > 0) {
        return {
          ok: false,
          error: `A parent with that email is already on this family (${emailDupes[0].first_name}).`,
        };
      }
    }

    // Look up the inviter — for the welcome email + the GHL writeback target.
    const { rows: inviterRows } = await query<{
      first_name: string;
      ghl_contact_id: string | null;
    }>(
      `SELECT first_name, ghl_contact_id FROM parents WHERE id = $1`,
      [session.parent_id],
    );
    if (inviterRows.length === 0) return { ok: false, error: 'Inviter parent record missing.' };
    const inviter = inviterRows[0];

    // 1) Insert the local parents row first. ghl_contact_id = NULL —
    //    parent 2's identity lives in the primary's custom fields, not
    //    in their own contact.
    const { rows: insertRows } = await query<{ id: string }>(
      `INSERT INTO parents
         (family_id, school_id, ghl_contact_id, first_name, last_name,
          email, phone, role, is_primary, status)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, false, 'active')
       RETURNING id`,
      [
        session.family_id, session.school_id,
        firstName, lastName,
        email || null, phone || null, role,
      ],
    );
    const newParentId = insertRows[0].id;

    // 2) Mirror to the inviter's GHL contact as parent_2_* custom
    //    fields — best-effort. If GHL doesn't have these fields (other
    //    schools won't), the helper just skips them.
    let ghlWrote = 0;
    let ghlSkipped: string[] = [];
    if (inviter.ghl_contact_id) {
      try {
        const client = await loadGhlClient(session.school_id);
        const fields: Record<string, string> = {
          parent_2_first_name: firstName,
          parent_2_last_name: lastName,
        };
        if (phone) fields.parent_2_cell_phone = phone;
        const r = await updateContactCustomFields(client, inviter.ghl_contact_id, fields);
        ghlWrote = r.updated;
        ghlSkipped = r.skipped;
      } catch (err) {
        // Don't fail — the local row is in. School staff can reconcile
        // later if the GHL write fails.
        console.warn('[add-co-parent] GHL custom-field write failed:', err);
      }
    }

    // 3) Audit.
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
          new_parent_email: email || null,
          ghl_fields_written: ghlWrote,
          ghl_fields_skipped: ghlSkipped,
          sent_invite: sendInvite && !!email,
        }),
      ],
    );

    // 4) Welcome email — only if email AND opted-in. Best-effort.
    let emailSent = false;
    if (sendInvite && email) {
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
          invitingParentFirstName: inviter.first_name,
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

    const baseMsg = `${firstName} was added to your family record.`;
    let extra = '';
    if (emailSent) extra = ` We emailed them a sign-in link.`;
    else if (sendInvite && email) extra = ` (The welcome email didn't send — they can sign in later using their email.)`;
    return { ok: true, message: baseMsg + extra };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
