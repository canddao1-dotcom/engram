#!/usr/bin/env node
/**
 * Engram Sharing — Multi-agent memory sharing with access control.
 * Zero dependencies. Node.js crypto only (Ed25519 + X25519 + ChaCha20-Poly1305).
 */

import {
  createHash, randomBytes, generateKeyPairSync, sign, verify,
  diffieHellman, createCipheriv, createDecipheriv,
  createPublicKey, createPrivateKey,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Helpers ─────────────────────────────────────────────────────

function genId(prefix = 'share') {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJSON(filePath, data) {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Key helpers ─────────────────────────────────────────────────

function pubKeyFromDer(b64, type = 'spki') {
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type });
}
function privKeyFromDer(b64, type = 'pkcs8') {
  return createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type });
}
function exportPub(keyObj) { return keyObj.export({ type: 'spki', format: 'der' }).toString('base64'); }
function exportPriv(keyObj) { return keyObj.export({ type: 'pkcs8', format: 'der' }).toString('base64'); }

// ─── Agent Identity ──────────────────────────────────────────────

export function generateAgentIdentity(dataDir) {
  const idPath = join(dataDir, 'agent-identity.json');
  if (existsSync(idPath)) return JSON.parse(readFileSync(idPath, 'utf8'));

  const signing = generateKeyPairSync('ed25519');
  const encryption = generateKeyPairSync('x25519');

  const identity = {
    publicKey: exportPub(signing.publicKey),           // Ed25519 signing
    privateKey: exportPriv(signing.privateKey),
    encPublicKey: exportPub(encryption.publicKey),      // X25519 encryption
    encPrivateKey: exportPriv(encryption.privateKey),
    createdAt: new Date().toISOString(),
  };
  writeJSON(idPath, identity);
  return identity;
}

export function loadIdentity(dataDir) {
  const idPath = join(dataDir, 'agent-identity.json');
  return readJSON(idPath);
}

// ─── Signing ─────────────────────────────────────────────────────

function signData(data, privateKeyB64) {
  const privKey = privKeyFromDer(privateKeyB64);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return sign(null, buf, privKey).toString('base64');
}

function verifySignature(data, signatureB64, publicKeyB64) {
  const pubKey = pubKeyFromDer(publicKeyB64);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return verify(null, buf, pubKey, Buffer.from(signatureB64, 'base64'));
}

// ─── Encryption (X25519 ECDH + ChaCha20-Poly1305) ───────────────

function encryptPayload(plaintext, recipientEncPubB64) {
  const ephemeral = generateKeyPairSync('x25519');
  const recipientPub = pubKeyFromDer(recipientEncPubB64);

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPub });
  const key = createHash('sha256').update(shared).digest();
  const nonce = randomBytes(12);

  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: exportPub(ephemeral.publicKey),
    nonce: nonce.toString('base64'),
    authTag: tag.toString('base64'),
    ciphertext: enc.toString('base64'),
  };
}

