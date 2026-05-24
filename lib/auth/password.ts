// Parent password hashing — scrypt with per-row salt.
//
// Stored as `salt:hex`. Verify by re-running scrypt with the stored
// salt and timing-safe comparing the result.
//
// We don't enforce a complexity policy server-side — parents pick their
// own and we trust them. (Length >= 8 enforced in the form UI.)

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 32;
const MIN_LENGTH = 8;

export const MIN_PASSWORD_LENGTH = MIN_LENGTH;

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(plain, salt, KEY_LEN);
  return `${salt}:${buf.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const buf = await scrypt(plain, salt, KEY_LEN);
  const a = Buffer.from(buf);
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
