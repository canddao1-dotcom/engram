#!/usr/bin/env node
/**
 * Engram Anchor — On-chain memory anchoring via AgentTrace.
 * Creates Merkle root hashes of memory snapshots and publishes them to Solana.
 * 
 * Zero-dep for hashing (Node.js crypto). Solana deps are optional/lazy-loaded.
 */

import { createHash } from 'crypto';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';

// ─── Merkle Tree (zero-dep) ───────────────────────────────────

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Bytes(data) {
  return createHash('sha256').update(data).digest();
}

export function hashPair(a, b) {
  // Deterministic: sort the two hashes so order doesn't matter within a level
  const sorted = [a, b].sort(Buffer.compare);
  return sha256Bytes(Buffer.concat(sorted));
}

export function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: Buffer.alloc(32), layers: [[]] };
  if (leaves.length === 1) return { root: leaves[0], layers: [leaves] };

  const layers = [leaves.slice()];
  let current = leaves.slice();

  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        // Odd leaf: promote it (hash with itself)
        next.push(hashPair(current[i], current[i]));
      }
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

export function getMerkleProof(layers, leafIndex) {
  const proof = [];
  let idx = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;

    if (siblingIdx < layer.length) {
      proof.push({ hash: layer[siblingIdx], position: isRight ? 'left' : 'right' });
    } else {
      // Odd node, sibling is itself
      proof.push({ hash: layer[idx], position: isRight ? 'left' : 'right' });
    }

    idx = Math.floor(idx / 2);
  }

  return proof;
}

export function verifyMerkleProof(leafHash, proof, root) {
  let current = leafHash;

  for (const step of proof) {
    if (step.position === 'left') {
      current = hashPair(step.hash, current);
    } else {
      current = hashPair(current, step.hash);
    }
  }

  return current.equals(root);
}

// ─── Snapshot ─────────────────────────────────────────────────

export function hashEpisode(episode) {
  // Deterministic: JSON.stringify with sorted keys
  const canonical = JSON.stringify(episode, Object.keys(episode).sort());
  return sha256Bytes(canonical);
}

