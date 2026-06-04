// POST   /api/financial-aid/upload-doc    — upload ONE file for an
//   application's document_type slot.
// DELETE /api/financial-aid/upload-doc?file_id=<uuid> — remove a file.
// GET    /api/financial-aid/upload-doc?application_id=<uuid> — list
//   all files attached, grouped by document_type.
//
// Auth: parent session, scoped to applications owned by their family.
// File is stored as bytea in fa_application_files (same table the
// existing flat-submit endpoint uses). The wizard's step-7 checklist
// calls this directly so the parent never has to leave the wizard.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;

// Guard: confirm the application belongs to the session's family.
async function ownsApplication(applicationId: string, familyId: string): Promise<{ school_id: string } | null> {
  const { rows } = await query<{ school_id: string }>(
    `SELECT school_id FROM fa_applications WHERE id = $1 AND family_id = $2`,
    [applicationId, familyId],
  );
  return rows[0] ?? null;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'multipart_required' }, { status: 400 });
  }

  const applicationId = String(fd.get('application_id') ?? '').trim();
  const documentType = String(fd.get('document_type') ?? '').trim().toLowerCase();
  const file = fd.get('file');

  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
    return NextResponse.json({ error: 'bad_application_id' }, { status: 400 });
  }
  if (!/^[a-z_]+$/.test(documentType) || documentType.length > 60) {
    return NextResponse.json({ error: 'bad_document_type' }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({
      error: 'file_too_large',
      detail: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is 10MB.`,
    }, { status: 413 });
  }
  if (!ALLOWED_MIME.test(file.type)) {
    return NextResponse.json({
      error: 'unsupported_type',
      detail: 'Please upload a PDF or an image (JPG, PNG, HEIC).',
    }, { status: 415 });
  }

  const owner = await ownsApplication(applicationId, session.family_id);
  if (!owner) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const buf = Buffer.from(await file.arrayBuffer());
  const { rows: ins } = await query<{ id: string }>(
    `INSERT INTO fa_application_files
       (application_id, school_id, document_type, display_name, original_filename,
        mime_type, size_bytes, contents, uploaded_by_parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      applicationId, owner.school_id, documentType,
      file.name, file.name, file.type, file.size, buf, session.parent_id,
    ],
  );

  return NextResponse.json({
    ok: true,
    file: {
      id: ins[0].id,
      document_type: documentType,
      filename: file.name,
      size_bytes: file.size,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const fileId = new URL(request.url).searchParams.get('file_id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
    return NextResponse.json({ error: 'bad_file_id' }, { status: 400 });
  }

  // Validate ownership via the file → application → family chain.
  const { rows } = await query<{ application_id: string; family_id: string }>(
    `SELECT f.application_id, a.family_id
       FROM fa_application_files f
       JOIN fa_applications a ON a.id = f.application_id
      WHERE f.id = $1`,
    [fileId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (rows[0].family_id !== session.family_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  await query(`DELETE FROM fa_application_files WHERE id = $1`, [fileId]);
  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const applicationId = new URL(request.url).searchParams.get('application_id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
    return NextResponse.json({ error: 'bad_application_id' }, { status: 400 });
  }
  const owner = await ownsApplication(applicationId, session.family_id);
  if (!owner) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { rows } = await query<{
    id: string; document_type: string; original_filename: string; size_bytes: number; uploaded_at: Date;
  }>(
    `SELECT id, document_type, original_filename, size_bytes, uploaded_at
       FROM fa_application_files WHERE application_id = $1
       ORDER BY document_type, uploaded_at`,
    [applicationId],
  );
  return NextResponse.json({ files: rows });
}
