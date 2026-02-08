#!/usr/bin/env node
/**
 * Engram Sharing Tests — 20 tests for multi-agent memory sharing.
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { generateKeyPairSync, sign, verify, createHash, randomBytes } from 'crypto';
import {
  generateAgentIdentity,
  loadIdentity,
  loadManifest,
  saveManifest,
  exportEpisodes,
  importShare,
  grantAccess,
  revokeAccess,
  listGrants,
  isGrantValid,
} from '../scripts/sharing.js';
import { AgentMemory } from '../src/agent.js';

const TEST_DIR = join(process.cwd(), '.test-sharing-' + Date.now());
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function agentDir(name) {
  const d = join(TEST_DIR, name);
  mkdirSync(d, { recursive: true });
  return d;
}

async function makeMemory(name) {
  const dir = agentDir(name);
  const mem = new AgentMemory({ agentId: name, basePath: dir });
  await mem.init();
  return mem;
}

async function run() {
  console.log('Engram Sharing Tests\n');
  mkdirSync(TEST_DIR, { recursive: true });

  // ── 1. Identity generation ──────────────────────────────────
  console.log('Identity:');
  {
    const dir = agentDir('alice');
    const id = generateAgentIdentity(dir);
    assert(id.publicKey && id.publicKey.length > 10, 'generates identity with public key');
    assert(id.privateKey && id.privateKey.length > 10, 'generates identity with private key');
    assert(id.createdAt, 'identity has createdAt');

    // Idempotent
    const id2 = generateAgentIdentity(dir);
    assert(id2.publicKey === id.publicKey, 'identity generation is idempotent');
  }

  // ── 2. Load identity ───────────────────────────────────────
  {
    const dir = agentDir('bob');
    const none = loadIdentity(dir);
    assert(none === null, 'loadIdentity returns null when no identity');
    generateAgentIdentity(dir);
    const loaded = loadIdentity(dir);
    assert(loaded !== null && loaded.publicKey, 'loadIdentity returns identity after generation');
  }

  // ── 3. Manifest operations ─────────────────────────────────
  console.log('\nManifest:');
  {
    const dir = agentDir('manifest-test');
    const m = loadManifest(dir);
    assert(Array.isArray(m.shares) && m.shares.length === 0, 'empty manifest has no shares');
    m.agentId = 'test';
    m.shares.push({ id: 'share_1' });
    saveManifest(dir, m);
    const m2 = loadManifest(dir);
    assert(m2.shares.length === 1 && m2.shares[0].id === 'share_1', 'manifest persists correctly');
  }

  // ── 4. Export/Import round-trip ────────────────────────────
  console.log('\nExport/Import:');
  {
    const aliceMem = await makeMemory('alice-share');
    generateAgentIdentity(aliceMem._basePath);
    const eps = await aliceMem.remember('The capital of France is Paris', { type: 'fact', tags: ['geography'] });
    const eps2 = await aliceMem.remember('Water boils at 100°C', { type: 'fact', tags: ['science'] });
    const epIds = [...eps.map(e => e.id), ...eps2.map(e => e.id)];

    const pkg = await exportEpisodes(aliceMem, epIds, { dataDir: aliceMem._basePath, agentId: 'alice' });
    assert(pkg.metadata.episodeCount === epIds.length, 'export has correct episode count');
    assert(pkg.signature, 'export has signature');
    assert(pkg.metadata.encrypted === false, 'unencrypted export');

    // Import into bob
    const bobMem = await makeMemory('bob-import');
    generateAgentIdentity(bobMem._basePath);
    const result = await importShare(bobMem, pkg, { dataDir: bobMem._basePath });
    assert(result.imported === epIds.length, `imported ${result.imported} episodes`);
    assert(result.skipped === 0, 'no duplicates skipped');

    // Check imported episodes have shared tag
    const bobEps = await bobMem.getRecent(100);
    const sharedEps = bobEps.filter(e => e.tags && e.tags.includes('shared'));
    assert(sharedEps.length === epIds.length, 'imported episodes tagged as shared');
  }

  // ── 5. Signature verification (tampered) ───────────────────
  console.log('\nSignature Verification:');
  {
    const mem = await makeMemory('sig-test');
    generateAgentIdentity(mem._basePath);
    const eps = await mem.remember('Test data for signing', { type: 'fact' });
    const pkg = await exportEpisodes(mem, eps.map(e => e.id), { dataDir: mem._basePath });

    // Tamper with episode text
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.episodes[0].text = 'TAMPERED DATA';

    const bobMem = await makeMemory('sig-bob');
    generateAgentIdentity(bobMem._basePath);
    let caught = false;
    try {
      await importShare(bobMem, tampered, { dataDir: bobMem._basePath });
    } catch (e) {
      caught = e.message.includes('Invalid signature');
    }
    assert(caught, 'tampered package rejected with invalid signature');
  }

  // ── 6. Access control (grant/revoke) ───────────────────────
  console.log('\nAccess Control:');
  {
    const dir = agentDir('acl-test');
    const grant = grantAccess(dir, 'bob', { episodeIds: ['ep_1', 'ep_2'] }, 'read', '2027-01-01T00:00:00Z');
    assert(grant.id.startsWith('share_'), 'grant has ID');
    assert(grant.permissions === 'read', 'grant has correct permissions');
    assert(grant.recipientAgentId === 'bob', 'grant has correct recipient');

    const grants = listGrants(dir);
    assert(grants.length === 1, 'one active grant');

    const revoked = revokeAccess(dir, grant.id);
    assert(revoked === true, 'revoke returns true');

    const grants2 = listGrants(dir);
    assert(grants2.length === 0, 'no grants after revoke');

    const revoked2 = revokeAccess(dir, 'nonexistent');
    assert(revoked2 === false, 'revoke nonexistent returns false');
  }

  // ── 7. Expiry enforcement ──────────────────────────────────
  console.log('\nExpiry:');
  {
    const expired = { id: 'x', expiresAt: '2020-01-01T00:00:00Z' };
    const valid = { id: 'y', expiresAt: '2030-01-01T00:00:00Z' };
    const noExpiry = { id: 'z', expiresAt: null };
    assert(!isGrantValid(expired), 'expired grant is invalid');
    assert(isGrantValid(valid), 'future grant is valid');
    assert(isGrantValid(noExpiry), 'no-expiry grant is valid');
    assert(!isGrantValid(null), 'null grant is invalid');
  }

  // ── 8. Deduplication on import ─────────────────────────────
  console.log('\nDeduplication:');
  {
    const aliceMem = await makeMemory('dedup-alice');
    generateAgentIdentity(aliceMem._basePath);
    const eps = await aliceMem.remember('Unique fact about deduplication', { type: 'fact' });
    const pkg = await exportEpisodes(aliceMem, eps.map(e => e.id), { dataDir: aliceMem._basePath });

    const bobMem = await makeMemory('dedup-bob');
    generateAgentIdentity(bobMem._basePath);

    // Import twice
    const r1 = await importShare(bobMem, pkg, { dataDir: bobMem._basePath });
    const r2 = await importShare(bobMem, pkg, { dataDir: bobMem._basePath });
    assert(r1.imported === 1 && r2.skipped === 1, 'duplicate import skipped');
  }

  // ── 9. Encrypted sharing ───────────────────────────────────
  console.log('\nEncrypted Sharing:');
  {
    const aliceMem = await makeMemory('enc-alice');
    const aliceId = generateAgentIdentity(aliceMem._basePath);
    const bobMem = await makeMemory('enc-bob');
    const bobId = generateAgentIdentity(bobMem._basePath);

    const eps = await aliceMem.remember('Secret encrypted message', { type: 'fact' });
    const pkg = await exportEpisodes(aliceMem, eps.map(e => e.id), {
      dataDir: aliceMem._basePath,
      agentId: 'alice',
      recipientPublicKey: bobId.encPublicKey,
      encrypt: true,
    });

    assert(pkg.metadata.encrypted === true, 'package marked as encrypted');
    assert(pkg.encrypted && pkg.encrypted.ciphertext, 'has encrypted payload');
    assert(!pkg.episodes, 'no plaintext episodes in encrypted package');

    // Bob can decrypt and import
    const result = await importShare(bobMem, pkg, { dataDir: bobMem._basePath });
    assert(result.imported === 1, 'encrypted episodes imported successfully');

    const bobEps = await bobMem.getRecent(100);
    const found = bobEps.find(e => e.text.includes('Secret encrypted'));
    assert(!!found, 'decrypted episode content matches');
  }

  // ── 10. Import from JSON string ────────────────────────────
  console.log('\nJSON string import:');
  {
    const mem = await makeMemory('json-str');
    generateAgentIdentity(mem._basePath);
    const eps = await mem.remember('JSON string test', { type: 'fact' });
    const pkg = await exportEpisodes(mem, eps.map(e => e.id), { dataDir: mem._basePath });
    const jsonStr = JSON.stringify(pkg);

    const mem2 = await makeMemory('json-str-import');
    generateAgentIdentity(mem2._basePath);
    const result = await importShare(mem2, jsonStr, { dataDir: mem2._basePath });
    assert(result.imported === 1, 'import from JSON string works');
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  // Cleanup
  rmSync(TEST_DIR, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
