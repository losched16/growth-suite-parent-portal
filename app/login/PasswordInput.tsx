'use client';

// Password input with a show/hide eye toggle. Used on sign-in, first-time
// password creation, and the reset-password page — parents (especially on
// phones) need to see what they typed before committing to it.

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function PasswordInput({
  id, name, required = true, minLength, autoComplete, placeholder, autoFocus,
}: {
  id: string;
  name: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-10 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-700"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
