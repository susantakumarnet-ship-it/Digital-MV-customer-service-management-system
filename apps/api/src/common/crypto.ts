import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify, type Algorithm } from '@node-rs/argon2';
import { env } from '../config/env';

// OWASP-recommended Argon2id baseline (m=19 MiB, t=2, p=1).
// `Algorithm` is an ambient const enum (unusable under isolatedModules); Argon2id === 2.
const ARGON2ID = 2 as unknown as Algorithm;
const ARGON_OPTS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string) {
  return argonHash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string | undefined | null, plain: string) {
  if (!hash) {
    // Equalise timing for unknown users / users without a password.
    await argonHash(plain, ARGON_OPTS);
    return false;
  }
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM encryption for secrets at rest (MFA seeds). Output: iv.tag.ciphertext (base64url). */
export function encryptSecret(plain: string) {
  const key = Buffer.from(env().MFA_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(payload: string) {
  const key = Buffer.from(env().MFA_ENCRYPTION_KEY, 'base64');
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
