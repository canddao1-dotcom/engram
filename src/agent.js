/**
 * Engram AgentMemory — High-level memory API for OpenClaw agents.
 *
 * v1.1: Incremental BM25 index, lazy episode loading, synonym expansion.
 */

import { createEpisode, chunk, tokenize, contentHash, EPISODE_TYPES, termFrequencies } from './core.js';
import { QueryEngine } from './query.js';
import { FileStorage } from './storage/file.js';
import { parseTemporalQuery } from './temporal.js';
import { initSynonyms, loadCustomSynonyms } from './synonyms.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { encrypt, decrypt, deriveKey, generateKey } from '../scripts/encryption.js';

/**
 * Format a timestamp as a human-readable relative time string.
 */
function _relativeTime(ts, now = Date.now()) {
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export class AgentMemory {
  /**
   * @param {object} opts
   * @param {string} opts.agentId - agent identifier (default: 'default')
   * @param {string} opts.basePath - storage directory (default: 'memory/engram')
   * @param {object} opts.redis - { url, token } for Redis backend (optional)
   * @param {number} opts.recencyWeight - 0-1 (default: 0.3)
   * @param {number} opts.recencyLambda - decay rate (default: 0.1)
   * @param {number} opts.importanceDecay - daily factor (default: 0.95)
   * @param {string} opts.chunkMode - 'sentence'|'paragraph'|'fixed' (default: 'sentence')
   * @param {number} opts.maxChunkTokens - max tokens per chunk (default: 256)
   * @param {number} opts.synonymWeight - weight for synonym matches (default: 0.5)
   * @param {string} opts.synonymsFile - path to custom synonyms JSON file (optional)
   * @param {object} opts.encryption - { enabled: true, key: '...' } or { enabled: true, password: '...' }
   */
  constructor(opts = {}) {
    this.agentId = opts.agentId || 'default';
    this.chunkMode = opts.chunkMode || 'sentence';
    this.maxChunkTokens = opts.maxChunkTokens || 256;
    this._initialized = false;
    this._initMode = null; // 'full' | 'incremental'
    this._synonymsFile = opts.synonymsFile || null;

    // Storage backend
    this._redisConfig = opts.redis || null;
    const basePath = opts.basePath || opts.dataDir || 'memory/engram';
    this._basePath = basePath;
    this.storage = opts.redis ? null : new FileStorage(basePath);

    // Encryption
    this._encryptionConfig = opts.encryption || null;
    this._encryptionKey = null; // resolved hex key
    this._encryptionSalt = null; // for password-based derivation

    // Query engine
    this.engine = new QueryEngine({
      recencyWeight: opts.recencyWeight,
      recencyLambda: opts.recencyLambda,
      importanceDecay: opts.importanceDecay,
      synonymWeight: opts.synonymWeight,
    });
  }

  /**
   * Initialize storage and load/rebuild index.
   * Uses incremental indexing when a persisted BM25 index exists.
   */
  /**
   * Resolve the encryption key from config, env, or key file.
   */
  _resolveEncryptionKey() {
    if (!this._encryptionConfig || !this._encryptionConfig.enabled) return;

    // Direct key
    if (this._encryptionConfig.key) {
      this._encryptionKey = this._encryptionConfig.key;
      return;
    }

    // Password-based derivation
    if (this._encryptionConfig.password) {
      const saltPath = join(this._basePath, 'engram.salt');
      let salt = null;
      if (existsSync(saltPath)) {
        salt = readFileSync(saltPath, 'utf-8').trim();
      }
      const result = deriveKey(this._encryptionConfig.password, salt || undefined);
      this._encryptionKey = result.key;
      this._encryptionSalt = result.salt;
      // Persist salt if new — done lazily in init() since dir may not exist yet
      this._pendingSaltWrite = !salt ? { path: saltPath, salt: result.salt } : null;
      return;
    }

    // Env var
    if (process.env.ENGRAM_KEY) {
      this._encryptionKey = process.env.ENGRAM_KEY;
      return;
    }

    // Key file
    const keyPath = join(this._basePath, 'engram.key');
    if (existsSync(keyPath)) {
      this._encryptionKey = readFileSync(keyPath, 'utf-8').trim();
      return;
    }

    throw new Error('Encryption enabled but no key provided. Set key, password, ENGRAM_KEY env, or create <dataDir>/engram.key');
  }

  /**
   * Encrypt episode content and tags (if encryption enabled).
   * Returns a new episode object with encrypted fields.
   */
  _encryptEpisode(episode) {
    if (!this._encryptionKey) return episode;
    const ep = { ...episode };
    const encContent = encrypt(ep.text, this._encryptionKey);
    ep.text = JSON.stringify(encContent);
    ep._encrypted = true;
    if (ep.tags && ep.tags.length > 0) {
      const encTags = encrypt(JSON.stringify(ep.tags), this._encryptionKey);
      ep.tags = [JSON.stringify(encTags)];
      ep._tagsEncrypted = true;
    }
    return ep;
  }

  /**
   * Decrypt episode content and tags (if encrypted).
   * Returns a new episode object with decrypted fields.
   */
  _decryptEpisode(episode) {
    if (!episode._encrypted) return episode;
    if (!this._encryptionKey) return episode; // can't decrypt without key
    const ep = { ...episode };
    const encContent = JSON.parse(ep.text);
    ep.text = decrypt(encContent, this._encryptionKey);
    if (ep._tagsEncrypted && ep.tags && ep.tags.length === 1) {
      try {
        const encTags = JSON.parse(ep.tags[0]);
        ep.tags = JSON.parse(decrypt(encTags, this._encryptionKey));
      } catch { /* leave as-is */ }
    }
    ep._encrypted = false;
    ep._tagsEncrypted = false;
    return ep;
  }

  get encryptionEnabled() {
    return !!this._encryptionKey;
  }

  /**
   * Load and decrypt a single episode from storage.
   */
  async _loadEpisode(id) {
    const ep = await this.storage.getEpisode(id);
    return ep ? this._decryptEpisode(ep) : null;
  }

  /**
   * Load and decrypt all episodes from storage.
   */
  async _loadAllEpisodes() {
    const all = await this.storage.getAllEpisodes();
    if (!this._encryptionKey) return all;
    return all.map(ep => { try { return this._decryptEpisode(ep); } catch { return ep; } });
  }

  async init() {
    if (this._initialized) return;

    // Resolve encryption key (sync parts)
    this._resolveEncryptionKey();

    // Initialize synonyms: defaults → env → agent dataDir → explicit file
    await initSynonyms();
    const dataDirSynonyms = join(this._basePath, 'synonyms.json');
    if (existsSync(dataDirSynonyms)) {
      await loadCustomSynonyms(dataDirSynonyms);
    }
    if (this._synonymsFile) {
      await loadCustomSynonyms(this._synonymsFile);
    }

    if (!this.storage && this._redisConfig) {
      const { RedisStorage } = await import('./storage/redis.js');
      this.storage = new RedisStorage(this._redisConfig);
    }
    await this.storage.init();

    // Persist salt if needed (after storage creates directories)
    if (this._pendingSaltWrite) {
      const { writeFileSync } = await import('fs');
      writeFileSync(this._pendingSaltWrite.path, this._pendingSaltWrite.salt);
      this._pendingSaltWrite = null;
    }

    // Try incremental init
    let didIncremental = false;
    if (this.storage.loadBM25Index) {
      const savedIndex = await this.storage.loadBM25Index();
      if (savedIndex) {
        // Load new episodes since last index
        const newEpisodes = await this.storage.getEpisodesSince(savedIndex.lastIndexedTimestamp);

        // Verify index isn't stale (check doc count roughly matches)
        const allIds = await this.storage.listEpisodeIds();
        const expectedDocs = savedIndex.totalDocs + newEpisodes.length;

        if (Math.abs(allIds.length - expectedDocs) <= newEpisodes.length) {
          // Restore from persisted index, then add only new episodes
          this.engine.restoreFromIndex(savedIndex);

          // We need TF data for search — reload all episodes to populate TF maps
          // But only if we have docs. For small sets this is fast.
          // For the incremental case, reload all to get TF (required for scoring).
          let allEpisodes = await this.storage.getAllEpisodes();
          if (this._encryptionKey) {
            allEpisodes = allEpisodes.map(ep => {
              try { return this._decryptEpisode(ep); } catch { return ep; }
            });
          }
          this.engine.rebuild(allEpisodes);

          // Actually for true incremental, we'd need to persist TF too.
          // For v1.1, we persist the index metadata and only do full rebuild
          // if the index is missing/corrupt. The persisted index serves as
          // validation that we have a consistent state.
          this._initMode = 'incremental';
          didIncremental = true;
        }
      }
    }

    if (!didIncremental) {
      // Full rebuild (v1.0 behavior / fallback)
      let episodes = await this.storage.getAllEpisodes();
      // Decrypt for in-memory index if encryption enabled
      if (this._encryptionKey) {
        episodes = episodes.map(ep => {
          try { return this._decryptEpisode(ep); } catch { return ep; }
        });
      }
      this.engine.rebuild(episodes);
      this._initMode = 'full';
    }

    // Persist the index for next startup
    await this._persistIndex();

    this._initialized = true;
  }

  /**
   * Persist the BM25 index to disk.
   */
  async _persistIndex() {
    if (this.storage.saveBM25Index) {
      await this.storage.saveBM25Index(this.engine.exportIndex());
    }
  }

  /**
   * Store a memory with auto-chunking.
   * @param {string} text
   * @param {object} opts - { type, tags, importance, metadata }
   * @returns {object[]} created episodes
   */
  async remember(text, opts = {}) {
    await this.init();

    const { supersedes, ...restOpts } = opts;
    const chunks = chunk(text, { mode: this.chunkMode, maxTokens: this.maxChunkTokens });
    const sourceId = contentHash(text);
    const episodes = [];

    for (let i = 0; i < chunks.length; i++) {
      const ep = createEpisode(chunks[i], {
        ...restOpts,
        agentId: this.agentId,
        chunkIndex: i,
        totalChunks: chunks.length,
        sourceId,
        supersedes: i === 0 ? supersedes : undefined, // only first chunk carries supersedes
      });
      // Index the plaintext version in memory
      this.engine.addDocument(ep);
      // Encrypt before persisting to disk
      const diskEp = this._encryptEpisode(ep);
      await this.storage.saveEpisode(diskEp);
      await this.storage.addToTagIndex(diskEp);
      episodes.push(ep); // return plaintext version
    }

    // Mark superseded episodes
    if (supersedes && Array.isArray(supersedes) && supersedes.length > 0 && episodes.length > 0) {
      const newId = episodes[0].id;
      for (const oldId of supersedes) {
        const oldEp = await this.storage.getEpisode(oldId);
        if (oldEp) {
          if (!oldEp.supersededBy) oldEp.supersededBy = [];
          if (!oldEp.supersededBy.includes(newId)) {
            oldEp.supersededBy.push(newId);
          }
          await this.storage.saveEpisode(oldEp);
        }
      }
    }

    // Persist updated index
    await this._persistIndex();

    return episodes;
  }

  /**
   * Store a memory that supersedes existing episodes.
   * Convenience method combining remember + supersession marking.
   * @param {string} text
   * @param {string[]} oldEpisodeIds - IDs of episodes being superseded
   * @param {object} opts - same as remember()
   * @returns {object[]} created episodes
   */
  async rememberSuperseding(text, oldEpisodeIds, opts = {}) {
    return this.remember(text, { ...opts, supersedes: oldEpisodeIds });
  }

  /**
   * Get the supersession chain for an episode.
   * @param {string} episodeId
   * @returns {object[]} chain from oldest to newest
   */
  async getSupersessionChain(episodeId) {
    await this.init();
    return QueryEngine.getSupersessionChain(episodeId, this.storage);
  }

  /**
   * Search memories using BM25 + recency + synonym expansion.
   * Episodes are loaded on-demand (lazy) from search results only.
   * @param {string} query
   * @param {object} opts - { limit, tags, type, after, before, minImportance, includeSuperseded }
   * @returns {object[]} episodes with scores
   */
  async recall(query, opts = {}) {
    await this.init();
    const results = this.engine.search(query, opts);

    // Lazy load: only fetch full episodes that appear in results
    const episodes = [];
    for (const r of results) {
      let ep = await this.storage.getEpisode(r.id);
      if (ep) {
        // Decrypt if needed
        ep = this._decryptEpisode(ep);
        ep.lastAccessedAt = Date.now();
        ep.accessCount = (ep.accessCount || 0) + 1;
        // Re-encrypt before saving back
        await this.storage.saveEpisode(this._encryptEpisode(ep));
        episodes.push({ ...ep, _score: r.score, _bm25: r.bm25, _recency: r.recency });
      }
    }
    return episodes;
  }

  /**
   * Build LLM-ready context string from relevant memories.
   * @param {string} query
   * @param {object} opts - { maxTokens, ...searchOpts }
   * @returns {string}
   */
  async buildContext(query, opts = {}) {
    const { maxTokens = 2000, ...searchOpts } = opts;
    const results = await this.recall(query, { limit: 20, ...searchOpts });

    let context = '';
    let tokenCount = 0;

    for (const ep of results) {
      const epTokens = tokenize(ep.text).length;
      if (tokenCount + epTokens > maxTokens) break;

      const date = new Date(ep.createdAt).toISOString().split('T')[0];
      const tagStr = ep.tags.length ? ` [${ep.tags.join(', ')}]` : '';
      context += `[${date}] (${ep.type})${tagStr}: ${ep.text}\n\n`;
      tokenCount += epTokens;
    }

    return context.trim();
  }

  /**
   * Get most recent memories.
   * @param {number} limit
   * @returns {object[]}
   */
  async getRecent(limit = 10) {
    await this.init();
    const all = await this._loadAllEpisodes();
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all.slice(0, limit);
  }

  /**
   * Find memories by tag.
   * @param {string} tag
   * @returns {object[]}
   */
  async findByTag(tag) {
    await this.init();
    const ids = await this.storage.getByTag(tag);
    const episodes = [];
    for (const id of ids) {
      const ep = await this._loadEpisode(id);
      if (ep) episodes.push(ep);
    }
    return episodes;
  }

  /**
   * Delete a memory.
   * @param {string} id
   * @returns {boolean}
   */
  async forget(id) {
    await this.init();
    this.engine.removeDocument(id);
    await this.storage.removeFromTagIndex(id);
    const result = await this.storage.deleteEpisode(id);
    await this._persistIndex();
    return result;
  }

  /**
   * Get memory statistics.
   * @returns {object}
   */
  async getStats() {
    await this.init();
    const storageStats = await this.storage.getStats();
    const all = await this._loadAllEpisodes();

    const typeCounts = {};
    const tagCounts = {};
    let oldest = Infinity, newest = 0;

    for (const ep of all) {
      typeCounts[ep.type] = (typeCounts[ep.type] || 0) + 1;
      for (const t of ep.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
      if (ep.createdAt < oldest) oldest = ep.createdAt;
      if (ep.createdAt > newest) newest = ep.createdAt;
    }

    return {
      ...storageStats,
      indexedDocs: this.engine.totalDocs,
      uniqueTerms: this.engine.df.size,
      avgDocLength: Math.round(this.engine.avgdl),
      typeCounts,
      tagCounts,
      oldestMemory: oldest < Infinity ? new Date(oldest).toISOString() : null,
      newestMemory: newest > 0 ? new Date(newest).toISOString() : null,
      initMode: this._initMode,
    };
  }

  /**
   * Prune old/low-importance memories.
   * @param {object} opts - { keep, maxAgeDays, minImportance }
   * @returns {{ pruned: number }}
   */
  async prune(opts = {}) {
    await this.init();
    const { keep = 1000, maxAgeDays = 90, minImportance = 0.05 } = opts;
    const all = await this._loadAllEpisodes();
    const now = Date.now();
    const DAY = 86400000;

    // Score each episode
    const scored = all.map(ep => {
      const daysSinceAccess = (now - (ep.lastAccessedAt || ep.createdAt)) / DAY;
      const currentImportance = (ep.importance || 0.5) * Math.pow(0.95, daysSinceAccess);
      const ageDays = (now - ep.createdAt) / DAY;
      return { ep, currentImportance, ageDays };
    });

    // Sort by importance (keep the best)
    scored.sort((a, b) => b.currentImportance - a.currentImportance);

    let pruned = 0;
    for (let i = 0; i < scored.length; i++) {
      const { ep, currentImportance, ageDays } = scored[i];
      const shouldPrune = i >= keep || (ageDays > maxAgeDays && currentImportance < minImportance);
      if (shouldPrune) {
        await this.forget(ep.id);
        pruned++;
      }
    }

    return { pruned };
  }

  /**
   * Temporal query — "what happened last Tuesday?"
   * @param {string} query
   * @param {object} opts
   * @returns {object[]}
   */
  async temporal(query, opts = {}) {
    await this.init();
    const { after, before, remaining } = parseTemporalQuery(query);
    const searchQuery = remaining || query;
    const searchOpts = { ...opts, after, before };

    if (after || before) {
      if (!remaining) {
        const all = await this._loadAllEpisodes();
        return all
          .filter(ep => (!after || ep.createdAt >= after) && (!before || ep.createdAt <= before))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, opts.limit || 20);
      }
      return this.recall(searchQuery, searchOpts);
    }

    return this.recall(query, opts);
  }

  /**
   * Summarize N episodes into a summary episode.
   * @param {string[]} ids - episode IDs to summarize
   * @param {string} summaryText - the summary text (caller generates this)
   * @param {object} opts
   * @returns {object} the summary episode
   */
  async summarize(ids, summaryText, opts = {}) {
    const tags = new Set(opts.tags || ['summary']);
    for (const id of ids) {
      const ep = await this._loadEpisode(id);
      if (ep) for (const t of ep.tags) tags.add(t);
    }

    const episodes = await this.remember(summaryText, {
      type: 'summary',
      tags: [...tags],
      importance: opts.importance || 0.8,
      metadata: { summarizedIds: ids, ...opts.metadata },
    });

    return episodes[0];
  }

  // ─── v1.3: Pre-Prompt Injection ──────────────────────────────

  /**
   * Fast pre-prompt memory injection. Designed for sub-300ms retrieval.
   * Returns a compact context string optimized for token budget.
   *
   * @param {string} query - The user's prompt/query
   * @param {object} options
   * @param {number} options.maxTokens - Max tokens for context (default: 1500)
   * @param {number} options.recentCount - Number of recent episodes to always include (default: 3)
   * @param {boolean} options.includeRecent - Whether to include recent episodes (default: true)
   * @param {string[]} options.priorityTags - Tags to boost in results
   * @param {string[]} options.excludeTags - Tags to exclude (e.g., 'migrated')
   * @returns {string} Formatted context string ready for LLM injection
   */
  async injectContext(query, options = {}) {
    await this.init();
    const {
      maxTokens = 1500,
      recentCount = 3,
      includeRecent = true,
      priorityTags = [],
      excludeTags = [],
    } = options;

    // 1. BM25 recall (already in-memory, fast)
    const searchResults = this.engine.search(query, { limit: 15 });

    // 2. Get recent episodes from engine docs (no file I/O)
    let recentIds = [];
    if (includeRecent && recentCount > 0) {
      const allDocs = [...this.engine.docs.entries()]
        .sort((a, b) => b[1].createdAt - a[1].createdAt)
        .slice(0, recentCount);
      recentIds = allDocs.map(([id]) => id);
    }

    // 3. Merge & deduplicate
    const seen = new Set();
    const merged = [];

    // Add search results first
    for (const r of searchResults) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const doc = this.engine.docs.get(r.id);
      if (!doc) continue;
      if (excludeTags.length && doc.tags.some(t => excludeTags.includes(t))) continue;
      const priorityBoost = priorityTags.length && doc.tags.some(t => priorityTags.includes(t)) ? 1.5 : 1.0;
      merged.push({ id: r.id, score: r.score * priorityBoost, recency: r.recency, doc, isRecent: false });
    }

    // Add recent episodes
    for (const id of recentIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const doc = this.engine.docs.get(id);
      if (!doc) continue;
      if (excludeTags.length && doc.tags.some(t => excludeTags.includes(t))) continue;
      merged.push({ id, score: 0, recency: 1.0, doc, isRecent: true });
    }

    if (merged.length === 0) return '';

    // 4. Load full episodes (only those we'll use)
    const now = Date.now();
    const relevantItems = [];
    const recentItems = [];

    const MAX_EP_CHARS = 300;
    for (const item of merged) {
      const ep = await this._loadEpisode(item.id);
      if (!ep) continue;
      const truncText = ep.text.length > MAX_EP_CHARS
        ? ep.text.slice(0, MAX_EP_CHARS).replace(/\n[^\n]*$/, '') + '...'
        : ep.text;
      const formatted = `[${ep.type}] (${_relativeTime(ep.createdAt, now)}) ${truncText}`;
      if (item.isRecent) {
        recentItems.push(formatted);
      } else {
        relevantItems.push(formatted);
      }
    }

    // 5. Build output with section headers
    let output = '';
    if (relevantItems.length > 0) {
      output += '## Relevant Memories\n';
      output += relevantItems.join('\n') + '\n';
    }
    if (recentItems.length > 0) {
      if (output) output += '\n';
      output += '## Recent Context\n';
      output += recentItems.join('\n') + '\n';
    }

    // 6. Truncate to token budget (LLM tokens ≈ chars / 3.5)
    const estimatedTokens = Math.ceil(output.length / 3.5);
    if (estimatedTokens > maxTokens) {
      const charBudget = Math.floor(maxTokens * 3.5);
      output = output.slice(0, charBudget);
      // Trim to last complete line
      const lastNewline = output.lastIndexOf('\n');
      if (lastNewline > 0) output = output.slice(0, lastNewline + 1);
    }

    return output.trim();
  }

  // ─── v1.3: Compaction Hooks ────────────────────────────────────

  /**
   * Called before context compaction. Summarizes current session state
   * and stores it as an Engram episode for post-compaction retrieval.
   *
   * @param {object} options
   * @param {string} options.sessionSummary - Summary of current session
   * @param {string[]} options.keyDecisions - List of key decisions made
   * @param {string[]} options.pendingTasks - Tasks still in progress
   * @param {object} options.metadata - Additional metadata
   * @returns {string} Episode ID of the compaction checkpoint
   */
  async compactionCheckpoint(options = {}) {
    const {
      sessionSummary = '',
      keyDecisions = [],
      pendingTasks = [],
      metadata = {},
    } = options;

    const parts = [];
    if (sessionSummary) parts.push(`Summary: ${sessionSummary}`);
    if (keyDecisions.length) parts.push(`Key decisions: ${keyDecisions.join('; ')}`);
    if (pendingTasks.length) parts.push(`Pending tasks: ${pendingTasks.join('; ')}`);

    const text = parts.join('\n') || 'Compaction checkpoint (no details provided)';
    const eps = await this.remember(text, {
      type: 'checkpoint',
      tags: ['checkpoint', 'compaction'],
      importance: 0.95,
      metadata: { ...metadata, isCompactionCheckpoint: true, timestamp: Date.now() },
    });

    return eps[0].id;
  }

  /**
   * Called after context compaction. Retrieves the most relevant context
   * to inject into the fresh post-compaction session.
   *
   * @param {object} options
   * @param {number} options.maxTokens - Token budget (default: 3000)
   * @param {number} options.hoursBack - How far back to look (default: 24)
   * @param {boolean} options.includeCheckpoints - Include compaction checkpoints (default: true)
   * @returns {string} Rich context string for post-compaction injection
   */
  async postCompactionContext(options = {}) {
    await this.init();
    const {
      maxTokens = 3000,
      hoursBack = 24,
      includeCheckpoints = true,
    } = options;

    const now = Date.now();
    const cutoff = now - hoursBack * 3600000;

    // Get all episodes from engine docs within time range
    const candidates = [];
    for (const [id, doc] of this.engine.docs) {
      if (doc.createdAt < cutoff) continue;
      candidates.push({ id, doc });
    }

    // Priority ordering
    const TYPE_PRIORITY = {
      checkpoint: 0,
      decision: 1,
      lesson: 2,
      event: 3,
      fact: 4,
      trade: 5,
      position: 6,
      document: 7,
      summary: 8,
      conversation: 9,
      custom: 10,
    };

    candidates.sort((a, b) => {
      const pa = TYPE_PRIORITY[a.doc.type] ?? 10;
      const pb = TYPE_PRIORITY[b.doc.type] ?? 10;
      if (pa !== pb) return pa - pb;
      return b.doc.createdAt - a.doc.createdAt; // newer first within same type
    });

    // Filter out checkpoints if not wanted
    const filtered = includeCheckpoints
      ? candidates
      : candidates.filter(c => c.doc.type !== 'checkpoint');

    // Load and format — truncate each episode to max 300 chars, use LLM token estimate
    const MAX_EP_CHARS = 300;
    let output = '## Post-Compaction Context\n';
    let charCount = output.length;
    const charBudget = Math.floor(maxTokens * 3.5);

    for (const { id } of filtered) {
      const ep = await this._loadEpisode(id);
      if (!ep) continue;
      const truncText = ep.text.length > MAX_EP_CHARS
        ? ep.text.slice(0, MAX_EP_CHARS).replace(/\n[^\n]*$/, '') + '...'
        : ep.text;
      const line = `[${ep.type}] (${_relativeTime(ep.createdAt, now)}) ${truncText}\n`;
      if (charCount + line.length > charBudget) break;
      output += line;
      charCount += line.length;
    }

    return output.trim();
  }

  // ─── v1.3: Hourly Summary ─────────────────────────────────────

  /**
   * Summarize episodes from the last N hours into a single summary episode.
   * Useful for hourly cron jobs that maintain running summaries.
   *
   * @param {number} hours - Hours to look back (default: 1)
   * @param {object} options
   * @param {boolean} options.supersede - Whether to supersede the source episodes (default: false)
   * @returns {object} The summary episode
   */
  async hourlySummary(hours = 1, options = {}) {
    await this.init();
    const { supersede = false } = options;
    const now = Date.now();
    const cutoff = now - hours * 3600000;

    // Get episodes within time window
    const all = await this._loadAllEpisodes();
    const recent = all
      .filter(ep => ep.createdAt >= cutoff && ep.type !== 'summary')
      .sort((a, b) => a.createdAt - b.createdAt);

    if (recent.length === 0) {
      return this.remember(`Hourly summary (${hours}h): No new episodes.`, {
        type: 'summary',
        tags: ['summary', 'hourly'],
        importance: 0.3,
      }).then(eps => eps[0]);
    }

    // Build summary text
    const lines = recent.map(ep => {
      const time = new Date(ep.createdAt).toISOString().slice(11, 16);
      return `[${time}] (${ep.type}) ${ep.text.slice(0, 150)}`;
    });
    const summaryText = `Hourly summary (last ${hours}h, ${recent.length} episodes):\n${lines.join('\n')}`;

    const ids = recent.map(ep => ep.id);
    const supersedes = supersede ? ids : undefined;

    const eps = await this.remember(summaryText, {
      type: 'summary',
      tags: ['summary', 'hourly'],
      importance: 0.7,
      metadata: { summarizedIds: ids, hours },
      supersedes,
    });

    return eps[0];
  }

  /**
   * Create auto-capture hooks for tool calls.
   * @returns {object} hooks object with wrappers
   */
  createHooks() {
    const mem = this;
    return {
      onTrade: (details) => mem.remember(
        `Trade: ${details.action} ${details.amount} ${details.token} at ${details.price}`,
        { type: 'trade', tags: ['trade', details.token], importance: 0.7, metadata: details }
      ),
      onPosition: (details) => mem.remember(
        `Position update: ${details.token} — ${details.description}`,
        { type: 'position', tags: ['position', details.token], importance: 0.6, metadata: details }
      ),
      onAlert: (details) => mem.remember(
        `Alert: ${details.message}`,
        { type: 'alert', tags: ['alert', ...(details.tags || [])], importance: 0.8, metadata: details }
      ),
      onDecision: (details) => mem.remember(
        `Decision: ${details.description} — Rationale: ${details.rationale || 'none given'}`,
        { type: 'decision', tags: ['decision', ...(details.tags || [])], importance: 0.9, metadata: details }
      ),
      onLesson: (details) => mem.remember(
        `Lesson learned: ${details.lesson}`,
        { type: 'lesson', tags: ['lesson', ...(details.tags || [])], importance: 0.85, metadata: details }
      ),
    };
  }
}
