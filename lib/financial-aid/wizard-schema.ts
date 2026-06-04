// 10-step FA wizard schema. FAST-equivalent depth (~80 fields across
// the form) with the modern UX wrapper (per-section "Why we ask",
// plain-language help text, save-and-continue, "Not sure" affordances).
//
// Repeatable groups (`field.type === 'group'`) drive the per-parent,
// per-dependent, per-vehicle, and per-additional-property sections.
// Each group renders as a stack of cards in the wizard with Add /
// Remove buttons (max enforced via groupMaxCount).
//
// Hardcoded vs DB-configurable: the QUESTIONS rarely change between
// schools. What schools customize is what docs they require, what
// year they're collecting for, who gets notified — those live in
// school_financial_aid_settings. Keeps the parent-side reusable.

export type WizardFieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'money'
  | 'yes_no'
  | 'select'
  | 'date'
  | 'group';

export interface WizardField {
  key: string;
  type: WizardFieldType;
  label: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  groupFields?: WizardField[];          // for type='group'
  groupSingularLabel?: string;          // 'Parent', 'Vehicle' — used in Add button
  groupMinCount?: number;               // min cards (default 0)
  groupMaxCount?: number;               // max cards (default 6)
  width?: 'full' | 'half';
}

export interface WizardSection {
  key: string;
  step: number;
  title: string;
  why: string;
  intro?: string;
  fields: WizardField[];
  optionalExplanationKey?: string;
}

// ── shared sub-field templates ──────────────────────────────────────
const PARENT_FIELDS: WizardField[] = [
  { key: 'first_name', type: 'short_text', label: 'First name', required: true, width: 'half' },
  { key: 'last_name',  type: 'short_text', label: 'Last name',  required: true, width: 'half' },
  { key: 'dob',        type: 'date', label: 'Date of birth', width: 'half' },
  { key: 'phone',      type: 'short_text', label: 'Best phone number', placeholder: '(555) 123-4567', width: 'half' },
  { key: 'occupation', type: 'short_text', label: 'Occupation', help: 'e.g. Software engineer, RN, stay-at-home parent', width: 'half' },
  { key: 'employer',   type: 'short_text', label: 'Employer', help: 'Leave blank if self-employed or not working.', width: 'half' },
  { key: 'has_disability', type: 'yes_no', label: 'Disability that affects income or expenses?', help: 'We use this to weigh medical + accommodation costs fairly. Optional.' },
];

const DEPENDENT_FIELDS: WizardField[] = [
  { key: 'first_name', type: 'short_text', label: 'First name', required: true, width: 'half' },
  { key: 'last_name',  type: 'short_text', label: 'Last name',  width: 'half' },
  { key: 'dob',        type: 'date', label: 'Date of birth', width: 'half' },
  { key: 'relationship', type: 'select', label: 'Relationship', width: 'half', required: true, options: [
    { value: 'child', label: 'Child (not applying to this school)' },
    { value: 'adult_dependent', label: 'Adult dependent (parent, in-law, etc.)' },
    { value: 'other', label: 'Other dependent' },
  ]},
  { key: 'current_grade', type: 'short_text', label: 'Current grade (if a child)', help: 'e.g. K, 3rd, 8th — leave blank for adult dependents.', width: 'half' },
  { key: 'current_school', type: 'short_text', label: 'Current school (if any)', placeholder: 'e.g. Phoenix Country Day', width: 'half' },
  { key: 'tuition_paid_annually', type: 'money', label: 'Tuition paid annually (if any)', help: 'Only if this dependent pays tuition somewhere.', width: 'half' },
  { key: 'scholarships_received', type: 'money', label: 'Scholarships / aid received', help: 'Annual aid this dependent gets from any source.', width: 'half' },
  { key: 'lives_same_address', type: 'yes_no', label: 'Lives at the same address as the applying student(s)?' },
];

