// GET /api/shared-documents/{id} — download an office-shared "important
// document". Authorized when the session family matches the document's
// audience (include minus exclude) and the document is active.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { familyCanSeeDoc } from '@/lib/school-shared-docs';

type Params = Promise<{ docId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { docId } = await params;
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const res = await familyCanSeeDoc(session.school_id, session.family_id, docId);
  if (!res.ok) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const inline = request.nextUrl.searchParams.get('inline') === '1';
  const filename = res.file_name.replace(/[^\w. -]/g, '_');
  return new NextResponse(new Uint8Array(res.file_bytes), {
    status: 200,
    headers: {
      'Content-Type': res.mime_type || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
