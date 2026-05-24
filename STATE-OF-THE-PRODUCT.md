# Growth Suite Parent Portal — State of the Product

**Last updated:** 2026-05-23
**Purpose of this doc:** Starting point for any new Claude Code session.
Read this FIRST before touching code.

---

## What this repo IS

The parent-facing portal for Growth Suite. Where parents go to:
- Fill out school forms (emergency medical, enrollment agreement,
  health history, medications, injury history, etc.)
- View their family info (parents, students, emergency contacts, pickup
  permissions)
- Check students in / out for attendance
- Pay tuition and view invoices
- Apply for financial aid
- Manage authorized pickup people

Built on Next.js 16 App Router, shares the same Supabase Postgres DB as the
`growth-suite-dashboards` repo.

## Currently live schools

Both production:
- Montessori School of Wooster
- Desert Garden Montessori (DGM)

Parents log in via magic-link emails sent through Resend. School staff
demo-login via `/api/dev/login-as-parent?email=<email>` (gated by
`PARENT_DEMO_BYPASS=true` or token-auth — turn off in prod when not demoing).

## Architecture

```
                 ┌──────────────────────────────┐
                 │ growth-suite-parent-portal    │ (this repo)
                 └──────────┬───────────────────┘
                            │
                            ▼
        ┌────────────────────────────────────────────┐
        │   Supabase Postgres (shared with dashboards)│
        └────────────────────────────────────────────┘
                            ▲
                            │
                 ┌──────────┴───────────────────┐
                 │  growth-suite-dashboards      │ (staff side, separate repo)
                 └──────────────────────────────┘
```

## Key sections of the portal

| Path | What it is |
|---|---|
| `/home` | Dashboard landing page after login |
| `/family` | Parent + student + emergency contact management |
| `/forms-v2` | Form list |
| `/forms-v2/[slug]` | Individual form (renders schema from `portal_form_definitions`) |
| `/forms-v2/history` | Submission history |
| `/attendance/check-in` | Drop-off flow (signature, curbside, notes) |
| `/attendance/check-out` | Pickup flow (pickup person selection, signature) |
| `/billing/pay/[invoiceId]` | Invoice payment |
| `/billing/payment-methods` | Saved cards / ACH |
| `/billing/plan` | Payment plan management |
| `/financial-aid/apply` | FA application |
| `/settings/pickup-people` | Manage authorized pickup persons |
| `/messages` | School messages |
| `/tuition` | Tuition overview |

## Multi-tenant readiness

| Subsystem | Multi-tenant ready? | Notes |
|---|---|---|
| Auth (magic-link via Resend) | ✅ Yes | Scopes to school via parent's `school_id` |
| Form renderer | ✅ Yes | 100% schema-driven from DB |
| Family page (parents + students + ECs + pickup) | ✅ Yes | All school-scoped |
| Attendance check-in/out | ✅ Yes | Generic |
| Parent privacy toggle | ✅ Yes | Newly shipped |
| Per-student parent assignments | ✅ Yes | Newly shipped |
| Co-parent overwrite warnings | ✅ Yes | Newly shipped |
| Signature canvas | ✅ Yes | Fixed `clearOnResize` regression |
| Per-school branding | ⚠️ Partial | `--brand` CSS var works, no admin UI to configure |
| Custom domain per school | ❌ No | Single Vercel domain today |
| Payment flow | ⚠️ Stripe Connect | Will migrate to GHL native payments |

## Key files & where things live

```
app/
  (portal)/                  — auth-required parent portal routes (route group)
    family/page.tsx          — family management (parents, students, ECs)
    forms-v2/[slug]/
      page.tsx               — form server component (loads definition, prefill, submissions)
      FormRenderer.tsx       — client component, ~1600 lines, the main form-rendering engine
    attendance/              — check-in / check-out flows
    billing/                 — invoices, payment methods, plans
    settings/pickup-people/  — pickup person management
  api/
    portal-forms/submit/route.ts   — form submission (validates, persists, GHL writeback)
    portal-forms/migration-flag/   — confirm-action endpoints for legacy data flags
    dev/login-as-parent/route.ts   — demo bypass (DEV_AUTH_BYPASS / PARENT_DEMO_BYPASS)

lib/
  identity.ts                — requireParent(), session helpers
  family-data.ts             — loadParentsForFamily, loadStudentsForFamily, loadParentStudentAssignments
  actions/                   — server actions (edit-parent, edit-student)
  forms/
    types.ts                 — FormFieldBlock union (header/paragraph/text/select/radio/multi_checkbox/student_applicability/signature/pricing/etc.)
    prefill.ts               — resolvePrefill() — reads `student.full_name`, etc. into form defaults
    payment-eval.ts          — evaluates payment_config rules
  ghl/                       — GHL writeback clients

migrations/                  — 5 SQL files (much fewer than dashboards repo)
```