const VEHICLE_FIELDS: WizardField[] = [
  { key: 'make_model', type: 'short_text', label: 'Make & model', placeholder: 'e.g. Honda Odyssey', width: 'half' },
  { key: 'year',       type: 'short_text', label: 'Year', placeholder: 'e.g. 2019', width: 'half' },
  { key: 'estimated_value', type: 'money', label: 'Estimated value (KBB)', help: 'Kelley Blue Book private-party value is fine.', width: 'half' },
  { key: 'outstanding_loan', type: 'money', label: 'Outstanding loan/lease balance', help: 'Leave blank if owned outright.', width: 'half' },
  { key: 'monthly_payment', type: 'money', label: 'Monthly payment', help: 'Loan or lease. Leave blank if none.' },
];

const PROPERTY_FIELDS: WizardField[] = [
  { key: 'description', type: 'short_text', label: 'Description', placeholder: 'e.g. Rental in Tucson, vacation home', width: 'half' },
  { key: 'estimated_market_value', type: 'money', label: 'Estimated current market value', width: 'half' },
  { key: 'mortgage_balance', type: 'money', label: 'Mortgage balance', width: 'half' },
  { key: 'monthly_payment', type: 'money', label: 'Monthly payment (PITI)', width: 'half' },
  { key: 'annual_rental_income', type: 'money', label: 'Annual rental income (if any)', help: 'Gross before expenses.' },
];

// ── 1. Your family + parents ────────────────────────────────────────
const STEP_FAMILY: WizardSection = {
  key: 'family',
  step: 1,
  title: 'Your family',
  why: 'Household size + a profile of each parent in the home is how we anchor the rest of the application. We don\'t share parent info with anyone outside the committee.',
  fields: [
    { key: 'household_size', type: 'number', label: 'How many people live in your home?', help: 'Count everyone — adults, the students applying, other kids, adult dependents.', required: true, placeholder: 'e.g. 4', width: 'half' },
    { key: 'marital_status', type: 'select', label: 'Marital status of the applying parent(s)', required: true, width: 'half', options: [
      { value: 'married_joint', label: 'Married, filing jointly' },
      { value: 'married_separate', label: 'Married, filing separately' },
      { value: 'single', label: 'Single' },
      { value: 'divorced', label: 'Divorced' },
      { value: 'widowed', label: 'Widowed' },
      { value: 'separated', label: 'Separated' },
      { value: 'partnered', label: 'Domestic partnership' },
    ] },
    { key: 'recent_change', type: 'yes_no', label: 'Did your family situation change in the last 12 months?', help: 'New baby, divorce, death, job loss, medical event — anything that affects finances.' },
    { key: 'recent_change_detail', type: 'long_text', label: 'Tell us about the change', help: 'Only if you answered yes above.' },
    {
      key: 'parents',
      type: 'group',
      label: 'Parents / guardians in this household',
      help: 'Fill out one card per adult who shares financial responsibility for the household. Most families have 1 or 2.',
      groupSingularLabel: 'Parent / guardian',
      groupMinCount: 1,
      groupMaxCount: 4,
      groupFields: PARENT_FIELDS,
    },
  ],
  optionalExplanationKey: 'family_notes',
};

// ── 2. Students applying (rendered specially — see _WizardHost) ────
const STEP_STUDENTS: WizardSection = {
  key: 'students',
  step: 2,
  title: 'Students applying',
  why: 'We need to know which of your kids are attending this school and what tuition you\'re facing. Aid is awarded per student, but we look at your household as a whole.',
  fields: [],
};

