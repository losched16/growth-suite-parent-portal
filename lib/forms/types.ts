// Discriminated-union type for every block in a form's field_schema.
// JSONB-stored on portal_form_definitions.field_schema; matches the seed
// data + the renderer in app/(portal)/forms-v2/[slug]/page.tsx.
//
// Adding a new field type:
//   1. Add an entry to FormFieldBlock
//   2. Add a case to renderField() in the renderer
//   3. (optional) Add a coercion in submit/route.ts if it needs special
//      handling (e.g. signature canvas → base64 PNG)

// Display-only blocks (no `key`)
export interface HeaderBlock {
  type: 'header';
  text: string;
}
export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
  emphasis?: 'normal' | 'note' | 'warning';
}
export interface SectionBlock {
  type: 'section';
  label: string;
  description?: string;
}

// Interactive blocks (all have `key`, `label`, `required`)
interface BaseField {
  key: string;
  label: string;
  required?: boolean;
  help?: string;                     // shown under the input
  prefill?: PrefillSource;            // see below
  width?: 'full' | 'half' | 'third';  // grid hint for the layout
  // Static literal default — used when no `prefill` resolved value
  // exists AND no legacy response is on file. Useful for fields
  // that are required by an external compliance form but not
  // applicable to this particular school (e.g. PA Code requires a
  // "Swimming consent" field but MCH doesn't offer swimming — set
  // default: 'N/A').
  default?: string;
  // When true, the input renders LOCKED — value is visible but parents
  // can't change it. Used on contract fields like tuition amount /
  // payment plan / due dates where any change must be initiated by the
  // school (not the parent). The renderer uses the HTML `readOnly`
  // attribute so the value still submits with the form — parents simply
  // can't edit it. Schools using readOnly should also set `prefill` so
  // there's something to display (an empty readOnly input is useless).
  readOnly?: boolean;
  // When true on a per-family form (`per_student: false`), the input
  // renders ONE COPY PER STUDENT in the family instead of a single
  // family-wide input. Each per-student copy submits its value under
  // a separate key: `<block.key>__<student_id>`. Used on Wooster's
  // Emergency Medical form so existing conditions / medications /
  // allergies can differ per kid without forcing the parent to fill
  // the entire form once per child. When the family has only one
  // student, the renderer falls through to the normal single input.
  student_specific?: boolean;
}

export type PrefillSource =
  | 'parent.first_name'
  | 'parent.last_name'
  | 'parent.full_name'
  | 'parent.email'
  | 'parent.phone'
  | 'student.first_name'
  | 'student.last_name'
  | 'student.full_name'
  | 'student.date_of_birth'
  // Per-student admission date. Set by school staff via the family
  // hub (or synced from GHL custom field student_date_of_admission /
  // student_N_date_of_admission). Used by DHS Agreement + Summer Camp
  // DHS to fill in the "Date of child's admission" line without the
  // parent having to know it.
  | 'student.date_of_admission'
  | 'health.emergency_contact_name'
  | 'health.emergency_contact_phone'
  | 'health.emergency_contact_relationship'
  | 'health.primary_doctor_name'
  | 'health.primary_doctor_phone'
  | 'health.preferred_hospital'
  | 'health.health_insurance_provider'
  | 'health.health_insurance_policy_number'
  | 'health.allergies'
  | 'health.current_medications'
  | 'health.medical_conditions'
  // Native enrollment data — populates when the student has an active
  // family_tuition_enrollments row for the current academic year. Used
  // by the Tuition Agreement form so each family sees THEIR contracted
  // amounts pre-filled (no Calculate-Your-Own math in the contract).
  | 'enrollment.program_label'           // "Primary — 5 Days, Full Day"
  | 'enrollment.plan_label'              // "Monthly Payment (10 installments)"
  | 'enrollment.annual_tuition_dollars'  // "12800.00"  (before plan discount)
  | 'enrollment.total_annual_dollars'    // "12416.00"  (after plan discount)
  | 'enrollment.installment_count'       // "10"
  | 'enrollment.installment_dollars'     // "1241.60"   (total_annual / installment_count, 2dp)
  | 'enrollment.first_due_date'          // "2026-07-15"
  | 'enrollment.last_due_date'           // "2027-04-15"
  // Fee breakdown (from family_tuition_enrollments.addons) — for the
  // tuition contract + DHS form to show every line.
  | 'enrollment.base_tuition_dollars'    // grid base tuition
  | 'enrollment.extended_care_dollars'
  | 'enrollment.extended_care_monthly_dollars'  // annual ext care ÷ 10 (DHS Jul–Apr)
  | 'enrollment.development_fee_dollars'
  | 'enrollment.deposit_dollars'         // deposit already paid (credit)
  | 'enrollment.sibling_discount_dollars'
  | 'enrollment.prompt_pay_discount_dollars'  // 3% paid-in-full discount
  | 'enrollment.scholarship_dollars'
  // Attendance schedule (from students.metadata, surfaced per-enrollment).
  | 'enrollment.schedule_days'
  | 'enrollment.arrival_time'
  | 'enrollment.departure_time'
  | 'today';

