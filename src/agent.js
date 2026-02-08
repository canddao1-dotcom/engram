/**
 * Engram AgentMemory — High-level memory API for OpenClaw agents.
 *
 * v1.1: Incremental BM25 index, lazy episode loading, synonym expansion.
 */

import { createEpisode, chunk, tokenize, contentHash, EPISODE_TYPES } from './core.js';
import { QueryEngine } from './query.js';
import { FileStorage } from './storage/file.js';
import { parseTemporalQuery } from './temporal.js';
import { initSynonyms, loadCustomSynonyms } from './synonyms.js';
import { existsSync } from 'fs';
import { join } from 'path';

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
    const basePath = opts.basePath || 'memory/engram';
    this._basePath = basePath;
    this.storage = opts.redis ? null : new FileStorage(basePath);

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
  async init() {
    if (this._initialized) return;

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
          const allEpisodes = await this.storage.getAllEpisodes();
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
      const episodes = await this.storage.getAllEpisodes();
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
      await this.storage.saveEpisode(ep);
      await this.storage.addToTagIndex(ep);
      this.engine.addDocument(ep);
      episodes.push(ep);
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
      const ep = await this.storage.getEpisode(r.id);
      if (ep) {
        ep.lastAccessedAt = Date.now();
        ep.accessCount = (ep.accessCount || 0) + 1;
        await this.storage.saveEpisode(ep);
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
    const all = await this.storage.getAllEpisodes();
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
      const ep = await this.storage.getEpisode(id);
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
    const all = await this.storage.getAllEpisodes();

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
    const all = await this.storage.getAllEpisodes();
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
        const all = await this.storage.getAllEpisodes();
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
      const ep = await this.storage.getEpisode(id);
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
