// 7-step FA wizard schema. Single source of truth for what fields
// each step renders + how they save into fa_applications.responses.
//
// Design notes:
//   - Each field has plain-language `label` + a `help` line explaining
//     where to find the number. Always visible (NOT in a popup) so
//     parents don't have to discover them.
//   - Every numeric field defaults to "leave blank" — admin can chase
//     a blank during review; a forced 0 is misinformation.
//   - "Optional explanation" textareas at the end of every section
//     let parents add context FAST forces into a structured field.
//
// Why hard-coded vs DB-config: schools rarely want to customize the
// actual question set; they care about who can apply / when / what
// docs (those live in school_financial_aid_settings). Hardcoding the
// schema keeps the parent-side reusable across every school.

export type WizardFieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'money'
  | 'yes_no'
  | 'select'
  | 'date'
  | 'group';   // a repeatable group (e.g. each vehicle, each property)

export interface WizardField {
  key: string;
  type: WizardFieldType;
  label: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;   // for 'select'
  groupFields?: WizardField[];                          // for 'group'
  groupSingularLabel?: string;                          // 'vehicle', 'property'
  width?: 'full' | 'half';                              // visual hint
}

export interface WizardSection {
  key: string;
  step: number;
  title: string;
  why: string;                          // "Why we ask"
  intro?: string;                       // extra context above the fields
  fields: WizardField[];
  optionalExplanationKey?: string;      // key for the trailing optional textarea
}

// ── 1. Household ─────────────────────────────────────────────────────
const STEP_HOUSEHOLD: WizardSection = {
  key: 'household',
  step: 1,
  title: 'Your family',
  why: 'We build the rest of the application around who lives in your home. Different household sizes have very different financial pictures, and we want to be fair.',
  fields: [
    { key: 'household_size', type: 'number', label: 'How many people live in your home?', help: 'Count everyone — adults, students applying, other kids, adult dependents.', required: true, placeholder: 'e.g. 4', width: 'half' },
    { key: 'marital_status', type: 'select', label: 'Marital status of the applying parent(s)', help: 'Single-parent and divorced families: pick what matches your tax filing.', required: true, width: 'half', options: [
      { value: 'married_joint', label: 'Married, filing jointly' },
      { value: 'married_separate', label: 'Married, filing separately' },
      { value: 'single', label: 'Single' },
      { value: 'divorced', label: 'Divorced' },
      { value: 'widowed', label: 'Widowed' },
      { value: 'separated', label: 'Separated' },
      { value: 'partnered', label: 'Domestic partnership / unmarried partnership' },
    ] },
    { key: 'other_dependents_count', type: 'number', label: 'Other dependents in your household (not applying to this school)', help: 'Other children, adult dependents, parents you support. Leave blank if none.', placeholder: 'e.g. 2', width: 'half' },
    { key: 'recent_change', type: 'yes_no', label: 'Did your family situation change in the past 12 months?', help: 'New baby, divorce, death, job loss, medical event — anything we should know about.' },
    { key: 'recent_change_detail', type: 'long_text', label: 'Tell us about the change', help: 'Only if you answered yes above. Anything that affects your financial picture.', placeholder: 'e.g. My spouse passed away in March. The household income dropped significantly.' },
  ],
  optionalExplanationKey: 'household_notes',
};

// ── 2. Students applying — handled by existing per-student rows. ────
// We still surface a placeholder step that points the parent at the
// student section (it's rendered specially in the wizard host).
const STEP_STUDENTS: WizardSection = {
  key: 'students',
  step: 2,
  title: 'Students applying',
  why: 'We need to know which of your kids are attending this school and what tuition you\'re facing. Aid is awarded per student, but we look at your household as a whole.',
  fields: [],   // rendered specially — uses fa_application_students rows
};

