// GET /api/school-resources/{id} — download a school-uploaded
// resource (supply list, calendar, parent handbook, etc.).
//
// Authorization: any authenticated parent in the same school. Inactive
// rows return 404 so deleted docs stop resolving even if a parent
// bookmarked the URL.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;

  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{
    school_id: string;
    original_filename: string;
    mime_type: string;
    contents: Buffer;
    is_active: boolean;
  }>(
    `SELECT school_id, original_filename, mime_type, contents, is_active
       FROM school_documents
      WHERE id = $1`,
    [id],
  );
  if (rows.length === 0 || !rows[0].is_active) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const row = rows[0];
  if (row.school_id !== session.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Default to inline display so PDFs / images open in a new tab; the
  // ?download=1 query param flips to attachment for explicit save.
  const url = new URL(request.url);
  const forceDownload = url.searchParams.get('download') === '1';
  const safeName = row.original_filename.replace(/[^\w. -]/g, '_');

  return new NextResponse(new Uint8Array(row.contents), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
}
