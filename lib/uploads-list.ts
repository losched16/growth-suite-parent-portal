// Read helper for the parent's family uploads. Pulls metadata only —
// the actual bytea contents are streamed via /api/uploads/[id].

import { query } from '@/lib/db';

export interface UploadRow {
  id: string;
  display_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  acknowledged_at: string | null;
  notes: string | null;
  student_id: string | null;
  student_name: string | null;
  form_id: string | null;
  form_name: string | null;
  uploaded_by_name: string | null;
  ghl_synced_at: string | null;
  ghl_sync_error: string | null;
}

// Documents the OFFICE shared with this family — student_documents rows
// (uploaded from the school dashboard) flagged visible_to_parent. Without
// this read, the dashboard's "show in parent portal" checkbox wrote a flag
// nothing on the parent side ever consumed.
export interface SchoolDocRow {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  student_name: string | null;
}

export async function loadSchoolDocumentsForFamily(familyId: string): Promise<SchoolDocRow[]> {
  const { rows } = await query<SchoolDocRow>(
    `SELECT
       d.id, d.title, d.category, d.description,
       d.file_name, d.mime_type, d.size_bytes,
       to_char(d.uploaded_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uploaded_at,
       NULLIF(CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name), '') AS student_name
     FROM student_documents d
     JOIN students s ON s.id = d.student_id
     WHERE s.family_id = $1
       AND d.visible_to_parent = true
     ORDER BY d.uploaded_at DESC`,
    [familyId],
  );
  return rows;
}

export async function loadFamilyUploads(familyId: string): Promise<UploadRow[]> {
  const { rows } = await query<UploadRow>(
    `SELECT
       u.id, u.display_name, u.original_filename, u.mime_type, u.size_bytes,
       u.uploaded_at, u.acknowledged_at, u.notes,
       u.student_id, (s.first_name || ' ' || s.last_name) AS student_name,
       u.form_id, sf.display_name AS form_name,
       (p.first_name || ' ' || p.last_name) AS uploaded_by_name,
       u.ghl_synced_at, u.ghl_sync_error
     FROM parent_uploads u
     LEFT JOIN students s ON s.id = u.student_id
     LEFT JOIN school_forms sf ON sf.id = u.form_id
     LEFT JOIN parents p ON p.id = u.parent_id
     WHERE u.family_id = $1
     ORDER BY u.uploaded_at DESC`,
    [familyId],
  );
  return rows;
}
