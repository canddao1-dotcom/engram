#!/usr/bin/env node
/**
 * Tests for Engram Anchor — Merkle tree, snapshots, verification.
 * Solana interactions are mocked.
 */

import { createHash } from 'crypto';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  sha256, sha256Bytes, hashPair, buildMerkleTree, getMerkleProof,
  verifyMerkleProof, hashEpisode, createSnapshot, verifySnapshot,
  verifyEpisode, getEpisodeProof, saveSnapshot,
} from '../scripts/anchor.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} (${a} === ${b})`);
}

// Helper: create temp engram dir with episodes
async function makeTempDir(episodes) {
  const dir = await mkdtemp(join(tmpdir(), 'engram-test-'));
  const epDir = join(dir, 'episodes');
  await mkdir(epDir, { recursive: true });
  for (const ep of episodes) {
    await writeFile(join(epDir, `${ep.id}.json`), JSON.stringify(ep, null, 2));
  }
  return dir;
}

const sampleEpisodes = [
  { id: 'ep-001', text: 'The sky is blue', type: 'fact', tags: ['nature'], createdAt: 1000 },
  { id: 'ep-002', text: 'Water boils at 100C', type: 'fact', tags: ['science'], createdAt: 2000 },
  { id: 'ep-003', text: 'Solana is fast', type: 'fact', tags: ['crypto'], createdAt: 3000 },
];

