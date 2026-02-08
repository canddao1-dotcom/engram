#!/usr/bin/env node
/**
 * Engram Encryption Tests
 */

import { generateKey, deriveKey, encrypt, decrypt } from '../scripts/encryption.js';
import { AgentMemory } from '../src/agent.js';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function section(name) { console.log(`\n${name}`); }

// ─── Encryption Module Tests ─────────────────────────────────────

section('Encryption: Key Generation');
{
  const key = generateKey();
  assert(typeof key === 'string', 'generateKey returns string');
  assert(key.length === 64, `key is 64 hex chars (got ${key.length})`);
  assert(/^[0-9a-f]+$/.test(key), 'key is valid hex');

  const key2 = generateKey();
  assert(key !== key2, 'two keys are different');
}

section('Encryption: Key Derivation');
{
  const { key, salt } = deriveKey('my-password');
  assert(key.length === 64, 'derived key is 64 hex chars');
  assert(salt.length === 32, 'salt is 32 hex chars');

  // Same password + salt = same key
  const { key: key2 } = deriveKey('my-password', salt);
  assert(key === key2, 'same password+salt produces same key');

  // Different password = different key
  const { key: key3 } = deriveKey('other-password', salt);
  assert(key !== key3, 'different password produces different key');
}

section('Encryption: Encrypt/Decrypt Round-trip');
{
  const key = generateKey();
  const plaintext = 'Hello, this is a secret memory about trading FXRP!';

  const encrypted = encrypt(plaintext, key);
  assert(typeof encrypted.nonce === 'string', 'encrypt returns nonce');
  assert(typeof encrypted.ciphertext === 'string', 'encrypt returns ciphertext');
  assert(typeof encrypted.tag === 'string', 'encrypt returns tag');
  assert(encrypted.nonce.length === 24, 'nonce is 12 bytes (24 hex)');
  assert(encrypted.tag.length === 32, 'tag is 16 bytes (32 hex)');
  assert(!encrypted.ciphertext.includes(Buffer.from(plaintext).toString('hex')),
    'ciphertext does not contain plaintext hex');

  const decrypted = decrypt(encrypted, key);
  assert(decrypted === plaintext, 'decrypt recovers plaintext');
}

section('Encryption: Wrong Key Fails');
{
  const key1 = generateKey();
  const key2 = generateKey();
  const encrypted = encrypt('secret data', key1);

  let errored = false;
  try {
    decrypt(encrypted, key2);
  } catch (e) {
    errored = true;
  }
  assert(errored, 'decrypting with wrong key throws error');
}

section('Encryption: Empty and Unicode');
{
  const key = generateKey();

  const enc1 = encrypt('', key);
  assert(decrypt(enc1, key) === '', 'empty string round-trips');

  const unicode = '🔒 Encrypted: привет мир 日本語';
  const enc2 = encrypt(unicode, key);
  assert(decrypt(enc2, key) === unicode, 'unicode round-trips');

  const long = 'x'.repeat(100000);
  const enc3 = encrypt(long, key);
  assert(decrypt(enc3, key) === long, 'large text round-trips');
}

// ─── AgentMemory Integration Tests ───────────────────────────────

const TEST_DIR = '/tmp/engram-encryption-test-' + Date.now();

section('Integration: Encrypted Remember/Recall');
{
  const key = generateKey();
  const mem = new AgentMemory({
    agentId: 'test-enc',
    basePath: TEST_DIR + '/basic',
    encryption: { enabled: true, key },
  });

  const eps = await mem.remember('This is a secret trading strategy for FXRP', {
    type: 'lesson',
    tags: ['trading', 'fxrp'],
    importance: 0.8,
  });

  assert(eps.length === 1, 'stored 1 episode');
  assert(eps[0].text === 'This is a secret trading strategy for FXRP', 'returned plaintext');

  // Check disk is encrypted
  const diskData = JSON.parse(await readFile(
    join(TEST_DIR, 'basic', 'episodes', eps[0].id + '.json'), 'utf-8'
  ));
  assert(diskData._encrypted === true, 'episode marked as encrypted on disk');
  assert(!diskData.text.includes('secret trading'), 'disk text does not contain plaintext');

  // Recall works
  const results = await mem.recall('FXRP strategy', { limit: 5 });
  assert(results.length >= 1, 'recall returns results');
  assert(results[0].text.includes('secret trading strategy'), 'recalled text is decrypted');
}