// ── 3. Other dependents ─────────────────────────────────────────────
const STEP_DEPENDENTS: WizardSection = {
  key: 'dependents',
  step: 3,
  title: 'Other dependents',
  why: 'Siblings at other schools (especially private schools), and adult dependents like elderly parents who live with you, both materially affect what your household can afford. Tell us about them.',
  intro: 'Skip this step entirely if there are no other dependents in your household.',
  fields: [
    {
      key: 'dependents',
      type: 'group',
      label: 'Other dependents',
      help: 'Other children NOT applying to this school + any adults you support.',
      groupSingularLabel: 'Dependent',
      groupMinCount: 0,
      groupMaxCount: 10,
      groupFields: DEPENDENT_FIELDS,
    },
  ],
  optionalExplanationKey: 'dependents_notes',
};

// ── 4. Income ───────────────────────────────────────────────────────
const STEP_INCOME: WizardSection = {
  key: 'income',
  step: 4,
  title: 'Household income',
  why: 'Income is the strongest predictor of how much tuition a family can carry. We need real numbers from your most recent filed tax return.',
  intro: 'Pull last year\'s 1040 + your W-2s. If you haven\'t filed yet, your last full-year statements are fine — just check "I haven\'t filed yet" below.',
  fields: [
    { key: 'has_filed_taxes', type: 'yes_no', label: 'Have you filed last year\'s federal tax return yet?', required: true },
    { key: 'federal_agi', type: 'money', label: 'Federal AGI (line 11 of your 1040)', help: 'Adjusted Gross Income — single most important number to the committee. Leave blank if not filed.', width: 'half' },
    { key: 'federal_taxable_income', type: 'money', label: 'Federal taxable income (line 15)', help: 'After standard / itemized deductions.', width: 'half' },
    { key: 'w2_adult_1', type: 'money', label: 'Adult 1 — gross wages (W-2 Box 1)', help: 'From Box 1 of all W-2s for Adult 1, combined.', width: 'half' },
    { key: 'w2_adult_2', type: 'money', label: 'Adult 2 — gross wages (W-2 Box 1)', help: 'Leave blank if single-parent or other adult had no W-2 income.', width: 'half' },
    { key: 'self_employed_income', type: 'money', label: 'Self-employment / business income (Schedule C)', help: 'Net profit after business expenses. Negative numbers not allowed here — explain losses below.' },
    { key: 'dividend_interest_income', type: 'money', label: 'Dividends + interest income', help: 'From 1099-DIV + 1099-INT. Savings, brokerage interest, bond coupons.', width: 'half' },
    { key: 'capital_gains', type: 'money', label: 'Capital gains (Schedule D)', help: 'Stock or real-estate sale gains for the year.', width: 'half' },
    { key: 'rental_income', type: 'money', label: 'Rental / real estate income', help: 'Net of expenses, before depreciation. Schedule E.', width: 'half' },
    { key: 'trust_inheritance_income', type: 'money', label: 'Trust + inheritance income', help: 'From K-1 schedules + any inheritance received this year.', width: 'half' },
    { key: 'alimony_received', type: 'money', label: 'Alimony received (annual)', width: 'half' },
    { key: 'child_support_received', type: 'money', label: 'Child support received (annual)', width: 'half' },
    { key: 'gifts_received', type: 'money', label: 'Gifts received (annual)', help: 'From grandparents or other relatives.', width: 'half' },
    { key: 'other_income', type: 'money', label: 'Other income', help: 'Part-time / 1099 work, disability, retirement income, hobbies, court awards, gambling. Anything not listed above.', width: 'half' },
  ],
  optionalExplanationKey: 'income_notes',
};

