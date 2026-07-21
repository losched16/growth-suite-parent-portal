// Server action — handle a document upload from the parent portal.
// Validates: file present, mime/size, ownership of optional student/form
// FK references. Stores file as bytea in parent_uploads.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DISPLAY_NAME = 200;

// Mimetype allow-list. We're conservative for v1 — accept docs +
// images. No exec/script/zip in case a parent uploads something weird.
const ALLOWED_MIME_PREFIXES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

export async function uploadDocumentAction(formData: FormData): Promise<void> {
  const result = await uploadDocumentInner(formData);
  const url = new URL('/forms', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Uploaded.');
  else url.searchParams.set('err', result.error ?? 'Upload failed.');
  redirect(`${url.pathname}${url.search}`);
}

async function uploadDocumentInner(
  formData: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const session = await readSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'Please choose a file to upload.' };
    }
    if (file.size > MAX_BYTES) {
      return {
        ok: false,
        error: `File is too large (${formatBytes(file.size)}). Max is ${formatBytes(MAX_BYTES)}. Email the school for larger files.`,
      };
    }
    if (!ALLOWED_MIME_PREFIXES.some((p) => file.type === p)) {
      return {
        ok: false,
        error: `File type "${file.type || 'unknown'}" not allowed. Try PDF, image (JPG/PNG/HEIC), or Word/Excel doc.`,
      };
    }

    const displayName = String(formData.get('display_name') ?? '').trim().slice(0, MAX_DISPLAY_NAME)
      || file.name.slice(0, MAX_DISPLAY_NAME);
    const notes = String(formData.get('notes') ?? '').trim().slice(0, 1000) || null;

    // Optional: student_id, form_id — must belong to the parent's family
    const studentIdRaw = String(formData.get('student_id') ?? '').trim();
    let studentId: string | null = null;
    if (studentIdRaw) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM students WHERE id = $1 AND family_id = $2`,
        [studentIdRaw, session.family_id],
      );
      if (rows.length === 0) return { ok: false, error: 'Student not found in your family.' };
      studentId = rows[0].id;
    }

    const formIdRaw = String(formData.get('form_id') ?? '').trim();
    let formId: string | null = null;
    if (formIdRaw) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM school_forms WHERE id = $1 AND school_id = $2`,
        [formIdRaw, session.school_id],
      );
      if (rows.length === 0) return { ok: false, error: 'Form not found for your school.' };
      formId = rows[0].id;
    }

    const buf = Buffer.from(await file.arrayBuffer());

    const { rows: insRows } = await query<{ id: string }>(
      `INSERT INTO parent_uploads
         (school_id, family_id, parent_id, student_id, form_id,
          display_name, original_filename, mime_type, size_bytes, contents, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        session.school_id, session.family_id, session.parent_id,
        studentId, formId,
        displayName, file.name, file.type, buf.length, buf, notes,
      ],
    );

    // Audit
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'upload_document', $4::jsonb)`,
      [
        session.school_id, session.parent_id, session.family_id,
        JSON.stringify({
          upload_id: insRows[0].id,
          filename: file.name,
          size_bytes: buf.length,
          mime_type: file.type,
          student_id: studentId,
          form_id: formId,
        }),
      ],
    );

    // Push to GHL: upload to media library, then send a Conversations
    // message on the parent's contact so school staff sees it in the
    // contact's chat thread. Best-effort — local upload is still
    // "succeeded" even if the GHL push fails (operator can retry later).
    const uploadId = insRows[0].id;
    pushUploadToGhl(uploadId, {
      schoolId: session.school_id,
      familyId: session.family_id,
      parentId: session.parent_id,
      filename: file.name,
      mimeType: file.type,
      contents: buf,
      displayName,
      studentId,
      notes,
    }).catch((err) => {
      console.error('[upload-document] background GHL push crashed:', err);
    });

    revalidatePath('/forms');
    // Notify the office — parents upload immunization records, IEP/504
    // docs, custody papers etc. and the office had no signal beyond
    // checking the uploads screen. Best-effort; never blocks the upload.
    try {
      const { rows: br } = await query<{ email: string | null; fam: string | null }>(
        `SELECT COALESCE(NULLIF(btrim(b.admin_change_notification_email), ''), NULLIF(btrim(b.support_email), '')) AS email,
                f.display_name AS fam
           FROM school_branding b, families f
          WHERE b.school_id = $1 AND f.id = $2`,
        [session.school_id, session.family_id],
      );
      const officeEmail = br[0]?.email;
      if (officeEmail) {
        const { sendBrandedEmail } = await import('@/lib/email');
        await sendBrandedEmail({
          to: officeEmail,
          schoolId: session.school_id,
          subject: `New document uploaded — ${br[0]?.fam ?? 'a family'}`,
          text: `${br[0]?.fam ?? 'A family'} uploaded "${displayName}" (${formatBytes(buf.length)}, ${file.type}) in the parent portal.

Review it on the family's page or the uploads screen.`,
          html: `<p><strong>${br[0]?.fam ?? 'A family'}</strong> uploaded &ldquo;${displayName}&rdquo; (${formatBytes(buf.length)}, ${file.type}) in the parent portal.</p><p>Review it on the family&rsquo;s page or the uploads screen.</p>`,
        });
      }
    } catch (e) {
      console.warn('[upload-document] office notification failed:', e instanceof Error ? e.message : String(e));
    }

    return { ok: true, message: `Uploaded "${displayName}" (${formatBytes(buf.length)}).` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Best-effort: push to GHL media library + send a notification message
// on the parent's contact. Updates parent_uploads with the resulting IDs
// (or the error message if something fails). Re-runnable via the
// operator "Retry GHL push" button.
async function pushUploadToGhl(uploadId: string, opts: {
  schoolId: string;
  familyId: string;
  parentId: string;
  filename: string;
  mimeType: string;
  contents: Buffer;
  displayName: string;
  studentId: string | null;
  notes: string | null;
}): Promise<void> {
  try {
    const { loadGhlClient } = await import('@/lib/ghl/client');
    const { uploadMediaToGhl } = await import('@/lib/ghl/media');
    const { sendMessage } = await import('@/lib/ghl/conversations');

    const client = await loadGhlClient(opts.schoolId);

    // 1. Upload to GHL media library
    const media = await uploadMediaToGhl(client, {
      filename: opts.filename,
      mimeType: opts.mimeType,
      contents: opts.contents,
    });

    // 2. Find the parent's contactId. If parent has none (parent 2),
    // fall back to the family's primary parent contact so the upload
    // still shows up on the family record.
    const { rows: pRows } = await query<{ ghl_contact_id: string | null }>(
      `SELECT ghl_contact_id FROM parents WHERE id = $1`,
      [opts.parentId],
    );
    let contactId = pRows[0]?.ghl_contact_id ?? null;
    if (!contactId) {
      const { rows: priRows } = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents
         WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL
         LIMIT 1`,
        [opts.familyId],
      );
      contactId = priRows[0]?.ghl_contact_id ?? null;
    }
    if (!contactId) {
      throw new Error('Family has no GHL contact id — cannot attach upload to a conversation');
    }

    // 3. Optional student name for the message
    let studentName = '';
    if (opts.studentId) {
      const { rows: sRows } = await query<{ first_name: string; last_name: string; preferred_name: string | null }>(
        `SELECT first_name, last_name, preferred_name FROM students WHERE id = $1`,
        [opts.studentId],
      );
      if (sRows[0]) studentName = ` for ${sRows[0].preferred_name || sRows[0].first_name} ${sRows[0].last_name}`;
    }

    const messageBody = `📎 Parent uploaded document: ${opts.displayName}${studentName}.${opts.notes ? `\n\nNotes: ${opts.notes}` : ''}`;

    const msg = await sendMessage(client, {
      contactId,
      body: messageBody,
      type: 'Live_Chat',
      attachments: [media.url],
    });

    await query(
      `UPDATE parent_uploads
       SET ghl_media_id = $1,
           ghl_media_url = $2,
           ghl_conversation_id = $3,
           ghl_message_id = $4,
           ghl_synced_at = now(),
           ghl_sync_error = NULL
       WHERE id = $5`,
      [media.fileId, media.url, msg.conversationId, msg.messageId, uploadId],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upload-document] GHL push failed for', uploadId, ':', msg);
    await query(
      `UPDATE parent_uploads SET ghl_sync_error = $1 WHERE id = $2`,
      [msg.slice(0, 500), uploadId],
    ).catch(() => undefined);
  }
}

export async function deleteUploadAction(formData: FormData): Promise<void> {
  const result = await deleteUploadInner(formData);
  const url = new URL('/forms', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Removed.');
  else url.searchParams.set('err', result.error ?? 'Delete failed.');
  redirect(`${url.pathname}${url.search}`);
}

async function deleteUploadInner(
  formData: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const session = await readSession();
  if (!session) return { ok: false, error: 'Not signed in.' };
  const uploadId = String(formData.get('upload_id') ?? '');
  if (!uploadId) return { ok: false, error: 'Missing upload id.' };

  // Only allow deleting uploads from the parent's own family
  const { rowCount } = await query(
    `DELETE FROM parent_uploads WHERE id = $1 AND family_id = $2`,
    [uploadId, session.family_id],
  );
  if (!rowCount) return { ok: false, error: 'Upload not found.' };

  revalidatePath('/forms');
  return { ok: true, message: 'Document removed.' };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
