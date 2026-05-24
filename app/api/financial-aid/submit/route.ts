// POST /api/financial-aid/submit — one application per family per year.
// The form contains household-level fields PLUS one set of inputs per
// active student (include_<id>, tuition_<id>, requested_<id>). We
// upsert the application and replace the child rows for the students
// the parent checked, totaling requested_aid + current_tuition_owed
// at the application level for convenience in admin queries.
//
// Auth: parent session. Application is force-scoped to the parent's
// own family + school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(application\/pdf|image\/(jpeg|png|webp))$/i;

interface StudentInput {
  student_id: string;
  current_tuition: number | null;
  requested_aid: number | null;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return new NextResponse('multipart body required', { status: 400 });
  }

  const year = String(fd.get('academic_year') ?? '').trim() || '2025-26';

  // Load this family's active students so we can validate the `include_<id>`
  // checkboxes against ones that actually belong to the family.
  const { rows: students } = await query<{ id: string }>(
    `SELECT id FROM students WHERE family_id = $1 AND status = 'active'`,
    [session.family_id],
  );
  const validIds = new Set(students.map((s) => s.id));

  // Parse per-student inputs
  const studentInputs: StudentInput[] = [];
  for (const id of validIds) {
    if (fd.get(`include_${id}`) !== '1') continue;
    studentInputs.push({
      student_id: id,
      current_tuition: numOrNull(fd.get(`tuition_${id}`)),
      requested_aid: numOrNull(fd.get(`requested_${id}`)),
    });
  }
  if (studentInputs.length === 0) {
    const back = new URL('/financial-aid/apply', request.url);
    back.searchParams.set('year', year);
    back.searchParams.set('err', 'Please check at least one student attending the school.');
    return NextResponse.redirect(back, 303);
  }

  const householdSize = numOrNull(fd.get('household_size'));
  const totalAnnualIncome = numOrNull(fd.get('total_annual_income'));
  const assets = numOrNull(fd.get('assets_value'));
  const special = strOrNull(fd.get('special_circumstances'));
  const notes = strOrNull(fd.get('parent_notes'));

  // Family totals computed from per-student inputs
  const totalTuition = studentInputs.reduce((s, x) => s + (x.current_tuition ?? 0), 0);
  const totalRequested = studentInputs.reduce((s, x) => s + (x.requested_aid ?? 0), 0);

  // Upsert in one transaction
  const applicationId = await withTransaction(async (q) => {
    const { rows: app } = await q<{ id: string }>(
      `INSERT INTO fa_applications (
         school_id, family_id, academic_year,
         household_size, total_annual_income, assets_value,
         current_tuition_owed, requested_aid,
         special_circumstances, parent_notes,
         status, submitted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', now())
       ON CONFLICT (school_id, family_id, academic_year) DO UPDATE
         SET household_size = EXCLUDED.household_size,
             total_annual_income = EXCLUDED.total_annual_income,
             assets_value = EXCLUDED.assets_value,
             current_tuition_owed = EXCLUDED.current_tuition_owed,
             requested_aid = EXCLUDED.requested_aid,
             special_circumstances = EXCLUDED.special_circumstances,
             parent_notes = EXCLUDED.parent_notes,
             status = CASE
               WHEN fa_applications.status IN ('decided','withdrawn') THEN fa_applications.status
               ELSE 'submitted'
             END,
             submitted_at = COALESCE(fa_applications.submitted_at, now())
       RETURNING id`,
      [
        session.school_id, session.family_id, year,
        householdSize, totalAnnualIncome, assets,
        totalTuition, totalRequested,
        special, notes,
      ],
    );
    const id = app[0].id;

    // Replace the student rows. We do delete+insert because parents might
    // un-check a student on re-submit and we need to drop them. Existing
    // recommended_award values on children are preserved by re-fetching
    // them first and merging back in — admin work shouldn't be wiped by
    // a parent edit.
    const { rows: existingAwards } = await q<{ student_id: string; recommended_award: string | null; award_note: string | null }>(
      `SELECT student_id, recommended_award, award_note
       FROM fa_application_students WHERE application_id = $1`,
      [id],
    );
    const awardMap = new Map<string, { rec: number | null; note: string | null }>();
    for (const r of existingAwards) {
      awardMap.set(r.student_id, { rec: r.recommended_award === null ? null : Number(r.recommended_award), note: r.award_note });
    }
    await q(`DELETE FROM fa_application_students WHERE application_id = $1`, [id]);
    for (const s of studentInputs) {
      const prior = awardMap.get(s.student_id);
      await q(
        `INSERT INTO fa_application_students
           (application_id, student_id, current_tuition, requested_aid, recommended_award, award_note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, s.student_id, s.current_tuition, s.requested_aid, prior?.rec ?? null, prior?.note ?? null],
      );
    }

    return id;
  });

  // Files (optional)
  const files = fd.getAll('files');
  for (const f of files) {
    if (!(f instanceof File)) continue;
    if (!f.name || f.size === 0) continue;
    if (f.size > MAX_FILE_BYTES) continue;
    if (!ALLOWED_MIME.test(f.type)) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    const inferredType = inferDocumentType(f.name);
    await query(
      `INSERT INTO fa_application_files
         (application_id, school_id, document_type, display_name, original_filename,
          mime_type, size_bytes, contents, uploaded_by_parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        applicationId, session.school_id, inferredType, f.name, f.name,
        f.type, f.size, buf, session.parent_id,
      ],
    );
  }

  return NextResponse.redirect(new URL('/financial-aid', request.url), 303);
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function inferDocumentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (/1040|tax.return/.test(lower)) return '1040';
  if (/w-?2/.test(lower)) return 'w2';
  if (/sched.*c|self.?employed/.test(lower)) return 'schedule_c';
  if (/bank|statement/.test(lower)) return 'bank_statement';
  if (/pay.?stub/.test(lower)) return 'pay_stub';
  return 'other';
}