export async function createSnapshot(dataDir) {
  const episodesDir = join(dataDir, 'episodes');
  let files;
  try {
    files = (await readdir(episodesDir)).filter(f => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }

  const episodes = [];
  for (const f of files) {
    const data = await readFile(join(episodesDir, f), 'utf-8');
    episodes.push(JSON.parse(data));
  }

  // Sort by ID for deterministic ordering
  episodes.sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  const episodeHashes = episodes.map(ep => hashEpisode(ep));
  const { root, layers } = buildMerkleTree(episodeHashes);

  return {
    root: root.toString('hex'),
    rootBytes: root,
    episodeCount: episodes.length,
    timestamp: Date.now(),
    episodeHashes: episodeHashes.map(h => h.toString('hex')),
    episodeIds: episodes.map(ep => ep.id),
    layers,
  };
}

export async function verifySnapshot(dataDir, expectedRoot) {
  const snapshot = await createSnapshot(dataDir);
  return {
    valid: snapshot.root === expectedRoot,
    currentRoot: snapshot.root,
    expectedRoot,
    episodeCount: snapshot.episodeCount,
  };
}

export function verifyEpisode(episode, proof, rootHex) {
  const leafHash = hashEpisode(episode);
  const root = Buffer.from(rootHex, 'hex');
  // Convert proof from hex if needed
  const proofBuffers = proof.map(p => ({
    hash: typeof p.hash === 'string' ? Buffer.from(p.hash, 'hex') : p.hash,
    position: p.position,
  }));
  return verifyMerkleProof(leafHash, proofBuffers, root);
}

export function getEpisodeProof(snapshot, episodeId) {
  const idx = snapshot.episodeIds.indexOf(episodeId);
  if (idx === -1) return null;
  const proof = getMerkleProof(snapshot.layers, idx);
  return {
    episodeId,
    leafHash: snapshot.episodeHashes[idx],
    proof: proof.map(p => ({ hash: p.hash.toString('hex'), position: p.position })),
    root: snapshot.root,
  };
}

// ─── On-chain anchoring (lazy Solana deps) ────────────────────

const AGENTTRACE_PROGRAM_ID = 'DY7oL6kjgLihMXeHypHQHAXxBLxFBVvd4bwkUwb7upyF';
const IDL_PATH = resolve('/home/node/.openclaw/workspace/hackathon/agenttrace/frontend/src/idl/agenttrace.json');

async function loadSolanaDeps() {
  const anchor = await import('@coral-xyz/anchor');
  const web3 = await import('@solana/web3.js');
  return { anchor, web3 };
}

export async function anchorOnChain(snapshot, options = {}) {
  const {
    agentId = 'engram-default',
    rpcUrl = 'https://api.mainnet.solana.com',
    walletPath = resolve(process.env.HOME, '.config/solana/id.json'),
  } = options;

  const { anchor, web3 } = await loadSolanaDeps();
  const { Connection, Keypair, PublicKey } = web3;

  // Load wallet
  const walletData = JSON.parse(await readFile(walletPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(walletData));
  const wallet = new anchor.Wallet(keypair);

  // Load IDL
  const idl = JSON.parse(await readFile(IDL_PATH, 'utf-8'));

  // Setup provider
  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const programId = new PublicKey(AGENTTRACE_PROGRAM_ID);
  const program = new anchor.Program(idl, programId, provider);

  // Derive PDAs
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), Buffer.from(agentId)],
    programId
  );
  const [agentStakePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent_stake'), agentPda.toBuffer()],
    programId
  );
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('protocol_state')],
    programId
  );

  const traceHash = Array.from(snapshot.rootBytes);

  const [tracePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('trace'), agentPda.toBuffer(), Buffer.from(snapshot.rootBytes)],
    programId
  );

  // Build metadata content
  const ipfsCid = `engram:merkle:${snapshot.root}`;

  const metadata = {
    spanCount: snapshot.episodeCount,
    tokenCount: snapshot.timestamp & 0xFFFFFFFF, // Encode timestamp low bits
    toolCount: 0,
    outcomeScore: 1,
  };

  const tx = await program.methods
    .publishTrace(traceHash, ipfsCid, metadata)
    .accounts({
      trace: tracePda,
      agent: agentPda,
      agentStake: agentStakePda,
      protocolState: protocolStatePda,
      owner: wallet.publicKey,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();

  return {
    signature: tx,
    tracePda: tracePda.toString(),
    root: snapshot.root,
    episodeCount: snapshot.episodeCount,
  };
}

// ─── Save/load snapshots locally ──────────────────────────────

export async function saveSnapshot(snapshot, dataDir) {
  const anchorsDir = join(dataDir, 'anchors');
  await mkdir(anchorsDir, { recursive: true });
  const filename = `snapshot-${Date.now()}.json`;
  const data = {
    root: snapshot.root,
    episodeCount: snapshot.episodeCount,
    timestamp: snapshot.timestamp,
    episodeHashes: snapshot.episodeHashes,
    episodeIds: snapshot.episodeIds,
    engramVersion: '1.3.1',
  };
  await writeFile(join(anchorsDir, filename), JSON.stringify(data, null, 2));
  return join(anchorsDir, filename);
}

// ─── CLI ──────────────────────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      flags[key] = val;
      if (val !== 'true') i++;
    }
  }

  const dataDir = flags.path || resolve(process.cwd(), 'memory/engram');

  switch (command) {
    case 'snapshot': {
      const snapshot = await createSnapshot(dataDir);
      const savedPath = await saveSnapshot(snapshot, dataDir);
      console.log(`✓ Snapshot created`);
      console.log(`  Root:     ${snapshot.root}`);
      console.log(`  Episodes: ${snapshot.episodeCount}`);
      console.log(`  Saved:    ${savedPath}`);
      break;
    }

    case 'anchor': {
      const snapshot = await createSnapshot(dataDir);
      console.log(`✓ Snapshot: ${snapshot.root} (${snapshot.episodeCount} episodes)`);
      console.log(`  Anchoring on-chain...`);
      try {
        const result = await anchorOnChain(snapshot, {
          agentId: flags.agent || 'engram-default',
          rpcUrl: flags.rpc || 'https://api.mainnet.solana.com',
          walletPath: flags.wallet || resolve(process.env.HOME, '.config/solana/id.json'),
        });
        await saveSnapshot(snapshot, dataDir);
        console.log(`✓ Anchored on-chain!`);
        console.log(`  TX:    ${result.signature}`);
        console.log(`  Trace: ${result.tracePda}`);
      } catch (e) {
        console.error(`✗ On-chain anchoring failed: ${e.message}`);
        const savedPath = await saveSnapshot(snapshot, dataDir);
        console.log(`  Snapshot saved locally: ${savedPath}`);
        process.exit(1);
      }
      break;
    }

    case 'verify': {
      const root = flags.root;
      if (!root) { console.error('Usage: anchor.js verify --path <dir> --root <hash>'); process.exit(1); }
      const result = await verifySnapshot(dataDir, root);
      if (result.valid) {
        console.log(`✓ Memory integrity verified`);
        console.log(`  Root:     ${result.currentRoot}`);
        console.log(`  Episodes: ${result.episodeCount}`);
      } else {
        console.log(`✗ Memory integrity FAILED`);
        console.log(`  Expected: ${result.expectedRoot}`);
        console.log(`  Current:  ${result.currentRoot}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`Engram Anchor — On-chain memory anchoring

Usage: node anchor.js <command> [--flags]

Commands:
  snapshot  Create local snapshot (no on-chain)
  anchor    Create snapshot + anchor on-chain via AgentTrace
  verify    Verify memory state matches a root hash

Flags:
  --path <dir>      Memory data directory
  --root <hash>     Expected Merkle root (verify)
  --agent <id>      AgentTrace agent ID
  --rpc <url>       Solana RPC endpoint
  --wallet <path>   Solana wallet keypair path
`);
  }
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('anchor.js') ||
  process.argv[1].endsWith('scripts/anchor.js')
);
if (isMain) {
  cli().catch(e => { console.error(e.message); process.exit(1); });
}