// ── 3. Income ────────────────────────────────────────────────────────
const STEP_INCOME: WizardSection = {
  key: 'income',
  step: 3,
  title: 'Household income',
  why: 'Income is the strongest predictor of how much tuition a family can carry. Pull last year\'s 1040 or W-2s for accurate numbers.',
  intro: 'Most parents grab their last filed tax return for this section. If you haven\'t filed yet, your last full-year statements are fine — just check "I haven\'t filed yet" at the bottom.',
  fields: [
    { key: 'w2_adult_1', type: 'money', label: 'Adult 1 — gross wages (W-2 Box 1)', help: 'From Box 1 of your W-2. If you had multiple jobs, total them.', width: 'half' },
    { key: 'w2_adult_2', type: 'money', label: 'Adult 2 — gross wages (W-2 Box 1)', help: 'Leave blank if single-parent or other adult had no W-2 income.', width: 'half' },
    { key: 'self_employed_income', type: 'money', label: 'Self-employment / business income (1040 Schedule C)', help: 'Net profit after business expenses. Negative numbers are not allowed here — explain losses in the box below.' },
    { key: 'dividend_interest_income', type: 'money', label: 'Dividends + interest income (1099-DIV, 1099-INT)', help: 'Total from any savings, money market, brokerage interest.', width: 'half' },
    { key: 'capital_gains', type: 'money', label: 'Capital gains (Schedule D)', help: 'Stock or real-estate sale gains for the year.', width: 'half' },
    { key: 'rental_income', type: 'money', label: 'Rental / real estate income', help: 'After expenses, before depreciation.', width: 'half' },
    { key: 'support_received', type: 'money', label: 'Child support + alimony received', help: 'Combined, annual.', width: 'half' },
    { key: 'other_income', type: 'money', label: 'Other income (gifts, settlements, retirement income, etc.)', help: 'Anything not covered above. Be conservative — committee may ask.' },
    { key: 'has_filed_taxes', type: 'yes_no', label: 'Have you filed last year\'s tax return yet?', help: 'If no, we\'ll ask for an estimate and a copy when it\'s ready.', required: true },
  ],
  optionalExplanationKey: 'income_notes',
};

// ── 4. Real estate ───────────────────────────────────────────────────
const STEP_REAL_ESTATE: WizardSection = {
  key: 'real_estate',
  step: 4,
  title: 'Your housing',
  why: 'Whether you own or rent — and your housing burden — is one of the biggest costs in most family budgets. We use this to understand discretionary capacity.',
  fields: [
    { key: 'housing_type', type: 'select', label: 'Do you own or rent?', required: true, options: [
      { value: 'own_primary', label: 'Own (primary residence)' },
      { value: 'own_with_mortgage', label: 'Own with mortgage' },
      { value: 'rent', label: 'Rent' },
      { value: 'live_with_family', label: 'Live with family / no housing cost' },
      { value: 'other', label: 'Other' },
    ] },
    { key: 'monthly_housing_cost', type: 'money', label: 'Total monthly housing cost', help: 'Mortgage + property tax + insurance if you own, OR rent + renter\'s insurance if you rent.', width: 'half' },
    { key: 'mortgage_balance', type: 'money', label: 'Remaining mortgage balance (if applicable)', help: 'Unpaid principal as of your most recent statement.', width: 'half' },
    { key: 'home_market_value', type: 'money', label: 'Est. current market value of your home (if you own)', help: 'Zillow / Redfin estimate is fine — within 10% is great.', width: 'half' },
    { key: 'has_other_real_estate', type: 'yes_no', label: 'Do you own other real estate?', help: 'Rental property, vacation home, undeveloped land.', width: 'half' },
    { key: 'other_real_estate_value', type: 'money', label: 'Approx. value of other real estate', help: 'Only if you answered yes above. Total estimated market value minus any mortgage owed.' },
  ],
  optionalExplanationKey: 'real_estate_notes',
};