export interface TextField extends BaseField {
  type: 'text' | 'email' | 'tel' | 'url';
  placeholder?: string;
  max_length?: number;
}
export interface TextareaField extends BaseField {
  type: 'textarea';
  placeholder?: string;
  rows?: number;
}
export interface NumberField extends BaseField {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}
export interface DateField extends BaseField {
  type: 'date';
  min?: string;       // ISO YYYY-MM-DD
  max?: string;
}
export interface SelectField extends BaseField {
  type: 'select';
  options: Array<{ value: string; label: string }>;
}
export interface RadioField extends BaseField {
  type: 'radio';
  options: Array<{ value: string; label: string }>;
}
export interface CheckboxField extends BaseField {
  type: 'checkbox';
  // Single checkbox: parent must confirm = required:true. e.g.
  // acknowledgement of liability.
}
export interface MultiCheckboxField extends BaseField {
  type: 'multi_checkbox';
  options: Array<{ value: string; label: string }>;
}

// Per-student applicability picker. Options are populated dynamically
// from the family's students at render time — schema authors don't have
// to hand-roll them. Used by emergency-contact slots so a parent can
// say "Aunt Jane is the EC for Charlotte only, not Natalie."
//
// Storage: array of student UUIDs in the responses jsonb. A special
// `'all'` sentinel represents "applies to every student in the family"
// — keeps the data forward-compatible if more siblings are added later.
export interface StudentApplicabilityField extends BaseField {
  type: 'student_applicability';
  // Default behavior when the parent hasn't checked anything yet.
  // 'all' (recommended) is friendlier — most families' contacts apply
  // to every child.
  default_selection?: 'all' | 'none';
}
export interface FileUploadField extends BaseField {
  type: 'file_upload';
  accept?: string;                    // MIME glob ('application/pdf,image/*')
  multiple?: boolean;
  max_size_mb?: number;
}

// Student picker — only renders if the form is `per_student: true`.
// Auto-populates from the parent's family. We don't expose this as a
// field author can pick — it's automatic. But the schema can include
// extra logic-only entries if needed in the future.

// Signatures — two flavors:
export interface SignatureDrawnField extends BaseField {
  type: 'signature_drawn';
}
export interface SignatureTypedField extends BaseField {
  type: 'signature_typed';
  // Optional acknowledgment text shown above the typed-name input.
  acknowledgment?: string;
}

// Display-only operator signature pre-stamped onto the form. Renders
// the name in a script font with the title and the (fixed) date
// underneath. NOT a parent input — there's no `name` key and nothing
// gets submitted from this block. Used when the school's
// administrator has pre-signed the form (PA DHS Agreement, etc.) and
// every parent sees the same signature.
export interface SignatureStampBlock {
  type: 'signature_stamp';
  signer_name: string;
  signer_title?: string;
  signed_date: string;       // ISO YYYY-MM-DD
}

// ─── Phase 3: pricing / payment blocks ──────────────────────────────
//
// PricingSelectField — single-choice picker where each option has a
// price. Rendered like a radio group, but the FormRenderer adds the
// selected option's price into the form's running total.
export interface PricingSelectField extends BaseField {
  type: 'pricing_select';
  options: Array<{
    value: string;
    label: string;
    amount_cents: number;
    // Optional visibility predicate. If set, the option only renders
    // when responses[visible_when.field] is one of visible_when.equals.
    // e.g. show Toddler tuition only when grade_level === 'toddler'.
    visible_when?: { field: string; equals: string[] };
  }>;
  // Whether option price is shown in the label (e.g. "$25 — Pizza")
  show_price_in_label?: boolean;
}

// MultiPricingField — multi-select where each option has a price. All
// checked options' prices sum into the form's running total.
export interface MultiPricingField extends BaseField {
  type: 'multi_pricing';
  options: Array<{ value: string; label: string; amount_cents: number }>;
}

// QuantityPricingField — numeric quantity × per-unit price.
// Useful for "How many tickets?" type fields.
export interface QuantityPricingField extends BaseField {
  type: 'quantity_pricing';
  unit_label: string;          // "ticket", "shirt", etc.
  unit_amount_cents: number;
  min?: number;
  max?: number;
}

