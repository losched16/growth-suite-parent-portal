'use client';

// Tiny client component — server pages can't bind window.print(), so
// the print trigger needs to be its own client island.

import { Printer } from 'lucide-react';

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
    >
      <Printer className="h-3.5 w-3.5" /> Print / save as PDF
    </button>
  );
}