section('Integration: Search Works on Encrypted Store');
{
  const key = generateKey();
  const mem = new AgentMemory({
    agentId: 'test-search',
    basePath: TEST_DIR + '/search',
    encryption: { enabled: true, key },
  });

  await mem.remember('The quick brown fox jumped over the lazy dog', { tags: ['animal'] });
  await mem.remember('Bitcoin price reached 100k today', { tags: ['crypto'] });
  await mem.remember('The fox was very clever and fast', { tags: ['animal'] });

  const results = await mem.recall('fox', { limit: 5 });
  assert(results.length >= 2, `search "fox" returns ${results.length} results`);
  assert(results[0].text.includes('fox'), 'top result contains fox');
}

section('Integration: Encrypted Tags on Disk');
{
  const key = generateKey();
  const mem = new AgentMemory({
    agentId: 'test-tags',
    basePath: TEST_DIR + '/tags',
    encryption: { enabled: true, key },
  });

  const eps = await mem.remember('secret info', { tags: ['classified', 'top-secret'] });
  const diskData = JSON.parse(await readFile(
    join(TEST_DIR, 'tags', 'episodes', eps[0].id + '.json'), 'utf-8'
  ));
  assert(diskData._tagsEncrypted === true, 'tags marked as encrypted');
  assert(!JSON.stringify(diskData.tags).includes('classified'), 'tags not readable on disk');
}

section('Integration: Reload from Encrypted Disk');
{
  const key = generateKey();
  const dir = TEST_DIR + '/reload';

  // Write with one instance
  const mem1 = new AgentMemory({
    agentId: 'test-reload',
    basePath: dir,
    encryption: { enabled: true, key },
  });
  await mem1.remember('persistent secret data', { tags: ['persist'] });

  // Read with a fresh instance (forces re-init from disk)
  const mem2 = new AgentMemory({
    agentId: 'test-reload',
    basePath: dir,
    encryption: { enabled: true, key },
  });
  const results = await mem2.recall('persistent secret', { limit: 5 });
  assert(results.length >= 1, 'fresh instance recalls encrypted data');
  assert(results[0].text.includes('persistent secret data'), 'decrypted correctly after reload');
}

section('Integration: Password-Based Encryption');
{
  const dir = TEST_DIR + '/password';
  const mem = new AgentMemory({
    agentId: 'test-pw',
    basePath: dir,
    encryption: { enabled: true, password: 'my-secret-password' },
  });
  await mem.remember('password protected memory', { tags: ['pw'] });
  const results = await mem.recall('password protected', { limit: 5 });
  assert(results.length >= 1, 'password-based encryption works');
  assert(results[0].text.includes('password protected memory'), 'decrypts with password');
}

section('Integration: Metadata Stays Unencrypted');
{
  const key = generateKey();
  const mem = new AgentMemory({
    agentId: 'test-meta',
    basePath: TEST_DIR + '/meta',
    encryption: { enabled: true, key },
  });
  const eps = await mem.remember('secret content', {
    type: 'lesson',
    importance: 0.9,
  });
  const diskData = JSON.parse(await readFile(
    join(TEST_DIR, 'meta', 'episodes', eps[0].id + '.json'), 'utf-8'
  ));
  assert(diskData.type === 'lesson', 'type is unencrypted on disk');
  assert(diskData.importance === 0.9, 'importance is unencrypted on disk');
  assert(typeof diskData.createdAt === 'number', 'createdAt is unencrypted');
  assert(diskData.id === eps[0].id, 'id is unencrypted');
}

section('Integration: Non-encrypted Still Works');
{
  const mem = new AgentMemory({
    agentId: 'test-plain',
    basePath: TEST_DIR + '/plain',
  });
  const eps = await mem.remember('plain text memory', { tags: ['test'] });
  const diskData = JSON.parse(await readFile(
    join(TEST_DIR, 'plain', 'episodes', eps[0].id + '.json'), 'utf-8'
  ));
  assert(diskData.text === 'plain text memory', 'plain text stored as-is');
  assert(!diskData._encrypted, 'not marked as encrypted');

  const results = await mem.recall('plain text', { limit: 5 });
  assert(results.length >= 1, 'recall works without encryption');
}

// ─── Cleanup ─────────────────────────────────────────────────────

await rm(TEST_DIR, { recursive: true, force: true });

console.log(`\n${'═'.repeat(40)}`);
console.log(`Encryption tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
