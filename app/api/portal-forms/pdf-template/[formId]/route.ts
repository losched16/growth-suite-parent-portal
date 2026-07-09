// GET /api/portal-forms/pdf-template/{formId} — the official PDF template
// plus the geometry of its fillable fields, for the "paper mode" renderer
// (parents fill the actual document in the browser). Parent-session
// authed; the form must belong to the parent's school and be active.

import { NextResponse } from 'next/server';
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFSignature } from 'pdf-lib';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ formId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { formId } = await params;
  const claims = await readSession();
  if (!claims) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<{ file_bytes: Buffer }>(
    `SELECT t.file_bytes
       FROM portal_form_pdf_templates t
       JOIN portal_form_definitions d ON d.id = t.form_definition_id
      WHERE t.form_definition_id = $1 AND d.school_id = $2 AND d.is_active = true`,
    [formId, claims.school_id],
  );
  if (!rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const bytes = rows[0].file_bytes;
  const doc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const pages = doc.getPages().map((p, i) => ({ index: i, width: p.getWidth(), height: p.getHeight() }));
  const pageRefByIndex = doc.getPages().map((p) => p.ref);

  const fields: Array<{
    name: string; type: string; page: number;
    rect: { x: number; y: number; w: number; h: number };
    options?: string[];
  }> = [];
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    let type = 'text';
    let options: string[] | undefined;
    if (f instanceof PDFTextField) type = 'text';
    else if (f instanceof PDFCheckBox) type = 'checkbox';
    else if (f instanceof PDFRadioGroup) { type = 'radio'; options = f.getOptions(); }
    else if (f instanceof PDFDropdown) { type = 'dropdown'; options = f.getOptions(); }
    else if (f instanceof PDFSignature) type = 'signature';
    else continue;
    // One entry per widget (radio groups have one widget per option).
    const widgets = f.acroField.getWidgets();
    widgets.forEach((w, wi) => {
      const rect = w.getRectangle();
      const ref = w.P();
      let page = pageRefByIndex.findIndex((r) => r === ref);
      if (page < 0) page = 0;
      fields.push({
        name, type, page,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        ...(options ? { options } : {}),
        ...(type === 'radio' && options ? { options: [options[wi] ?? options[0]] } : {}),
      });
    });
  }

  return NextResponse.json(
    { pdf: Buffer.from(bytes).toString('base64'), pages, fields },
    { headers: { 'Cache-Control': 'private, max-age=300' } },
  );
}