// TuitionCalculatorField — looks up the school's tuition_grids table
// and presents the matching plans/addons. Parents pick a plan and
// optional addons; renderer computes the annual total.
export interface TuitionCalculatorField extends BaseField {
  type: 'tuition_calculator';
  academic_year?: string;           // default to school's current year
  // Optional filter on program or grade level (matches tuition_grids row)
  program?: string;
  grade_level?: string;
  // Show payment-plan picker that adjusts based on plan discount?
  include_plan_picker?: boolean;
}

export type FormFieldBlock =
  | HeaderBlock | ParagraphBlock | SectionBlock
  | TextField | TextareaField | NumberField | DateField
  | SelectField | RadioField | CheckboxField | MultiCheckboxField
  | StudentApplicabilityField
  | FileUploadField
  | SignatureDrawnField | SignatureTypedField | SignatureStampBlock
  | PricingSelectField | MultiPricingField | QuantityPricingField | TuitionCalculatorField;

// ─── Form-level payment configuration ────────────────────────────────
// Stored as the form definition's `payment_config` jsonb column.
// When present + mode='required', the parent must pay before the
// submission is finalized.
export interface FormPaymentConfig {
  mode: 'required' | 'optional';
  // Invoice title template — '{form_name}' / '{student_name}' tokens.
  invoice_title_template?: string;
  // How to derive invoice lines from this form's responses.
  lines: PaymentLineRule[];
  // Optional: default due-days from submission (defaults to 0 = today)
  due_days_from_submission?: number;
  // Optional: explicit override (defaults to auto — true if family hasn't paid yet)
  includes_platform_setup_fee?: boolean;
}

// Optional proration directive on a tuition-style line. When set, the
// resolved amount is scaled by months_remaining / total_months based
// on the parent's chosen enrollment_start_date.
//   reference_field — name of the date field on the form (e.g. 'enrollment_start_date')
//   anchor_date     — academic-year start (e.g. '2026-08-01')
//   total_months    — N months in a full year (e.g. 10 for DGM)
export interface ProrateConfig {
  reference_field: string;
  anchor_date: string;        // 'YYYY-MM-DD'
  total_months: number;
}

// Each rule resolves at submit time into one or more invoice line items.
export type PaymentLineRule =
  | { kind: 'fixed'; label: string; amount_cents: number; category?: string }
  | { kind: 'pricing_select'; field_key: string; label_template?: string; category?: string; prorate?: ProrateConfig }
  | { kind: 'multi_pricing'; field_key: string; category?: string; prorate?: ProrateConfig }
  | { kind: 'quantity_pricing'; field_key: string; label?: string; category?: string }
  | { kind: 'tuition_calculator'; field_key: string; category?: string }
  // A fee whose amount switches based on whether the form is submitted
  // on or before vs. after a cutoff date. e.g. DGM's enrollment fee
  // ($395 ≤ 2026-01-31, $595 after). Resolved against `new Date()`
  // on the client (live preview) and against the actual submission
  // timestamp on the server.
  | {
      kind: 'date_based_fee';
      label_before_cutoff: string;
      label_after_cutoff: string;
      cutoff_date: string;            // 'YYYY-MM-DD'
      before_cents: number;
      after_cents: number;
      category?: string;
    }
  // Post-eval modifier that reacts to a radio/select field choice.
  // For DGM: when payment_plan === 'monthly' add a +3% admin fee on
  // categories=['tuition','extended_day','lunch'], when 'annual' add
  // a -5% discount on the same categories.
  | {
      kind: 'payment_plan_modifier';
      field_key: string;             // e.g. 'payment_plan'
      // map of field value → modifier definition
      modifiers: Record<string,
        { label: string; pct_basis_points: number; applies_to_categories: string[]; category?: string }
      >;
    };

export interface FormDefinition {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  required_for: string | null;
  field_schema: FormFieldBlock[];
  fee_amount: number | null;
  one_submission_per_year: boolean;
  resubmission_allowed: boolean;
  needs_review: boolean;
  payment_config: FormPaymentConfig | null;
  // When true, parents can submit a partial update ("addendum") that
  // only changes specific fields. The original submission stays intact
  // and the addendum links back via parent_submission_id.
  allow_addendum: boolean;
}

export function isDisplayOnlyBlock(b: FormFieldBlock): b is HeaderBlock | ParagraphBlock | SectionBlock {
  return b.type === 'header' || b.type === 'paragraph' || b.type === 'section';
}
