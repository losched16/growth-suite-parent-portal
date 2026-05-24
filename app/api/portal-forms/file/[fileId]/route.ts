// GET /api/portal-forms/file/{id} — download a file attached to a
// portal-form submission.
//
// Authorization: must be a parent in the same family as the submission.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ fileId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { fileId } = await params;

  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    family_id: string;
    school_id: string;
    original_filename: string;
    display_name: string;
    mime_type: string;
    contents: Buffer;
  }>(
    `SELECT s.family_id, f.school_id, f.original_filename, f.display_name,
            f.mime_type, f.contents
     FROM portal_form_submission_files f
     JOIN portal_form_submissions s ON s.id = f.submission_id
     WHERE f.id = $1`,
    [fileId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const row = rows[0];

  if (row.family_id !== session.family_id || row.school_id !== session.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const inline = url.searchParams.get('inline') === '1';
  const filename = row.original_filename.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
