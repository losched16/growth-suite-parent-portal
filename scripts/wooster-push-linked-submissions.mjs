// Push the answers of newly linked Wooster portal submissions (see
// wooster-link-unlinked-submissions.mjs) to the GHL contact, using each
// form's ghl_writeback config — only when the submission is now the
// child's LATEST for that form. Earlier-form imports are skipped: their
// answers came from GHL in the first place. --apply writes.
import pg from 'pg';
const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const APPLY = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(
  `SELECT s.id, s.responses, d.slug, d.field_schema, d.ghl_writeback, st.first_name || ' ' || st.last_name AS kid,
          COALESCE(st.metadata->>'slot', st.metadata->>'ghl_slot')::int AS slot,
          (SELECT p.ghl_contact_id FROM parents p WHERE p.family_id = st.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL LIMIT 1) AS contact
     FROM _bak_wooster_linked_subs_20261016 b
     JOIN portal_form_submissions s ON s.id = b.submission_id
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     JOIN students st ON st.id = s.student_id
    WHERE s.status = 'submitted'
      AND NOT EXISTS (SELECT 1 FROM portal_form_submissions n
                       WHERE n.form_definition_id = s.form_definition_id AND n.student_id = s.student_id
                         AND n.voided_at IS NULL AND COALESCE(n.is_test,false) = false AND COALESCE(n.is_addendum,false) = false
                         AND n.status IN ('submitted','paid','pending_payment','legacy_imported')
                         AND COALESCE(n.submitted_at, n.created_at) > COALESCE(s.submitted_at, s.created_at))`);
const perContact = new Map(); let values = 0; const skipped = [];
for (const r of rows) {
  if (!r.contact || !r.slot) { skipped.push(`${r.kid} ${r.slug} (${!r.contact ? 'no contact' : 'no slot'})`); continue; }
  for (const wb of r.ghl_writeback ?? []) {
    if (wb.field_key === 'signature_date' || wb.const_value != null) continue;
    const key = wb.ghl_field_key_by_slot ? wb.ghl_field_key_by_slot[String(r.slot)] : wb.ghl_field_key;
    if (!key) continue;
    const raw = r.responses?.[wb.field_key];
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) continue;
    const b = (r.field_schema ?? []).find((x) => x.key === wb.field_key);
    const lab = new Map((b?.options ?? []).filter((o) => o && typeof o === 'object').map((o) => [String(o.value), String(o.label)]));
    const one = (x) => { const s = String(x ?? ''); if (wb.value_map && s in wb.value_map) return wb.value_map[s]; return wb.write_label ? (lab.get(s) ?? s) : s; };
    const v = (Array.isArray(raw) ? raw.map(one).filter(Boolean).join(wb.write_label ? '; ' : ', ') : one(raw)).replace(/\r?\n+/g, '\n').trim();
    if (!v) continue;
    const m = perContact.get(r.contact) ?? perContact.set(r.contact, { kids: new Set(), vals: {} }).get(r.contact);
    m.kids.add(r.kid); m.vals[key] = v; values++;
  }
}
console.log(`latest linked portal submissions: ${rows.length} → ${values} values on ${perContact.size} contacts; skipped ${skipped.length}`, skipped);
for (const [cid, m] of perContact) console.log('  ', [...m.kids].join(', '), '—', Object.keys(m.vals).length, 'fields');
if (APPLY) {
  const { loadGhlClient } = await import('../lib/ghl/client.ts');
  const { updateContactCustomFields } = await import('../lib/ghl/writes.ts');
  const client = await loadGhlClient(S);
  let ok = 0, fail = 0;
  for (const [cid, m] of perContact) {
    try { await updateContactCustomFields(client, cid, m.vals); ok++; }
    catch (e) { fail++; console.log('  ✗', cid, e?.response?.status, JSON.stringify(e?.response?.data ?? e.message).slice(0, 160)); }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`pushed: ${ok} contacts ok, ${fail} failed`);
}
await db.end(); process.exit(0);
