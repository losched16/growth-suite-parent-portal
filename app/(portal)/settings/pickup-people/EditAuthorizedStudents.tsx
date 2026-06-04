'use client';

// Inline "edit which kids" affordance on each pickup-person row.
// Opens a small popover with one checkbox per kid; saving PATCHes the
// pickup_person_students junction via the existing /api/attendance/
// pickup-persons endpoint.

import { useState, useRef, useEffect } from 'react';
import { Pencil, Loader2 } from 'lucide-react';

interface Kid { id: string; label: string }

export function EditAuthorizedStudents({
  pickupPersonId, kids, currentlyAuthorized,
}: {
  pickupPersonId: string;
  kids: Kid[];
  currentlyAuthorized: string[]; // empty array = all kids
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(currentlyAuthorized.length === 0 ? kids.map((k) => k.id) : currentlyAuthorized),
  );
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close popover when clicking outside.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('id', pickupPersonId);
      fd.set('_update_students', '1');
      // Empty array → "applies to all"; the API treats no checked +
      // all-checked the same way (junction cleared).
      for (const sid of picked) fd.append('authorized_student_ids', sid);
      const r = await fetch('/api/attendance/pickup-persons?_method=PATCH', {
        method: 'POST',
        body: fd,
      });
      if (r.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 rounded border border-gray-200 bg-white px-1 py-0 text-[10px] text-gray-600 hover:bg-gray-50 ml-1"
        title="Change which children this person can pick up"
      >
        <Pencil className="h-2.5 w-2.5" /> edit
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full mt-1 z-20 w-56 rounded-md border border-gray-200 bg-white shadow-lg p-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1">
            Authorized for
          </div>
          <ul className="space-y-1 mb-2">
            {kids.map((k) => (
              <li key={k.id}>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.has(k.id)}
                    onChange={() => toggle(k.id)}
                    className="h-3.5 w-3.5 rounded border-gray-300"
                  />
                  <span>{k.label}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