// ── 5. Vehicles + other assets ──────────────────────────────────────
const STEP_ASSETS: WizardSection = {
  key: 'assets',
  step: 5,
  title: 'Savings + assets',
  why: 'We look at savings as a buffer that could help cover tuition. We don\'t penalize you for having an emergency fund — we just want the full picture.',
  fields: [
    { key: 'checking_savings', type: 'money', label: 'Checking + savings (across all accounts)', help: 'Use your most recent month-end statements. Combine all banks.', width: 'half' },
    { key: 'investments', type: 'money', label: 'Investments (stocks, bonds, brokerage)', help: 'Non-retirement accounts. Most recent statement value.', width: 'half' },
    { key: 'retirement', type: 'money', label: 'Retirement accounts (401k, IRA, Roth, pension)', help: 'We DO look at retirement savings, but they\'re weighted very lightly. Don\'t leave blank.', width: 'half' },
    { key: 'cd_money_market', type: 'money', label: 'CDs + money market', help: 'If different from your savings above.', width: 'half' },
    { key: 'business_equity', type: 'money', label: 'Business equity (if self-employed)', help: 'Approx. value of any business you own, net of business debt.', width: 'half' },
    { key: 'vehicles_count', type: 'number', label: 'How many vehicles does your household own or lease?', help: 'We don\'t need make/model — just the count + total monthly payments.', width: 'half' },
    { key: 'vehicles_monthly_payment', type: 'money', label: 'Total monthly vehicle payments', help: 'Combined across all car loans + leases. Leave blank if none.' },
    { key: 'other_assets', type: 'money', label: 'Other significant assets', help: 'Anything worth >$5K not covered above — jewelry, collectibles, boats.' },
  ],
  optionalExplanationKey: 'assets_notes',
};

// ── 6. Debts + expenses ──────────────────────────────────────────────
const STEP_DEBTS: WizardSection = {
  key: 'debts_expenses',
  step: 6,
  title: 'Debts + monthly expenses',
  why: 'We want to see what\'s already committed each month before tuition. High debt service or medical costs are real and we factor them in.',
  fields: [
    { key: 'credit_card_balance', type: 'money', label: 'Total credit card balance', help: 'Combined across all cards.', width: 'half' },
    { key: 'student_loan_balance', type: 'money', label: 'Student loan balance (for the adults)', help: 'Yours — not the children\'s.', width: 'half' },
    { key: 'monthly_debt_service', type: 'money', label: 'Total monthly debt payments', help: 'Credit cards + student loans + other loans (not mortgage or vehicles — those were above).' },
    { key: 'monthly_health_insurance', type: 'money', label: 'Monthly health insurance premium', help: 'Out-of-pocket only — not your employer\'s share.', width: 'half' },
    { key: 'annual_medical_oop', type: 'money', label: 'Annual out-of-pocket medical', help: 'Co-pays, prescriptions, glasses, therapy, etc. Not insurance premiums.', width: 'half' },
    { key: 'annual_childcare', type: 'money', label: 'Annual childcare cost', help: 'Daycare, after-school care, summer camps for non-applying children.' },
    { key: 'support_paid', type: 'money', label: 'Child support + alimony paid', help: 'Annual total.', width: 'half' },
    { key: 'charitable_giving', type: 'money', label: 'Annual charitable giving', help: 'Tithing or charitable donations. Optional but factored in.', width: 'half' },
  ],
  optionalExplanationKey: 'debts_notes',
};

// ── 7. Documents + final review ─────────────────────────────────────
const STEP_FINAL: WizardSection = {
  key: 'final',
  step: 7,
  title: 'Documents + final notes',
  why: 'A few last items — anything we should know that didn\'t fit in the form, and the supporting documents the school requires.',
  fields: [
    { key: 'special_circumstances', type: 'long_text', label: 'Special circumstances', help: 'Anything not captured above that affects your ability to pay full tuition. Job loss, medical event, family change, etc.' },
    { key: 'parent_notes_final', type: 'long_text', label: 'Anything else?', help: 'Last thoughts you want the committee to see.' },
  ],
};

export const WIZARD_SECTIONS: WizardSection[] = [
  STEP_HOUSEHOLD,
  STEP_STUDENTS,
  STEP_INCOME,
  STEP_REAL_ESTATE,
  STEP_ASSETS,
  STEP_DEBTS,
  STEP_FINAL,
];

export const TOTAL_STEPS = WIZARD_SECTIONS.length;

export function getSection(step: number): WizardSection | undefined {
  return WIZARD_SECTIONS.find((s) => s.step === step);
}
