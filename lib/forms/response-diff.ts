// Compute a field-by-field diff between two `responses` jsonb blobs from
// portal_form_submissions. Used by the periodic-review flow on long-lived
// forms (Emergency Contact, DHS Agreement) so the office gets notified
// about exactly which fields changed when a parent re-submits after the
// 6-month re-review prompt.
//
// Returns `null` if no prior submission was provided (i.e. this is the
// first submission for the family/student). Otherwise returns a sparse
// object keyed by changed field name. Keys starting with `_` or `__` are
// always skipped — they're internal markers (review mode, signed-at
// timestamps, etc.), not parent-visible content.

export interface FieldChange {
  old: unknown;
  new: unknown;
}

export type ResponseDiff = Record<string, FieldChange>;

const INTERNAL_KEY_PREFIXES = ['_', '__'];

function isInternalKey(k: string): boolean {
  return INTERNAL_KEY_PREFIXES.some((p) => k.startsWith(p));
}

// Stable JSON for deep equality — handles arrays, plain objects, primitives.
// Sorts object keys so { a:1, b:2 } === { b:2, a:1 } in our world.
function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// Normalize empty-ish values so " " vs "" vs null don't read as changes.
function isEmptyish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function normalize(v: unknown): unknown {
  if (isEmptyish(v)) return null;
  if (typeof v === 'string') return v.trim();
  return v;
}

export function diffResponses(
  prior: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): ResponseDiff | null {
  if (!prior) return null;
  const out: ResponseDiff = {};
  const allKeys = new Set([...Object.keys(prior), ...Object.keys(next)]);
  for (const k of allKeys) {
    if (isInternalKey(k)) continue;
    const oldV = normalize(prior[k]);
    const newV = normalize(next[k]);
    if (stable(oldV) !== stable(newV)) {
      out[k] = { old: oldV, new: newV };
    }
  }
  return out;
}

// Cap diff size when persisting / emailing — protects against pathologic
// edge cases where every field appears "changed" (e.g. schema migration).
// 50 changed fields is more than any of our forms have today.
export function capDiff(d: ResponseDiff, maxEntries = 50): ResponseDiff {
  const entries = Object.entries(d);
  if (entries.length <= maxEntries) return d;
  return Object.fromEntries(entries.slice(0, maxEntries));
}