## Environment

**Vercel project:** `growth-suite-parent-portal`
**Live URL:** `growth-suite-parent-portal.vercel.app`

**Required env vars:**
- `DATABASE_URL`, `ENCRYPTION_KEY` (shared with dashboards)
- `PARENT_SESSION_SECRET` — for JWT signing
- `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_REPLY_TO` — magic-link emails
- `DEV_AUTH_BYPASS` (set to `true` for demo) OR `PARENT_DEMO_BYPASS=true`
- `GHL_LOGIN_SECRET` — generated magic links (must match dashboards)

## Form schema model (important!)

Forms are 100% data-driven. A single `portal_form_definitions` row holds:
- `slug` (URL slug)
- `display_name`, `description`, `category`
- `per_student` boolean (does it ask once per student or once per family?)
- `field_schema` JSONB — array of typed blocks rendered by `FormRenderer.tsx`
- `payment_config` JSONB — optional payment rules
- `legacy_completion_field_key` — for legacy-form migration detection
- `ghl_writeback` — array of `{field_key, ghl_field_key}` mappings

Block types supported in `field_schema` (see `lib/forms/types.ts`):
- Display: `header`, `paragraph`, `section`
- Inputs: `text`, `textarea`, `number`, `date`, `email`, `tel`, `url`,
  `select`, `radio`, `checkbox`, `multi_checkbox`
- New: `student_applicability` (per-student picker — used by emergency contacts)
- Files: `file_upload`
- Signatures: `signature_drawn`, `signature_typed`
- Pricing: `pricing_select`, `multi_pricing`, `quantity_pricing`, `tuition_calculator`

## Submission flow

1. Parent loads `/forms-v2/[slug]` → server fetches form definition, prefill context, existing submissions
2. `FormRenderer.tsx` renders the schema
3. On submit → POST to `/api/portal-forms/submit`
4. Server validates against schema (required fields, file uploads, etc.)
5. Saves to `portal_form_submissions` (responses JSONB)
6. Queues GHL writeback to push fields back to the contact's custom fields

## Important things to know

1. **Form schema lives in the DB, not in code.** To add fields to a form, you update `portal_form_definitions.field_schema` jsonb (see `growth-suite-dashboards/scripts/_patch_*.mjs` for examples).
2. **The signature canvas needs `clearOnResize={false}`** — without it, any layout shift wipes the drawing. (Fixed in this codebase but worth knowing.)
3. **Legacy submissions** from the GHL import have a `legacy_source` value set. The renderer treats them as "complete · submitted via legacy form" with a softer prefill story.
4. **Per-student forms** auto-iterate over the family's students. The student picker shows completion badges (done / legacy / # of flags).
5. **Co-parent overwrite warnings** fire when the last submitter's `parent_id` ≠ the current viewer's. 3-layer UX (lock state, in-form banner, submit confirm).

## What's new in the parent portal (last sprint)

- 5 emergency contact slots + free-form overflow textarea
- Per-student "Applies to which students?" picker on each EC (new `student_applicability` block type)
- Parent privacy toggle (divorced families)
- Parent-to-student assignment picker (blended families)
- Co-parent overwrite warnings
- Signature canvas fixed
- Family page now surfaces emergency contacts + per-student assignments

## What NOT to touch yet

- Stripe Connect integration (will be replaced by GHL payments — architectural decision pending)
- The `(portal)/forms/` directory — that's the old `forms` route, superseded by `forms-v2`. Keep around for now but don't extend.