async function run() {
  console.log('Engram Anchor Tests\n');

  // ─── 1. SHA-256 basics ────────────────────────────────
  console.log('SHA-256:');
  assertEq(sha256('hello'), createHash('sha256').update('hello').digest('hex'), 'sha256 matches crypto');
  assert(sha256Bytes('hello') instanceof Buffer, 'sha256Bytes returns Buffer');
  assertEq(sha256Bytes('hello').length, 32, 'sha256Bytes is 32 bytes');

  // ─── 2. Hash pair determinism ─────────────────────────
  console.log('\nHash pair:');
  const a = sha256Bytes('a');
  const b = sha256Bytes('b');
  const ab1 = hashPair(a, b);
  const ab2 = hashPair(b, a);
  assert(ab1.equals(ab2), 'hashPair is commutative (sorted)');
  assert(!ab1.equals(a), 'hashPair differs from input');

  // ─── 3. Merkle tree ───────────────────────────────────
  console.log('\nMerkle tree:');
  const leaves = [sha256Bytes('a'), sha256Bytes('b'), sha256Bytes('c'), sha256Bytes('d')];
  const { root, layers } = buildMerkleTree(leaves);
  assert(root instanceof Buffer && root.length === 32, 'root is 32-byte Buffer');
  assertEq(layers.length, 3, '4 leaves → 3 layers');
  assertEq(layers[0].length, 4, 'layer 0 has 4 leaves');
  assertEq(layers[1].length, 2, 'layer 1 has 2 nodes');
  assertEq(layers[2].length, 1, 'layer 2 has 1 root');

  // ─── 4. Merkle tree determinism ───────────────────────
  console.log('\nDeterminism:');
  const { root: root2 } = buildMerkleTree(leaves);
  assert(root.equals(root2), 'same leaves → same root');

  const diffLeaves = [sha256Bytes('a'), sha256Bytes('b'), sha256Bytes('c'), sha256Bytes('e')];
  const { root: root3 } = buildMerkleTree(diffLeaves);
  assert(!root.equals(root3), 'different leaves → different root');

  // ─── 5. Merkle tree edge cases ────────────────────────
  console.log('\nEdge cases:');
  const { root: emptyRoot } = buildMerkleTree([]);
  assert(emptyRoot.equals(Buffer.alloc(32)), 'empty tree → zero root');

  const single = [sha256Bytes('only')];
  const { root: singleRoot } = buildMerkleTree(single);
  assert(singleRoot.equals(single[0]), 'single leaf → leaf is root');

  // Odd number of leaves
  const oddLeaves = [sha256Bytes('a'), sha256Bytes('b'), sha256Bytes('c')];
  const { root: oddRoot, layers: oddLayers } = buildMerkleTree(oddLeaves);
  assert(oddRoot instanceof Buffer && oddRoot.length === 32, 'odd leaves produce valid root');

  // ─── 6. Merkle proof ──────────────────────────────────
  console.log('\nMerkle proof:');
  for (let i = 0; i < leaves.length; i++) {
    const proof = getMerkleProof(layers, i);
    const valid = verifyMerkleProof(leaves[i], proof, root);
    assert(valid, `proof valid for leaf ${i}`);
  }

  // Odd tree proofs
  for (let i = 0; i < oddLeaves.length; i++) {
    const proof = getMerkleProof(oddLayers, i);
    const valid = verifyMerkleProof(oddLeaves[i], proof, oddRoot);
    assert(valid, `odd tree proof valid for leaf ${i}`);
  }

  // ─── 7. Invalid proof detection ───────────────────────
  console.log('\nTamper detection:');
  const fakeLeaf = sha256Bytes('fake');
  const proof0 = getMerkleProof(layers, 0);
  const invalid = verifyMerkleProof(fakeLeaf, proof0, root);
  assert(!invalid, 'fake leaf rejected by proof');

  // ─── 8. Episode hashing determinism ───────────────────
  console.log('\nEpisode hashing:');
  const ep = { id: 'test', text: 'hello', type: 'fact', tags: [] };
  const h1 = hashEpisode(ep);
  const h2 = hashEpisode(ep);
  assert(h1.equals(h2), 'same episode → same hash');

  // Key order shouldn't matter (we sort keys)
  const ep2 = { type: 'fact', tags: [], text: 'hello', id: 'test' };
  const h3 = hashEpisode(ep2);
  assert(h1.equals(h3), 'different key order → same hash');

  const ep3 = { id: 'test', text: 'modified', type: 'fact', tags: [] };
  const h4 = hashEpisode(ep3);
  assert(!h1.equals(h4), 'modified text → different hash');

  // ─── 9. Snapshot creation ─────────────────────────────
  console.log('\nSnapshot:');
  const dir = await makeTempDir(sampleEpisodes);
  try {
    const snap = await createSnapshot(dir);
    assertEq(snap.episodeCount, 3, 'snapshot has 3 episodes');
    assertEq(snap.episodeHashes.length, 3, '3 episode hashes');
    assertEq(snap.root.length, 64, 'root is 64-char hex');
    assert(snap.timestamp > 0, 'timestamp present');

    // Determinism
    const snap2 = await createSnapshot(dir);
    assertEq(snap.root, snap2.root, 'snapshot deterministic');

    // ─── 10. Snapshot verification ──────────────────────
    console.log('\nVerification:');
    const vResult = await verifySnapshot(dir, snap.root);
    assert(vResult.valid, 'verifySnapshot passes with correct root');

    const vBad = await verifySnapshot(dir, 'deadbeef'.repeat(8));
    assert(!vBad.valid, 'verifySnapshot fails with wrong root');

    // ─── 11. Episode proof from snapshot ────────────────
    console.log('\nEpisode proofs:');
    for (const ep of sampleEpisodes) {
      const proofData = getEpisodeProof(snap, ep.id);
      assert(proofData !== null, `proof exists for ${ep.id}`);
      const valid = verifyEpisode(ep, proofData.proof, proofData.root);
      assert(valid, `verifyEpisode passes for ${ep.id}`);
    }

    // ─── 12. Tamper detection via snapshot ──────────────
    console.log('\nTamper detection (episode):');
    const tampered = { ...sampleEpisodes[0], text: 'TAMPERED' };
    const proofData = getEpisodeProof(snap, 'ep-001');
    const tamperedResult = verifyEpisode(tampered, proofData.proof, proofData.root);
    assert(!tamperedResult, 'tampered episode rejected');

    // ─── 13. Save snapshot ──────────────────────────────
    console.log('\nSave snapshot:');
    const savedPath = await saveSnapshot(snap, dir);
    const savedData = JSON.parse(await readFile(savedPath, 'utf-8'));
    assertEq(savedData.root, snap.root, 'saved root matches');
    assertEq(savedData.episodeCount, 3, 'saved episode count');
    assertEq(savedData.engramVersion, '1.3.1', 'version included');

    // ─── 14. Empty directory ────────────────────────────
    console.log('\nEmpty dir:');
    const emptyDir = await mkdtemp(join(tmpdir(), 'engram-empty-'));
    const emptySnap = await createSnapshot(emptyDir);
    assertEq(emptySnap.episodeCount, 0, 'empty dir → 0 episodes');
    assertEq(emptySnap.root, Buffer.alloc(32).toString('hex'), 'empty dir → zero root');
    await rm(emptyDir, { recursive: true });

  } finally {
    await rm(dir, { recursive: true });
  }

  // ─── Summary ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
