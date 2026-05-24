// GET /api/uploads/{id} — download a previously-uploaded document.
// Authorization: only parents in the same family as the upload can download.
//
// Streams the bytea contents back with the original mime type +
// Content-Disposition: attachment so browsers prompt to save.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

type Params = Promise<{ uploadId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;

  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    family_id: string;
    school_id: string;
    original_filename: string;
    mime_type: string;
    contents: Buffer;
  }>(
    `SELECT family_id, school_id, original_filename, mime_type, contents
     FROM parent_uploads WHERE id = $1`,
    [uploadId],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const row = rows[0];

  if (row.family_id !== session.family_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const filename = row.original_filename.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
