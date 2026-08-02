// Reversible PIN storage (AES-256-GCM under the platform ENCRYPTION_KEY).
//
// The scrypt hash (pickup-pin.ts) stays the verification path; this
// encrypted copy exists so the PIN can be DISPLAYED back — to office
// staff on the roster, and to the parent themselves in the portal.
// Kiosk PINs are low-sensitivity convenience codes; showing them to
// their owner and to trusted staff beats "forgot my PIN" round-trips.

import crypto from 'node:crypto';

function key(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}

export function encryptPin(pin: string): { ct: Buffer; iv: Buffer; tag: Buffer } | null {
  const k = key();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag() };
}

export function decryptPin(ct: Buffer | null, iv: Buffer | null, tag: Buffer | null): string | null {
  const k = key();
  if (!k || !ct || !iv || !tag) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