// ── 5. Real estate ──────────────────────────────────────────────────
const STEP_REAL_ESTATE: WizardSection = {
  key: 'real_estate',
  step: 5,
  title: 'Your housing',
  why: 'Whether you own or rent + your housing burden is one of the biggest costs in any family budget. Renters: just fill in the rent line. Owners: a few extra fields about your mortgage.',
  fields: [
    { key: 'housing_type', type: 'select', label: 'Do you own or rent?', required: true, options: [
      { value: 'own_with_mortgage', label: 'Own with mortgage' },
      { value: 'own_outright', label: 'Own outright (no mortgage)' },
      { value: 'rent', label: 'Rent' },
      { value: 'live_with_family', label: 'Live with family / no housing cost' },
      { value: 'other', label: 'Other' },
    ] },
    { key: 'annual_rent', type: 'money', label: 'Annual rent (if renting)', help: 'Total annual rent. Leave blank if you own.', width: 'half' },
    { key: 'monthly_mortgage_payment', type: 'money', label: 'Monthly mortgage payment (PITI)', help: 'Principal + interest + tax + insurance bundled together.', width: 'half' },
    { key: 'annual_mortgage_interest', type: 'money', label: 'Annual mortgage interest paid', help: 'From your year-end mortgage statement / 1098.', width: 'half' },
    { key: 'annual_property_tax', type: 'money', label: 'Annual property tax', help: 'From your county tax bill. Annual amount.', width: 'half' },
    { key: 'property_tax_in_mortgage', type: 'yes_no', label: 'Is property tax included in your mortgage payment?', help: 'Many escrow accounts pay it for you.' },
    { key: 'homeowner_insurance_in_mortgage', type: 'yes_no', label: 'Is homeowner\'s insurance included in your mortgage?', help: 'Same question, different bill — escrow may handle it.' },
    { key: 'mortgage_balance', type: 'money', label: 'Remaining mortgage balance (principal)', help: 'Unpaid principal as of your most recent statement.', width: 'half' },
    { key: 'home_market_value', type: 'money', label: 'Est. current market value of your home', help: 'Zillow / Redfin estimate within 10% is fine.', width: 'half' },
    { key: 'has_refinanced', type: 'yes_no', label: 'Have you refinanced in the last 5 years?' },
    { key: 'refinance_detail', type: 'long_text', label: 'Refinance detail', help: 'Year + amount refinanced + reason. Only if you answered yes above.' },
    {
      key: 'other_properties',
      type: 'group',
      label: 'Other properties you own',
      help: 'Rental properties, vacation homes, undeveloped land. Skip if none.',
      groupSingularLabel: 'Property',
      groupMinCount: 0,
      groupMaxCount: 5,
      groupFields: PROPERTY_FIELDS,
    },
  ],
  optionalExplanationKey: 'real_estate_notes',
};

// ── 6. Vehicles ─────────────────────────────────────────────────────
const STEP_VEHICLES: WizardSection = {
  key: 'vehicles',
  step: 6,
  title: 'Your vehicles',
  why: 'Vehicles are a meaningful asset + monthly cost for most families. We don\'t weight them heavily, but we do want a full picture.',
  intro: 'Add one card per vehicle. KBB values are fine — we\'re not auditing.',
  fields: [
    {
      key: 'vehicles',
      type: 'group',
      label: 'Vehicles your household owns or leases',
      groupSingularLabel: 'Vehicle',
      groupMinCount: 0,
      groupMaxCount: 6,
      groupFields: VEHICLE_FIELDS,
    },
  ],
  optionalExplanationKey: 'vehicles_notes',
};

