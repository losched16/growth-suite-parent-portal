// PIN auth helpers for the kiosk pickup flow.
//
// 6-digit numeric PIN, stored as `salt:scrypt-hex`. We use scrypt so a
// database leak doesn't immediately expose every PIN (and so timing
// attacks on `===` comparisons don't work). The 1M-entry PIN keyspace
// also means we rely on per-IP rate limiting (enforced at the kiosk
// route) to prevent brute-forcing — the hash alone wouldn't be enough.
//
// Generate: random 6-digit numeric (zero-padded). Shown to the parent
// once; never retrievable. The hash is what we store.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;
const PIN_LENGTH = 6;

export function generatePin(): string {
  // Reject leading-zero PINs? No — they're fine. 6-digit zero-padded.
  // Use crypto.randomInt for unbiased range.
  const n = crypto.randomInt(0, 10 ** PIN_LENGTH);
  return String(n).padStart(PIN_LENGTH, '0');
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(pin, salt, SCRYPT_KEYLEN);
  return `${salt}:${buf.toString('hex')}`;
}

export async function verifyPin(submitted: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const buf = await scrypt(submitted, salt, SCRYPT_KEYLEN);
  const a = Buffer.from(buf);
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Deterministic lookup digest — HMAC-SHA256(secret, school_id:pin).
// scrypt hashes can't be looked up (per-row salt), so finding "whose
// PIN is this?" would cost one scrypt per candidate. The HMAC gives an
// O(1) indexed lookup; the row's scrypt hash is still verified after.
// Also powers the school-wide uniqueness check at set time — two
// people sharing a PIN would make kiosk attribution ambiguous.
export function pinLookup(schoolId: string, pin: string): string {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) throw new Error('PARENT_SESSION_SECRET env var is required');
  return crypto
    .createHmac('sha256', Buffer.from(raw, 'base64'))
    .update(`${schoolId}:${pin}`)
    .digest('hex');
}

// Self-chosen PINs (parents pick their own at Settings → Pickup
// People). 4-8 digits; reject the laughably guessable ones.
const BANNED_PINS = new Set(['0000', '1234', '1111', '2222', '4321', '0123', '00000', '12345', '123456', '000000', '111111']);
export function validateChosenPin(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return 'PIN must be 4-8 digits.';
  if (BANNED_PINS.has(pin)) return 'That PIN is too easy to guess — pick something less common.';
  if (/^(\d)\1+$/.test(pin)) return 'All-same-digit PINs are not allowed.';
  return null;
}
