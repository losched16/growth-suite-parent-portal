// Wooster custom-field reorg v2 — proper folder ORDER + field ORDER.
//
// Folders (top→bottom):  Contact · Student 1 · Student 2 · Student 3 · Student 4
// The stray "Student Information" folder is emptied into the right
// student folders and then deleted.
//
// Field routing is by DISPLAY NAME first (that's what the office reads),
// then by key. The ~60 fields with cloned keys like `asthma_5sn_copy_b5n_copy`
// are REAL Student-1 health-condition questions ("Vision Problems",
// "Has Epipen", …) — routed to Student 1. "(Student N) …" names route to N.
//
// Within each folder, fields get an explicit position so the important
// stuff is on top:
//   Student N: identity → status/program → health → misc → form-tracking dates
//   Contact  : Parent 1 → Parent 2 → family/emergency → billing → misc → utm
//
// Nothing about a field's id/key/data changes — only parentId + position.
//
//   node --env-file=.env.local scripts/reorganize-wooster-fields-v2.mjs          # plan (read-only)
//   node --env-file=.env.local scripts/reorganize-wooster-fields-v2.mjs --apply

import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apply = process.argv.includes('--apply');

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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const nk = (k) => String(k ?? '').replace(/^contact\./, '');

// ── known folder ids (from the audit) ────────────────────────────────
const FOLDER = {
  'Contact':   'FjsK4QyrZ29BNaEssKPR',
  'Student 1': 'nayZq8K2Co18K3m8281J',
  'Student 2': 'kO6qmBxFUppEQ4s2isF3',
  'Student 3': 'gPFvYDaqUzbwULxdeqUB',
  'Student 4': '07pRp4W9SgakJ1RqMEWv',
};
const STRAY_FOLDER = 'gXzUhsqDaxDSOwzaNQow'; // "Student Information"
const FOLDER_ORDER = ['Contact', 'Student 1', 'Student 2', 'Student 3', 'Student 4'];

// ── routing: which folder ────────────────────────────────────────────
function folderFor(name, key) {
  const n = String(name ?? '').trim();
  const k = nk(key);
  // explicit "(Student N)" / "Student N" in the display name wins
  let m = /^\(?\s*student\s*([1-4])\s*\)?/i.exec(n);
  if (m) return `Student ${m[1]}`;
  m = /\(student\s*([1-4])\)/i.exec(n);
  if (m) return `Student ${m[1]}`;
  // slot-keyed
  m = /^student_([1-4])_/.exec(k);
  if (m) return `Student ${m[1]}`;
  m = /_s([1-4])$/.exec(k);
  if (/^form_/.test(k) && m) return `Student ${m[1]}`;
  if (/^student_/.test(k)) return 'Student 1';
  // "Has your child ever …" / injury / illness questions are Student-1 health, even if they mention "hospital"
  if (/your child ever|injuries and illnesses|surgery or serious injury|spent the night/i.test(n)) return 'Student 1';
  // parent / family / billing / marketing / school-level → Contact
  if (/^parent|^utm_|billing|tuition|deposit|discount|payment|pif\b|invoice|financial|scholarship|open house|current family|would you like to add|signature|^form_.*_complete$|grade level of interest|program this child|returning|year of entry|choose your|most important|reviewed and ready|sub total|waived|emergency contact|doctor|dentist|hospital|insurance|physician|consent|pick.?up|authorized|carpool|arrive|depart|schedule|household|language|how did you hear|referr/i.test(n + ' ' + k)) {
    return 'Contact';
  }
  // Student-1 health/medical items (unprefixed): allergy/health-condition
  // checklist, medications, injuries, surgery, hospital nights, special
  // needs, developmental history, sports restriction, medical history note.
  if (/allerg|asthma|epipen|anaphylaxis|seizure|epilepsy|hearing|vision|glasses|ear infection|heart|spleen|hepatitis|cystic|spina|bladder|bowel|organ|emotional|behavior|tics|twitch|spastic|blood disorder|weakness|numbness|osteop|kidney|diabet|medication|injur|illness|surgery|hospital|special needs|disabilit|developmental|birth|sports|activities|medical history|medical condition|health information|health/i.test(n + ' ' + k)) {
    return 'Student 1';
  }
  return 'Contact';
}

