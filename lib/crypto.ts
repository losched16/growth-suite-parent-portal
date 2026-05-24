import crypto from 'node:crypto';

// Same encryption pattern as importer / family graph.
// ENCRYPTION_KEY MUST be byte-identical to the importer's.

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is required');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (got ' + buf.length + ')');
  }
  return buf;
}

export function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
  if (iv.length !== IV_BYTES) throw new Error('IV must be 12 bytes');
  if (tag.length !== TAG_BYTES) throw new Error('Auth tag must be 16 bytes');
  const decipher = crypto.createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
