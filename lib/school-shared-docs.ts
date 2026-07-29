// School-wide "important documents" (school_shared_documents) — office
// uploads targeted with the notifications-style audience rules plus an
// exclude audience. This module decides, PER FAMILY at view time,
// which documents they can see. Mirrors the dashboards-side Audience
// shape ({ match: 'all'|'any', conditions: [{field, values}] }).
//
// A family matches a condition when:
//   all         → always
//   program / homeroom / grade_level
//               → any ACTIVE student in the family has that metadata value
//   tag         → the PRIMARY parent's contact carries the tag
//   family      → this family's id is listed
//   parent      → any of the family's parent ids is listed
// Include empty/null → everyone. Exclude match always wins.

import { query } from '@/lib/db';

interface AudienceCondition { field?: string; values?: string[] }
interface Audience { match?: 'all' | 'any'; conditions?: AudienceCondition[] }

export interface SharedDocRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  include_audience: Audience | null;
  exclude_audience: Audience | null;
}

interface FamilyFacts {
  familyId: string;
  parentIds: Set<string>;
  tags: Set<string>;       // primary parent's contact tags, lowercased
  programs: Set<string>;
  homerooms: Set<string>;
  grades: Set<string>;
}

async function loadFamilyFacts(schoolId: string, familyId: string): Promise<FamilyFacts> {
  const [parents, tags, students] = await Promise.all([
    query<{ id: string }>(
      `SELECT id FROM parents WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
      [familyId, schoolId],
    ),
    query<{ tag: string }>(
      `SELECT DISTINCT lower(t.tag) AS tag FROM ghl_contact_tags t
         JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
        WHERE t.school_id = $1 AND p.family_id = $2 AND p.is_primary = true`,
      [schoolId, familyId],
    ),
    query<{ program: string | null; homeroom: string | null; grade: string | null }>(
      `SELECT metadata->>'program' AS program, metadata->>'homeroom' AS homeroom,
              metadata->>'grade_level' AS grade
         FROM students WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
      [familyId, schoolId],
    ),
  ]);
  const facts: FamilyFacts = {
    familyId,
    parentIds: new Set(parents.rows.map((r) => r.id)),
    tags: new Set(tags.rows.map((r) => r.tag)),
    programs: new Set(), homerooms: new Set(), grades: new Set(),
  };
  for (const s of students.rows) {
    if (s.program) facts.programs.add(s.program);
    if (s.homeroom) facts.homerooms.add(s.homeroom);
    if (s.grade) facts.grades.add(s.grade);
  }
  return facts;
}

function conditionMatches(c: AudienceCondition, f: FamilyFacts): boolean {
  const field = String(c?.field ?? '');
  if (field === 'all') return true;
  const values = Array.isArray(c?.values) ? c.values.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  if (values.length === 0) return false;  // incomplete condition never matches
  switch (field) {
    case 'program': return values.some((v) => f.programs.has(v));
    case 'homeroom': return values.some((v) => f.homerooms.has(v));
    case 'grade_level': return values.some((v) => f.grades.has(v));
    case 'tag': return values.some((v) => f.tags.has(v.toLowerCase()));
    case 'family': return values.includes(f.familyId);
    case 'parent': return values.some((v) => f.parentIds.has(v));
    default: return false;
  }
}

function audienceMatches(a: Audience | null | undefined, f: FamilyFacts): boolean {
  const conditions = Array.isArray(a?.conditions) ? a!.conditions! : [];
  if (conditions.length === 0) return false;
  return a?.match === 'any'
    ? conditions.some((c) => conditionMatches(c, f))
    : conditions.every((c) => conditionMatches(c, f));
}

export function familyCanSee(doc: Pick<SharedDocRow, 'include_audience' | 'exclude_audience'>, facts: FamilyFacts): boolean {
  const inc = doc.include_audience;
  const included = !inc || !Array.isArray(inc.conditions) || inc.conditions.length === 0
    ? true
    : audienceMatches(inc, facts);
  if (!included) return false;
  return !audienceMatches(doc.exclude_audience, facts);
}

// The documents this family sees, newest first.
export async function loadSharedDocsForFamily(schoolId: string, familyId: string): Promise<SharedDocRow[]> {
  const { rows } = await query<SharedDocRow>(
    `SELECT id, title, description, category, file_name, mime_type, size_bytes,
            to_char(uploaded_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at,
            include_audience, exclude_audience
       FROM school_shared_documents
      WHERE school_id = $1 AND is_active = true
      ORDER BY uploaded_at DESC`,
    [schoolId],
  );
  if (rows.length === 0) return [];
  const facts = await loadFamilyFacts(schoolId, familyId);
  return rows.filter((d) => familyCanSee(d, facts));
}

// Authorization for the download route: same rule, single document.
export async function familyCanSeeDoc(schoolId: string, familyId: string, docId: string): Promise<
  { ok: true; file_name: string; mime_type: string; file_bytes: Buffer } | { ok: false }
> {
  const { rows } = await query<{
    include_audience: Audience | null; exclude_audience: Audience | null;
    is_active: boolean; file_name: string; mime_type: string; file_bytes: Buffer;
  }>(
    `SELECT include_audience, exclude_audience, is_active, file_name, mime_type, file_bytes
       FROM school_shared_documents WHERE id = $1 AND school_id = $2`,
    [docId, schoolId],
  );
  const d = rows[0];
  if (!d || !d.is_active) return { ok: false };
  const facts = await loadFamilyFacts(schoolId, familyId);
  if (!familyCanSee(d, facts)) return { ok: false };
  return { ok: true, file_name: d.file_name, mime_type: d.mime_type, file_bytes: d.file_bytes };
}
