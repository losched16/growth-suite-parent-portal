'use client';

// Masked PIN with a Show/Hide toggle. Starts hidden so a shoulder-surfer
// at school pickup doesn't read it off the parent's screen.

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function PinReveal({ pin }: { pin: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="rounded bg-white px-2 py-0.5 font-mono text-base font-bold tracking-widest text-slate-900 border border-slate-200">
        {shown ? pin : '•'.repeat(pin.length)}
      </code>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
      >
        {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
