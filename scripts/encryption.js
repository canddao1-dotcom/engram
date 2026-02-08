/**
 * Engram Encryption — ChaCha20-Poly1305 encryption using Node.js crypto.
 * Zero external dependencies.
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';

const ALGO = 'chacha20-poly1305';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';
const SALT_BYTES = 16;

/**
 * Generate a random 256-bit key.
 * @returns {string} hex-encoded key
 */
export function generateKey() {
  return randomBytes(KEY_BYTES).toString('hex');
}

/**
 * Derive a 256-bit key from a password using PBKDF2.
 * @param {string} password
 * @param {string} salt - hex-encoded salt (generates one if not provided)
 * @returns {{ key: string, salt: string }} hex-encoded key and salt
 */
export function deriveKey(password, salt) {
  const saltBuf = salt ? Buffer.from(salt, 'hex') : randomBytes(SALT_BYTES);
  const keyBuf = pbkdf2Sync(password, saltBuf, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST);
  return { key: keyBuf.toString('hex'), salt: saltBuf.toString('hex') };
}

/**
 * Encrypt plaintext with ChaCha20-Poly1305.
 * @param {string} plaintext
 * @param {string} hexKey - 64-char hex key
 * @returns {{ nonce: string, ciphertext: string, tag: string }} all hex-encoded
 */
export function encrypt(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_BYTES) throw new Error(`Key must be ${KEY_BYTES} bytes`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext with ChaCha20-Poly1305.
 * @param {{ nonce: string, ciphertext: string, tag: string }} data - hex-encoded
 * @param {string} hexKey - 64-char hex key
 * @returns {string} plaintext
 */
export function decrypt(data, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_BYTES) throw new Error(`Key must be ${KEY_BYTES} bytes`);
  const nonce = Buffer.from(data.nonce, 'hex');
  const ciphertext = Buffer.from(data.ciphertext, 'hex');
  const tag = Buffer.from(data.tag, 'hex');
  const decipher = createDecipheriv(ALGO, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