// ── 7. Assets ───────────────────────────────────────────────────────
const STEP_ASSETS: WizardSection = {
  key: 'assets',
  step: 7,
  title: 'Savings + investments',
  why: 'We look at savings as a buffer that could help cover tuition. We don\'t penalize you for having an emergency fund — but we do want the full picture.',
  intro: 'Use your most recent month-end statements. Combine across all banks / brokers.',
  fields: [
    { key: 'checking_total', type: 'money', label: 'Checking accounts (total)', help: 'Add up balances across all checking accounts.', width: 'half' },
    { key: 'savings_total', type: 'money', label: 'Savings accounts (total)', help: 'Add up balances across all savings accounts.', width: 'half' },
    { key: 'cd_total', type: 'money', label: 'Certificates of deposit (CDs)', help: 'Combined value of all CDs. Call your bank if you need current values.', width: 'half' },
    { key: 'money_market_total', type: 'money', label: 'Money market accounts', width: 'half' },
    { key: 'stocks_bonds_securities', type: 'money', label: 'Stocks, bonds, securities (non-retirement)', help: 'Brokerage accounts not earmarked for retirement.', width: 'half' },
    { key: 'retirement_total', type: 'money', label: 'Retirement accounts (401k, IRA, Roth, pension)', help: 'We DO see retirement savings, but they\'re weighted lightly. Please don\'t leave blank.', width: 'half' },
    { key: 'business_assets', type: 'money', label: 'Business assets (if self-employed)', help: 'Net of business debt. From your most recent balance sheet.', width: 'half' },
    { key: 'trust_assets', type: 'money', label: 'Trust + UTMA / UGMA accounts', help: 'Money held in trust for you or your children. Include any UTMA / UGMA accounts.', width: 'half' },
    { key: 'other_tangible_assets', type: 'money', label: 'Other valuable assets (> $1K)', help: 'Art, antiques, jewelry, collectibles, boats. Approximate value.' },
    { key: 'student_529_total', type: 'money', label: '529 college savings (across all applying students)', help: 'Total in all 529s for the children attending this school.', width: 'half' },
    { key: 'children_social_security', type: 'money', label: 'Social Security income received for any child (annual)', help: 'Survivor benefits, disability — annual amount.', width: 'half' },
  ],
  optionalExplanationKey: 'assets_notes',
};

// ── 8. Liabilities ──────────────────────────────────────────────────
const STEP_LIABILITIES: WizardSection = {
  key: 'liabilities',
  step: 8,
  title: 'Debts you owe',
  why: 'Debt payments compete directly with what you have available for tuition. We factor them in.',
  intro: 'Don\'t include your mortgage or car loans here — we captured those above.',
  fields: [
    { key: 'credit_card_balance', type: 'money', label: 'Credit cards (total balance owed)', help: 'Across all cards, both bank-issued and store cards.', width: 'half' },
    { key: 'personal_loans', type: 'money', label: 'Personal loans (secured + unsecured)', help: 'Bank loans, family loans, signature loans. Current balance owed.', width: 'half' },
    { key: 'student_loans_adults', type: 'money', label: 'Student loans (for the adults)', help: 'Your own — not the children\'s.', width: 'half' },
    { key: 'equity_loans', type: 'money', label: 'Home equity loans / HELOC (balance)', help: 'Above-and-beyond your primary mortgage.', width: 'half' },
    { key: 'annual_equity_interest', type: 'money', label: 'Annual equity loan interest paid', help: 'Total interest you paid on equity loans last year.', width: 'half' },
    { key: 'medical_debt', type: 'money', label: 'Outstanding medical debt', help: 'Hospital bills, collections, anything still owed for past care.', width: 'half' },
    { key: 'other_liabilities', type: 'money', label: 'Other liabilities', help: 'Court judgments, delinquent taxes, anything not covered above.' },
  ],
  optionalExplanationKey: 'liabilities_notes',
};

