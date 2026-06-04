// Pure-data document catalog. Lives in its own module (no DB imports)
// so client components can import it directly. The server-side
// settings loader (lib/financial-aid/settings.ts) imports the same
// catalog and exports it through itself for back-compat.

export const FA_DOCUMENT_CATALOG_MAP: Record<string, { label: string; hint: string }> = {
  tax_return:        { label: 'Federal tax return (1040)', hint: 'Most recent year. All pages, including schedules.' },
  w2:                { label: 'W-2 form(s)',                hint: 'All employers for the most recent tax year.' },
  pay_stubs:         { label: 'Recent pay stubs',           hint: 'Last 2 months from every working adult in the household.' },
  ssa_statement:     { label: 'Social Security statement',  hint: 'If anyone in the household receives SSA / SSI / disability.' },
  unemployment:      { label: 'Unemployment benefit letter',hint: 'If anyone is on unemployment in the application year.' },
  self_employed:     { label: 'Schedule C / business returns', hint: 'For self-employed parents — most recent year.' },
  bank_statement:    { label: 'Bank statement',             hint: 'Last 2 months from all checking + savings accounts.' },
  investment_summary:{ label: 'Investment / 401(k) summary',hint: 'Most recent statements for any non-retirement investments.' },
  mortgage_statement:{ label: 'Mortgage statement',         hint: 'Most recent statement showing balance + payment.' },
  rent_lease:        { label: 'Lease / rent receipts',      hint: 'If renting — current lease or recent payment proof.' },
  medical_expenses:  { label: 'Documented medical expenses',hint: 'For families claiming significant out-of-pocket medical bills.' },
  child_support:     { label: 'Child support order',        hint: 'Custody / support paperwork showing payments paid or received.' },
  other:             { label: 'Other supporting documents', hint: "Anything else you'd like the FA committee to see." },
};