// ── ordering: rank within folder (lower = higher on screen) ─────────
function rankStudent(name, key) {
  const n = String(name ?? '').toLowerCase();
  const k = nk(key);
  const base = k.replace(/^student_([1-4]_)?/, '');
  if (/first_name$/.test(k) || /first name/.test(n)) return 10;
  if (/last_name$/.test(k) || /last name/.test(n)) return 20;
  if (/date_of_birth|birth_date|\bdob\b/.test(k) || /date of birth/.test(n)) return 30;
  if (/enrollment_status/.test(k) || /enrollment status/.test(n)) return 40;
  if (/grade/.test(n)) return 50;
  if (/program/.test(n)) return 60;
  if (/year of entry|year_of_entry/.test(n + k)) return 70;
  if (/^form_/.test(k)) return 900; // tracking dates at the bottom
  // health cluster
  if (/allerg|epipen|anaphylaxis/.test(n)) return 200;
  if (/medication/.test(n)) return 210;
  if (/medical condition|medical history|special needs|disabilit|developmental/.test(n)) return 220;
  if (/asthma|seizure|epilepsy|hearing|vision|glasses|ear infection|heart|spleen|hepatitis|cystic|spina|bladder|bowel|organ|emotional|tics|spastic|blood|weakness|numbness|osteop|kidney|diabet/.test(n)) return 300;
  if (/injur|illness|surgery|hospital/.test(n)) return 400;
  if (/sports|activities|provider/.test(n)) return 410;
  if (/tuition|deposit|pay/.test(n)) return 500;
  return 600;
}
function rankContact(name, key) {
  const n = String(name ?? '').toLowerCase();
  const k = nk(key);
  // Parent 1 block first (name, phones), then Parent 2, then family basics
  const sub = /first name/.test(n) ? 0 : /last name/.test(n) ? 1 : /email/.test(n) ? 2 : /cell|mobile/.test(n) ? 3 : /phone/.test(n) ? 4 : 5;
  if (/parent\s*1|^parent1_|^parent_1_/.test(n + ' ' + k)) return 10 + sub;
  if (/parent\s*2|^parent_2_/.test(n + ' ' + k)) return 20 + sub;
  if (/^signature$|parent\/guardian signature/.test(n + k)) return 25;
  if (/household|language|how did you hear|referr|preferred start/.test(n + k)) return 30;
  // Enrollment basics the office reads constantly
  if (/program this child|grade level of interest|year of entry|returning|current family/.test(n)) return 40;
  if (/would you like to add/.test(n)) return 45;
  // Emergency + medical providers
  if (/emergency contact/.test(n)) return 100;
  if (/consent/.test(n)) return 105;
  if (/doctor|physician/.test(n)) return 110;
  if (/dentist/.test(n)) return 112;
  if (/hospital/.test(n)) return 114;
  if (/insurance/.test(n)) return 116;
  // Logistics
  if (/pick.?up|authorized|carpool|arrive|depart|schedule/.test(n)) return 120;
  // Billing / tuition
  if (/tuition|deposit|discount|payment|pif|billing|invoice|financial|scholarship|waived|reviewed and ready|sub total|number of payments|base tuition|faculy|faculty/.test(n + k)) return 300;
  // Family-level form tracking dates
  if (/^form_.*_complete$/.test(k)) return 800;
  // Marketing / event / survey junk at the very bottom
  if (/^utm_/.test(k) || /open house|most important|choose your|upload medical/.test(n)) return 900;
  return 500;
}

// ── load ─────────────────────────────────────────────────────────────
const all = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const fields = all.filter((f) => f.documentType !== 'folder');

const plan = new Map(FOLDER_ORDER.map((n) => [n, []]));
for (const f of fields) plan.get(folderFor(f.name, f.fieldKey)).push(f);

// sort each folder & assign positions spaced by 10 (stable, alphabetical tiebreak)
for (const [fname, list] of plan) {
  const rank = fname === 'Contact' ? rankContact : rankStudent;
  list.sort((a, b) => (rank(a.name, a.fieldKey) - rank(b.name, b.fieldKey)) || String(a.name).localeCompare(String(b.name)));
  list.forEach((f, i) => { f._target = FOLDER[fname]; f._pos = (i + 1) * 10; });
}

// ── report ───────────────────────────────────────────────────────────
console.log('=== PLANNED LAYOUT ===');
for (const fname of FOLDER_ORDER) {
  const list = plan.get(fname);
  console.log(`\n▶ ${fname}  (${list.length} fields)`);
  const show = fname === 'Contact' ? 60 : 14;
  list.slice(0, show).forEach((f) => console.log(`   ${String(f._pos).padStart(4)}  ${f.name}`));
  if (list.length > show) console.log(`   …  +${list.length - show} more (health details / tracking dates at the bottom)`);
}
const moves = fields.filter((f) => f.parentId !== f._target).length;
const reorders = fields.filter((f) => f.parentId === f._target && f.position !== f._pos).length;
console.log(`\nfolder moves: ${moves}   position updates: ${reorders}   folder reorders: 5   stray folder to delete: 1`);
if (!apply) { console.log('\nDRY RUN — re-run with --apply to execute.'); process.exit(0); }

// ── execute ──────────────────────────────────────────────────────────
console.log('\n— setting folder order —');
for (let i = 0; i < FOLDER_ORDER.length; i++) {
  const name = FOLDER_ORDER[i];
  const r = await fetch(`${GHL}/locations/${loc}/customFields/${FOLDER[name]}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ name, model: 'contact', position: (i + 1) * 100 }),
  });
  console.log(`  ${name} → pos ${(i + 1) * 100}: ${r.status}${r.ok ? '' : ' ' + (await r.text()).slice(0, 120)}`);
  await sleep(300);
}

console.log('\n— moving + ordering fields —');
let ok = 0, fail = 0, skipped = 0;
for (const fname of FOLDER_ORDER) {
  for (const f of plan.get(fname)) {
    if (f.parentId === f._target && f.position === f._pos) { skipped++; continue; }
    const body = { name: f.name, dataType: f.dataType, model: 'contact', parentId: f._target, position: f._pos };
    if (Array.isArray(f.picklistOptions) && f.picklistOptions.length) body.options = f.picklistOptions;
    const r = await fetch(`${GHL}/locations/${loc}/customFields/${f.id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    if (r.ok) { ok++; process.stdout.write(`\r  updated ${ok}…   `); }
    else { fail++; console.log(`\n  ✗ ${f.name} [${nk(f.fieldKey)}]: ${r.status} ${(await r.text()).slice(0, 110)}`); }
    await sleep(280);
  }
}
console.log(`\n  updated ${ok}, unchanged ${skipped}, failed ${fail}`);

console.log('\n— deleting stray "Student Information" folder —');
const left = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const stillIn = left.filter((f) => f.parentId === STRAY_FOLDER);
if (stillIn.length) {
  console.log(`  NOT deleting — ${stillIn.length} field(s) still inside:`, stillIn.map((f) => f.name).slice(0, 5));
} else {
  const r = await fetch(`${GHL}/locations/${loc}/customFields/${STRAY_FOLDER}`, { method: 'DELETE', headers: H });
  console.log(`  delete → ${r.status}`);
}
console.log('\nDone.');
