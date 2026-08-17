// Read-only: what folders exist on the Wooster location right now, in
// what order, holding which fields (with position within folder)?
import pg from 'pg';
import crypto from 'node:crypto';
const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
function dec(c2, iv, tag) {
  const k = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(c2), d.final()]).toString('utf8');
}
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
const pit = dec(sc.rows[0].ghl_pit_encrypted, sc.rows[0].ghl_pit_iv, sc.rows[0].ghl_pit_tag);
const loc = sc.rows[0].ghl_location_id;
await db.end();
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' };

// Folders come from a dedicated endpoint (customFields?model=contact only lists fields)
const all = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
let folders = [];
try {
  const fr = await (await fetch(`${GHL}/locations/${loc}/customFields/folders?model=contact`, { headers: H })).json();
  folders = fr.folders ?? fr.customFieldFolders ?? fr ?? [];
} catch {}
if (!Array.isArray(folders) || folders.length === 0) {
  // fall back: infer folders from parentIds + a folder-create dup probe
  const ids = [...new Set(all.map((f) => f.parentId).filter(Boolean))];
  folders = ids.map((id) => ({ id, name: `(id ${id})` }));
}
console.log(`\n=== FOLDERS (${folders.length}) — as returned by GHL ===`);
folders.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}   id=${f.id}   position=${f.position ?? '?'}`));

const nk = (k) => String(k ?? '').replace(/^contact\./, '');
const byFolder = new Map();
for (const f of all) {
  const key = f.parentId ?? '(none)';
  if (!byFolder.has(key)) byFolder.set(key, []);
  byFolder.get(key).push(f);
}
for (const [fid, list] of byFolder) {
  const fname = folders.find((x) => x.id === fid)?.name ?? fid;
  list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  console.log(`\n--- ${fname} (${list.length}) ---`);
  for (const f of list) console.log(`   pos=${String(f.position ?? '?').padStart(4)}  ${f.name}   [${nk(f.fieldKey)}]  ${f.dataType}`);
}
