// GET /api/school-documents/{id} — download a document the SCHOOL shared
// with this family (student_documents, uploaded from the dashboard with
// "show in parent portal" checked).
//
// Authorization: the document's student must belong to the session's
// family AND the row must be flagged visible_to_parent. Same streaming
// pattern as /api/uploads/[uploadId].

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

type Params = Promise<{ docId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { docId } = await params;

  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    family_id: string;
    visible_to_parent: boolean;
    file_name: string;
    mime_type: string;
    file_bytes: Buffer | null;
  }>(
    `SELECT s.family_id, d.visible_to_parent, d.file_name, d.mime_type, d.file_bytes
       FROM student_documents d
       JOIN students s ON s.id = d.student_id
      WHERE d.id = $1`,
    [docId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const row = rows[0];

  if (row.family_id !== session.family_id || !row.visible_to_parent) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!row.file_bytes) {
    return NextResponse.json({ error: 'file contents unavailable' }, { status: 410 });
  }

  const inline = request.nextUrl.searchParams.get('inline') === '1';
  const filename = row.file_name.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(row.file_bytes), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