function decryptPayload(encData, recipientEncPrivB64) {
  const recipientPriv = privKeyFromDer(recipientEncPrivB64);
  const ephPub = pubKeyFromDer(encData.ephemeralPublicKey);

  const shared = diffieHellman({ privateKey: recipientPriv, publicKey: ephPub });
  const key = createHash('sha256').update(shared).digest();
  const nonce = Buffer.from(encData.nonce, 'base64');

  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(encData.authTag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encData.ciphertext, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

// ─── Share Manifest ──────────────────────────────────────────────

function manifestPath(dataDir) { return join(dataDir, 'sharing-manifest.json'); }

export function loadManifest(dataDir) {
  return readJSON(manifestPath(dataDir)) || { agentId: null, publicKey: null, shares: [], received: [] };
}

export function saveManifest(dataDir, manifest) {
  writeJSON(manifestPath(dataDir), manifest);
}

// ─── Export Episodes ─────────────────────────────────────────────

export async function exportEpisodes(memory, episodeIds, opts = {}) {
  const dataDir = opts.dataDir || memory._basePath;
  const identity = loadIdentity(dataDir);
  if (!identity) throw new Error('No agent identity. Run generateAgentIdentity first.');

  await memory.init();
  const allEpisodes = await memory.getRecent(999999);
  const episodes = allEpisodes.filter(ep => episodeIds.includes(ep.id));
  if (!episodes.length) throw new Error('No matching episodes found');

  const exportedEpisodes = episodes.map(ep => ({
    id: ep.id, text: ep.text, type: ep.type || 'fact',
    tags: ep.tags || [], importance: ep.importance || 0.5,
    createdAt: ep.createdAt, contentHash: contentHash(ep.text),
  }));

  const metadata = {
    format: 'engram-share-v1',
    fromAgentId: opts.agentId || memory.agentId || 'unknown',
    fromPublicKey: identity.publicKey,
    fromEncPublicKey: identity.encPublicKey,
    recipientAgentId: opts.recipientAgentId || null,
    episodeCount: exportedEpisodes.length,
    encrypted: false,
    createdAt: new Date().toISOString(),
  };

  let packageData;
  if (opts.encrypt && opts.recipientPublicKey) {
    // recipientPublicKey here is the recipient's encPublicKey (X25519)
    const encrypted = encryptPayload(JSON.stringify(exportedEpisodes), opts.recipientPublicKey);
    metadata.encrypted = true;
    packageData = { metadata, encrypted };
  } else {
    packageData = { metadata, episodes: exportedEpisodes };
  }

  const sigInput = JSON.stringify(packageData);
  packageData.signature = signData(sigInput, identity.privateKey);

  // Record grant
  const manifest = loadManifest(dataDir);
  manifest.agentId = metadata.fromAgentId;
  manifest.publicKey = identity.publicKey;
  manifest.shares.push({
    id: genId('share'), episodeIds,
    recipientAgentId: opts.recipientAgentId || null,
    recipientPublicKey: opts.recipientPublicKey || null,
    permissions: opts.permissions || 'read',
    expiresAt: opts.expiresAt || null,
    createdAt: metadata.createdAt,
  });
  saveManifest(dataDir, manifest);

  return packageData;
}

// ─── Import Shared Episodes ─────────────────────────────────────

export async function importShare(memory, sharePackage, opts = {}) {
  const dataDir = opts.dataDir || memory._basePath;
  if (typeof sharePackage === 'string') sharePackage = JSON.parse(sharePackage);

  const { metadata, signature } = sharePackage;
  if (!metadata || !signature) throw new Error('Invalid share package: missing metadata or signature');

  // Verify signature
  const toVerify = { ...sharePackage };
  delete toVerify.signature;
  if (!verifySignature(JSON.stringify(toVerify), signature, metadata.fromPublicKey)) {
    throw new Error('Invalid signature: share package may be tampered');
  }

  // Decrypt if needed
  let episodes;
  if (metadata.encrypted) {
    const identity = loadIdentity(dataDir);
    if (!identity) throw new Error('No agent identity to decrypt');
    episodes = JSON.parse(decryptPayload(sharePackage.encrypted, identity.encPrivateKey));
  } else {
    episodes = sharePackage.episodes;
  }

  if (!episodes || !episodes.length) throw new Error('No episodes in share package');

  // Deduplication
  await memory.init();
  const existing = await memory.getRecent(999999);
  const existingHashes = new Set(existing.map(ep => contentHash(ep.text)));

  let imported = 0, skipped = 0;
  for (const ep of episodes) {
    const hash = ep.contentHash || contentHash(ep.text);
    if (existingHashes.has(hash)) { skipped++; continue; }

    await memory.remember(ep.text, {
      type: ep.type || 'fact',
      tags: [...(ep.tags || []), 'shared'],
      importance: (ep.importance || 0.5) * 0.5,
      metadata: { shared: true, sharedFrom: metadata.fromAgentId, originalId: ep.id, importedAt: new Date().toISOString() },
    });
    imported++;
    existingHashes.add(hash);
  }

  // Record receipt
  const manifest = loadManifest(dataDir);
  manifest.received.push({
    id: genId('recv'), fromAgentId: metadata.fromAgentId,
    episodeCount: imported, importedAt: new Date().toISOString(),
  });
  saveManifest(dataDir, manifest);

  return { imported, skipped, total: episodes.length };
}

// ─── Access Control ──────────────────────────────────────────────

export function grantAccess(dataDir, agentId, episodeFilter, permissions = 'read', expiry = null) {
  const manifest = loadManifest(dataDir);
  const grant = {
    id: genId('share'),
    episodeIds: episodeFilter.episodeIds || [],
    recipientAgentId: agentId,
    recipientPublicKey: episodeFilter.recipientPublicKey || null,
    permissions, expiresAt: expiry,
    createdAt: new Date().toISOString(),
  };
  manifest.shares.push(grant);
  saveManifest(dataDir, manifest);
  return grant;
}

export function revokeAccess(dataDir, shareId) {
  const manifest = loadManifest(dataDir);
  const idx = manifest.shares.findIndex(s => s.id === shareId);
  if (idx === -1) return false;
  manifest.shares.splice(idx, 1);
  saveManifest(dataDir, manifest);
  return true;
}

export function listGrants(dataDir) {
  const manifest = loadManifest(dataDir);
  const now = new Date().toISOString();
  return manifest.shares.filter(s => !s.expiresAt || s.expiresAt > now);
}

export function isGrantValid(grant) {
  if (!grant) return false;
  if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) return false;
  return true;
}

// ─── CLI Integration ─────────────────────────────────────────────

export async function handleSharingCLI(command, positional, flags, mem) {
  const dataDir = mem._basePath;
  switch (command) {
    case 'identity': {
      const id = generateAgentIdentity(dataDir);
      console.log('Agent Identity:');
      console.log(`  Signing Key:    ${id.publicKey.slice(0, 40)}...`);
      console.log(`  Encryption Key: ${id.encPublicKey.slice(0, 40)}...`);
      console.log(`  Created:        ${id.createdAt}`);
      break;
    }
    case 'share': {
      const episodeIds = flags.episodes ? flags.episodes.split(',') : [];
      if (!episodeIds.length) { console.error('Usage: engram share --episodes ep1,ep2 [--to agentId] [--encrypt] [--recipient-key KEY]'); process.exit(1); }
      const pkg = await exportEpisodes(mem, episodeIds, {
        recipientAgentId: flags.to || null,
        recipientPublicKey: flags['recipient-key'] || null,
        encrypt: flags.encrypt === 'true', dataDir,
      });
      const outPath = flags.output || `share-${Date.now()}.engram-share`;
      writeFileSync(outPath, JSON.stringify(pkg, null, 2));
      console.log(`✓ Exported ${pkg.metadata.episodeCount} episodes to ${outPath}`);
      break;
    }
    case 'import': {
      const file = positional[1];
      if (!file) { console.error('Usage: engram import <share-file>'); process.exit(1); }
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const result = await importShare(mem, pkg, { dataDir });
      console.log(`✓ Imported ${result.imported} episodes (${result.skipped} duplicates skipped)`);
      break;
    }
    case 'grants': {
      const grants = listGrants(dataDir);
      if (!grants.length) { console.log('No active share grants.'); break; }
      for (const g of grants) {
        console.log(`${g.id} → ${g.recipientAgentId || '(any)'} [${g.permissions}] episodes: ${g.episodeIds.length}`);
        if (g.expiresAt) console.log(`  expires: ${g.expiresAt}`);
      }
      break;
    }
    case 'revoke': {
      const shareId = positional[1];
      if (!shareId) { console.error('Usage: engram revoke <shareId>'); process.exit(1); }
      const ok = revokeAccess(dataDir, shareId);
      console.log(ok ? `✓ Revoked ${shareId}` : `✗ Not found: ${shareId}`);
      break;
    }
    default: return false;
  }
  return true;
}
