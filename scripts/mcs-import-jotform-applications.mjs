// MCS — import JotForm "Application for Admission" PDFs into GHL the
// supported way (the live survey has a required $100 payment step and two
// published workflows — replaying it would email the parents a late
// "Thank you for your application" and create pipeline cards for kids who
// are already enrolled).
//
// Per application: answers → the exact contact fields the survey maps to,
// PDF → GHL media library + a contact note (with JotForm payment ref),
// blanks filled on student/parent-2/address, and — for a genuine applicant
// only — a pipeline card in "Application Submitted".
//
//   node --env-file=.env.local scripts/mcs-import-jotform-applications.mjs [--apply]
import fs from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';

const S = 'a8b6674a-2515-4f2e-9897-73a968de7fe1';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = [
  {
    pdf: 'C:/Users/thelo/Downloads/Rocco Zancolli Application.pdf', submitted: '2026-07-28', contactId: 'MNMGOgx44YGZNgluqjMf', slot: 1, applicant: true,
    student: { first: 'Rocco', last: 'Zancolli', dob: '2020-02-22', gender: 'Male', programLabel: 'Lower Elementary (1st grade-3rd grade)', program: 'Lower Elementary', grade: '1st Grade' },
    p1: { address: '137 Brown Road', city: 'Jacksonville', state: 'NC', postal: '28540' },
    p2: { first: 'Alfonso', last: 'Zancolli', email: 'azancolli91@gmail.com', mobile: '(856) 649-3925', street: '137 Brown Road', city: 'Jacksonville', state: 'NC', postal: '28540' },
    a: { sibling: '1', hear: 'Google', toilet: 'Yes', previous: 'Na',
      goals: 'Building the foundation of core subjects as well as fostering his independence and confidence with his work. Another important goal right now is enhancing his social skills.',
      involvement: "I am very much involved and plan to stay involved in following his lead in what he's interested in. I will also continue to help him to navigate his work with support to help him build his confident for more independence.",
      hobbies: 'Jiu jitsu, tumbling/gymnastics, soccer. Loves music and art.',
      social: "He loves making friends after warming up a bit. He's friendly and great with sharing. He does have pretty good emotional intelligence and is great with pinpointing what he's feeling and knows when he needs to take space to himself to recharge.",
      experience: 'Education for him can be challenging at times if he is having a hard time grasping something, but once he grasps it, he soars. He seems to love learning. He loves chess, math, reading, writing, art, music, social studies and science!',
      remedial: 'No, he has only worked with me as his teacher with a bit of online learning the past 6 months.',
      special: 'Rocco does have ADHD and is on medication, which has greatly helped him to open his mind and focus.',
      help: "When he's having a hard time grasping something, he can tend to give up, but we always find a new way to approach it that helps him grasp and gain confidence. So, it's important he is given a different perspective or point of view to grasp whatever he is struggling with." },
    payment: { payer: 'Brittany Largent', amount: '$100.00', txn: '7jl7rjbT3ZOtOarGVud7iaP8MYcZY' },
  },
  {
    pdf: 'C:/Users/thelo/Downloads/William Corwell Application.pdf', submitted: '2026-07-20', contactId: '8gTbi82bh8NbJYcIwezH', slot: 1, applicant: false,
    student: { first: 'William', last: 'Corwell', dob: '2022-11-16', gender: 'Male', programLabel: 'Primary (3-5yrs, including Kindergarten)', program: 'Primary', grade: 'N/A' },
    p1: { address: '1316 Fairbanks Ct', city: 'Jacksonville', state: 'NC', postal: '28546' },
    p2: { first: 'Andrew', last: 'Corwell', email: 'andrewcorwell@gmail.com', mobile: '(252) 570-4905', street: '1316 Fairbanks Ct', city: 'Jacksonville', state: 'NC', postal: '28546' },
    a: { sibling: 'n/a', hear: 'Sister', toilet: 'Yes', previous: "Miss Sandie's School; Excel Learning Center 8",
      goals: 'Provide stimulating enrichment to prepare our son for lifelong, holistic education with the ability to apply critical and creative thinking skills in daily life.',
      involvement: "We maintain an active role in our son's development and intend to support and apply concepts from school into his daily routine at home.",
      hobbies: 'He loves to be active and to learn new skills. He is very interested in how things work and are put together. Vehicles, such as cars, construction trucks, and firetrucks are some of his favorite topics.',
      social: 'On par with peers.',
      experience: 'William has performed well in two school-like daycare settings in both California and recently in Jacksonville, NC following our move to the area. He does well in structured environments and interacts well with his fellow students. He enjoys active lessons and learning new concepts or skills. William can be strong-willed and may benefit from a process driven system which he can apply at both school and daily life.',
      remedial: 'n/a', special: 'n/a',
      help: 'With such a recent move and transitioning between multiple institutions in a relatively short time period, William has shown some separation anxiety at times and may benefit from being talked through new situations.' },
    payment: { payer: 'Andrew Corwell', amount: '$100.00', txn: '1iexwPYtRZGnP326mfoyhTuhqNXZY' },
  },
  {
    pdf: 'C:/Users/thelo/Downloads/Kahlani Palmer Application.pdf', submitted: '2026-07-02', contactId: 'NzUNkohJC7XRIHXbHiix', slot: 1, applicant: false,
    student: { first: 'Kahlani', last: 'Palmer', dob: '2022-09-15', gender: 'Female', programLabel: 'Primary (3-5yrs, including Kindergarten)', program: 'Primary', grade: 'N/A' },
    p1: { address: '181 Waterfront Rd W., Lot 75', city: 'Hubert', state: 'NC', postal: '28539' },
    p2: { first: 'Kevon', last: 'Palmer', email: 'kevon8palmer@gmail.com', mobile: '(984) 569-0628', street: '181 Waterfront Rd W., Lot 75', city: 'Hubert', state: 'NC', postal: '28539' },
    a: { sibling: 'N/A', hear: 'Self research', toilet: 'Yes', previous: 'Childcare Network Hubert',
      goals: 'I would like an environment that works more on her self confidence and critical thinking skills.',
      involvement: 'We are very much involved in her care and schooling. I do currently work with her at home on self confidence and independence.',
      hobbies: 'Building with magnetic, dance, princess roles',
      social: 'I would like to work more on her social skills with others her age.',
      experience: 'She is learning more of the golden rule at this time "Do unto others as you would have them do unto you." Seems to help with social and emotional interaction. Academically she is working on recognizing letter/number sounds, how to read them, tracing, and coloring. I believe the challenges she faces is sometimes being more introverted in some social exercises. Not always wanting to do group activities.',
      remedial: 'No', special: 'No', help: 'No' },
    payment: { payer: 'Ariel Woody', amount: '$100.00', txn: '1SK78P1sJuJ3KvV6qZjQjMhwqdAZY' },
  },
  {
    pdf: 'C:/Users/thelo/Downloads/Rayne Coil Application.pdf', submitted: '2026-07-08', contactId: 'qBtbrcycoZvVwlcvEc8g', slot: 1, applicant: false,
    student: { first: 'Rayne', last: 'Coil', dob: '2017-08-08', gender: 'Female', programLabel: 'Upper Elementary (4th grade-6th grade)', program: 'Upper Elementary', grade: '3rd Grade' },
    p1: { address: '178 Backfield Pl', city: 'Jacksonville', state: 'NC', postal: '28540' },
    p2: { first: 'Joseph', last: 'Coil', email: 'joecoil2009@gmail.com', mobile: '(619) 433-4094', street: '178 Backfield Pl', city: 'Jacksonville', state: 'NC', postal: '28540' },
    a: { sibling: 'n/a', hear: 'friend', toilet: null, previous: 'southwest elementary school, coast to mountains preparatory academy',
      goals: 'learning and retaining the knowledge she is taught by learning different skills to help her be successful in every subject and as well as developing social skills and communication skills. Rayne learning self sufficiency.',
      involvement: 'any role I can to help better Rayne. I was her learning coach for her online schooling, we both worked together to ensure she understood lessons the best we could.',
      hobbies: 'girl scouts/ softball/ drawing/art/ music/',
      social: 'she does fairly well with her social and emotional development; she is the only child, but has neighborhood friends and her girl scouts that she goes to regularly were she learns different social and emotional skills.',
      experience: 'Rayne does well, I observed her not really knowing how to retain the knowledge she receives. In all subjects she always progresses and passes, but at home we work on the challenges best we can',
      remedial: 'no', special: 'no', help: 'I do not know' },
    payment: { payer: 'Joseph Coil', amount: '$100.00', txn: 'xqd26GQsJqPmUNARpCOPglq7ZEAZY' },
    note_extra: 'Application lists Parent 1 email as qljones.1992@outlook.com; contact record has qljones@outlook.com — office to confirm which is current.',
  },
];
const PROGRAM_OPTIONS = ['Stepping Stones (2-3yrs)', 'Primary (3-5yrs, including Kindergarten)', 'Lower Elementary (1st grade-3rd grade)', 'Upper Elementary (4th grade-6th grade)', 'Adolescent (12-14 yrs)'];
const APP_STAGE = { 'Lower Elementary': ['vhrqC1NiPWk2cGW0pAoE', 'c668279d-1b0c-4c2f-b8e5-2a9f3ed2fe59'] }; // pipelineId, "Application Submitted"

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
await db.end();
const kk = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
const dd = crypto.createDecipheriv('aes-256-gcm', kk, sc.rows[0].ghl_pit_iv); dd.setAuthTag(sc.rows[0].ghl_pit_tag);
const pit = Buffer.concat([dd.update(sc.rows[0].ghl_pit_encrypted), dd.final()]).toString('utf8');
const loc = sc.rows[0].ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields;
const byKey = new Map(fields.map((f) => [String(f.fieldKey).replace(/^contact\./, ''), f]));
const fid = (k) => { const f = byKey.get(k); if (!f) throw new Error(`no field ${k}`); return f.id; };
const keyById = new Map(fields.map((f) => [f.id, String(f.fieldKey).replace(/^contact\./, '')]));
const slotKey = (slot, base) => (slot === 1 ? `student_${base}` : `student_${slot}_${base}`);