// ── 9. Expenses ─────────────────────────────────────────────────────
const STEP_EXPENSES: WizardSection = {
  key: 'expenses',
  step: 9,
  title: 'Monthly + annual expenses',
  why: 'Beyond housing and debt, this is everything else that has to come out of your income before tuition. The more accurate, the more the committee can do.',
  intro: 'All figures here are ANNUAL unless noted. Add up monthly bills × 12.',
  fields: [
    { key: 'annual_homeowner_insurance', type: 'money', label: 'Homeowner\'s insurance (annual)', help: 'Skip if it\'s included in your mortgage payment (entered above).', width: 'half' },
    { key: 'annual_renters_insurance', type: 'money', label: 'Renter\'s insurance (annual)', help: 'If renting.', width: 'half' },
    { key: 'annual_life_insurance', type: 'money', label: 'Life insurance premiums (annual)', help: 'Combined across all policies.', width: 'half' },
    { key: 'annual_auto_insurance', type: 'money', label: 'Auto insurance premiums (annual)', width: 'half' },
    { key: 'annual_health_insurance', type: 'money', label: 'Health insurance premiums (annual)', help: 'Your out-of-pocket only — not your employer\'s share.', width: 'half' },
    { key: 'annual_medical_oop', type: 'money', label: 'Out-of-pocket medical (annual)', help: 'Co-pays, prescriptions, glasses, therapy, dental. NOT premiums.', width: 'half' },
    { key: 'annual_electricity', type: 'money', label: 'Electricity (annual)', help: 'Add monthly bills × 12.', width: 'half' },
    { key: 'annual_heating_gas', type: 'money', label: 'Heating / gas (annual)', help: 'Skip if it\'s already in your electric bill.', width: 'half' },
    { key: 'annual_utilities_phone_internet', type: 'money', label: 'Other utilities + phone + internet (annual)', help: 'Water, garbage, sewer, cell, landline, ISP — combined annual.' },
    { key: 'annual_federal_taxes_paid', type: 'money', label: 'Federal taxes paid last year', help: 'From line 24 of your 1040. Not zero unless you genuinely owed no federal tax.', width: 'half' },
    { key: 'annual_state_local_taxes_paid', type: 'money', label: 'State + local taxes paid (annual)', help: 'Combined state, county, city taxes.', width: 'half' },
    { key: 'annual_child_support_paid', type: 'money', label: 'Child support paid (annual)', width: 'half' },
    { key: 'annual_alimony_paid', type: 'money', label: 'Alimony paid (annual)', width: 'half' },
    { key: 'annual_childcare_other', type: 'money', label: 'Childcare for non-applying kids (annual)', help: 'Daycare, after-school, camps for siblings not attending this school.', width: 'half' },
    { key: 'annual_dependent_support', type: 'money', label: 'Annual support of adult dependents', help: 'What you spend supporting any adult dependents in your home.', width: 'half' },
    { key: 'annual_charity', type: 'money', label: 'Charity / tithing (annual)', help: 'Documented donations to recognized charities.', width: 'half' },
    { key: 'annual_other_loan_payments', type: 'money', label: 'Other loan payments (annual)', help: 'Credit-card minimums + personal-loan payments. Not mortgage or auto (already captured).', width: 'half' },
    { key: 'annual_other_expenses', type: 'money', label: 'Other annual expenses', help: 'HOA, club memberships, condo dues. Not food, clothing, or transportation.' },
  ],
  optionalExplanationKey: 'expenses_notes',
};

// ── 10. Documents + final review ────────────────────────────────────
const STEP_FINAL: WizardSection = {
  key: 'final',
  step: 10,
  title: 'Documents + final notes',
  why: 'A few last items — anything we should know that didn\'t fit, and the supporting documents the school requires.',
  fields: [
    { key: 'special_circumstances', type: 'long_text', label: 'Special circumstances', help: 'Anything not captured above that affects your ability to pay full tuition. Job loss, medical event, family change, etc.' },
    { key: 'parent_notes_final', type: 'long_text', label: 'Anything else?', help: 'Last thoughts you want the committee to see.' },
  ],
};

export const WIZARD_SECTIONS: WizardSection[] = [
  STEP_FAMILY,
  STEP_STUDENTS,
  STEP_DEPENDENTS,
  STEP_INCOME,
  STEP_REAL_ESTATE,
  STEP_VEHICLES,
  STEP_ASSETS,
  STEP_LIABILITIES,
  STEP_EXPENSES,
  STEP_FINAL,
];

export const TOTAL_STEPS = WIZARD_SECTIONS.length;

export function getSection(step: number): WizardSection | undefined {
  return WIZARD_SECTIONS.find((s) => s.step === step);
}