// 0. restore the Grade Level of Interest options (survey dropdown had only "Adolescent")
const gli = byKey.get('grade_level_of_interest');
const have = gli.picklistOptions ?? gli.options ?? [];
if (PROGRAM_OPTIONS.some((o) => !have.includes(o))) {
  console.log(`grade_level_of_interest options: ${JSON.stringify(have)} → restoring 5 programs`);
  if (apply) { const r = await fetch(`${GHL}/locations/${loc}/customFields/${gli.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: gli.name, options: PROGRAM_OPTIONS }) }); console.log('  ', r.status, r.ok ? 'ok' : (await r.text()).slice(0, 200)); }
}

let ok = 0, fail = 0;
for (const app of APPS) {
  const c = (await (await fetch(`${GHL}/contacts/${app.contactId}`, { headers: H })).json()).contact;
  const cur = {}; for (const f of c.customFields ?? []) { const k = keyById.get(f.id); if (k && f.value != null && String(f.value).trim() !== '') cur[k] = f.value; }
  const cf = []; const set = (k, v, { fillOnly = false } = {}) => { if (v == null || v === '') return; if (fillOnly && cur[k]) return; cf.push({ id: fid(k), value: v }); };
  const sk = (b) => slotKey(app.slot, b);
  // student (fill blanks; DOB from the application — the parent's own entry)
  set(sk('first_name'), app.student.first, { fillOnly: true }); set(sk('last_name'), app.student.last, { fillOnly: true });
  set(sk('date_of_birth'), app.student.dob); set(sk('gender'), app.student.gender, { fillOnly: true });
  set(sk('program'), app.student.program, { fillOnly: true });
  if (app.applicant) set(sk('enrollment_status'), 'applied', { fillOnly: true });
  set('grade_level_of_interest', app.student.programLabel); set('current_grade_level', app.student.grade);
  set('are_you_a_new_or_currently_enrolled_family', 'New', { fillOnly: true });
  // parent 2 (fill blanks)
  set('parent_2_first_name', app.p2.first, { fillOnly: true }); set('parent_2_last_name', app.p2.last, { fillOnly: true });
  set('parent_2_email', app.p2.email, { fillOnly: true }); set('parent_2_mobile', app.p2.mobile, { fillOnly: true });
  set('parent_2_street_address', app.p2.street, { fillOnly: true }); set('parent_2_city', app.p2.city, { fillOnly: true });
  set('parent_2_stateprovince', app.p2.state, { fillOnly: true }); set('parent_2_postal_code', app.p2.postal, { fillOnly: true });
  // application answers (the survey's own target fields)
  set('sibling', app.a.sibling); set('how_did_you_hear_about_us', app.a.hear); set('previous_schools', app.a.previous);
  set('educational_goals', app.a.goals); set('parental_involvement', app.a.involvement); set('hobbies_and_interests', app.a.hobbies);
  set('educational_experience', app.a.experience); set('remedial_work_and_tutoring', app.a.remedial); set('special_needs', app.a.special);
  set('special_help_and_encouragement', app.a.help);
  if (app.a.toilet) set('2_for_stepping_stones_and_primary_students_does_your_child_use_the_toilet_independently', [app.a.toilet]);
  const body = { customFields: cf };
  if (!c.address1) body.address1 = app.p1.address; if (!c.city) body.city = app.p1.city; if (!c.state) body.state = app.p1.state; if (!c.postalCode) body.postalCode = app.p1.postal;
  console.log(`\n${app.student.first} ${app.student.last} → ${c.firstName} ${c.lastName}: ${cf.length} fields, address ${body.address1 ? 'set' : 'kept'}${app.applicant ? ', + pipeline card' : ''}`);
  if (!apply) continue;
  // 1. fields
  const r1 = await fetch(`${GHL}/contacts/${app.contactId}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  console.log('  fields:', r1.status, r1.ok ? '' : (await r1.text()).slice(0, 200)); r1.ok ? ok++ : fail++;
  // 2. PDF → media library
  const fd = new FormData(); const name = `${app.student.first} ${app.student.last} - Application for Admission (JotForm ${app.submitted}).pdf`;
  fd.append('file', new Blob([fs.readFileSync(app.pdf)], { type: 'application/pdf' }), name); fd.append('hosted', 'false'); fd.append('name', name);
  const up = await fetch(`${GHL}/medias/upload-file`, { method: 'POST', headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28' }, body: fd });
  const uj = await up.json().catch(() => ({})); console.log('  pdf:', up.status, uj.url ?? JSON.stringify(uj).slice(0, 120)); up.ok ? ok++ : fail++;
  // 3. note
  const note = [
    `APPLICATION FOR ADMISSION — submitted via JotForm ${app.submitted} (imported to Growth Suite 2026-08-21)`,
    `Student: ${app.student.first} ${app.student.last} · DOB ${app.student.dob} · ${app.student.gender} · Applying for: ${app.student.programLabel} · Current grade: ${app.student.grade}`,
    `Parent 2: ${app.p2.first} ${app.p2.last} · ${app.p2.email} · ${app.p2.mobile}`,
    `Application fee: ${app.payment.amount} paid via JotForm by ${app.payment.payer} (txn ${app.payment.txn})`,
    `Social development: ${app.a.social}`,
    `Full application PDF: ${uj.url ?? '(upload failed)'}`,
    'Answers are in the contact fields (Educational Goals, Parental Involvement, Hobbies, Educational Experience, Remedial Work, Special Needs, Special Help, Previous Schools, How did you hear).',
    app.note_extra ?? '',
  ].filter(Boolean).join('\n');
  const r3 = await fetch(`${GHL}/contacts/${app.contactId}/notes`, { method: 'POST', headers: H, body: JSON.stringify({ body: note }) });
  console.log('  note:', r3.status); r3.ok ? ok++ : fail++;
  // 4. pipeline card — genuine applicant only
  if (app.applicant) {
    const [pipelineId, stageId] = APP_STAGE[app.student.program];
    const opps = ((await (await fetch(`${GHL}/opportunities/search?location_id=${loc}&contact_id=${app.contactId}&limit=20`, { headers: H })).json()).opportunities ?? []).filter((o) => o.status === 'open');
    const existing = opps.find((o) => o.pipelineId === pipelineId);
    const r4 = existing
      ? await fetch(`${GHL}/opportunities/${existing.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: `${app.student.first} ${app.student.last}`, pipelineId, pipelineStageId: stageId }) })
      : await fetch(`${GHL}/opportunities/`, { method: 'POST', headers: H, body: JSON.stringify({ pipelineId, locationId: loc, name: `${app.student.first} ${app.student.last}`, pipelineStageId: stageId, status: 'open', contactId: app.contactId }) });
    console.log(`  card: ${existing ? 'moved "' + existing.name + '"' : 'created'} → Application Submitted`, r4.status, r4.ok ? '' : (await r4.text()).slice(0, 200)); r4.ok ? ok++ : fail++;
  }
  await sleep(300);
}
console.log(apply ? `\napplied: ${ok} ok, ${fail} failed` : '\nDRY RUN');
