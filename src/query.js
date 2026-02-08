/**
 * Engram QueryEngine — BM25 search with recency boosting, tag filtering, time ranges.
 *
 * v1.1: Incremental BM25 index, lazy episode loading, synonym expansion.
 */

import { tokenize, termFrequencies, idf, bm25Score } from './core.js';
import { expandQuery } from './synonyms.js';

export class QueryEngine {
  /**
   * @param {object} opts
   * @param {number} opts.recencyWeight - 0-1, how much recency matters vs BM25 (default 0.3)
   * @param {number} opts.recencyLambda - decay rate for recency (default 0.1 = ~10 day half-life)
   * @param {number} opts.importanceDecay - daily decay factor (default 0.95)
   * @param {number} opts.synonymWeight - weight for synonym matches vs original (default 0.5)
   */
  constructor(opts = {}) {
    this.recencyWeight = opts.recencyWeight ?? 0.3;
    this.recencyLambda = opts.recencyLambda ?? 0.1;
    this.importanceDecay = opts.importanceDecay ?? 0.95;
    this.synonymWeight = opts.synonymWeight ?? 0.5;

    // Index state — lightweight: no full episode text in memory
    this.docs = new Map();       // id -> { tf, dl, createdAt, importance, lastAccessedAt, tags, type }
    this.df = new Map();         // term -> document frequency
    this.totalDocs = 0;
    this.totalLength = 0;
    this.lastIndexedTimestamp = 0;
  }

  /** Average document length */
  get avgdl() {
    return this.totalDocs > 0 ? this.totalLength / this.totalDocs : 1;
  }

  /**
   * Add a document (episode) to the index.
   * Stores only index-relevant data (tf, dl, metadata) — NOT full text/tokens.
   * @param {object} episode
   */
  addDocument(episode) {
    const { id, tokens, createdAt, importance, lastAccessedAt, tags, type } = episode;
    if (this.docs.has(id)) return; // already indexed

    const tf = termFrequencies(tokens);
    const dl = tokens.length;

    // Update document frequencies
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }

    // Store only index metadata — no tokens array (lazy loading)
    this.docs.set(id, { dl, tf, createdAt, importance: importance ?? 0.5, lastAccessedAt: lastAccessedAt ?? createdAt, tags: tags || [], type });
    this.totalDocs++;
    this.totalLength += dl;

    // Track latest indexed timestamp
    if (createdAt > this.lastIndexedTimestamp) {
      this.lastIndexedTimestamp = createdAt;
    }
  }

  /**
   * Remove a document from the index.
   */
  removeDocument(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.tf.keys()) {
      const c = this.df.get(term);
      if (c <= 1) this.df.delete(term);
      else this.df.set(term, c - 1);
    }
    this.totalDocs--;
    this.totalLength -= doc.dl;
    this.docs.delete(id);
  }

  /**
   * Rebuild the entire index from episodes array.
   * @param {object[]} episodes
   */
  rebuild(episodes) {
    this.docs.clear();
    this.df.clear();
    this.totalDocs = 0;
    this.totalLength = 0;
    this.lastIndexedTimestamp = 0;
    for (const ep of episodes) this.addDocument(ep);
  }

  /**
   * Restore index state from a persisted BM25 index (no episodes needed).
   * @param {object} indexData - { df, docLengths, docMeta, totalDocs, totalLength, lastIndexedTimestamp }
   */
  restoreFromIndex(indexData) {
    this.df = indexData.df;
    this.totalDocs = indexData.totalDocs;
    this.totalLength = indexData.totalLength;
    this.lastIndexedTimestamp = indexData.lastIndexedTimestamp || 0;

    // Rebuild docs map from persisted data
    this.docs.clear();
    for (const [id, dl] of indexData.docLengths) {
      const meta = indexData.docMeta.get(id);
      const parsed = meta ? JSON.parse(meta) : {};
      this.docs.set(id, {
        dl,
        tf: new Map(), // tf not persisted — BM25 uses df for scoring, tf reconstructed on search if needed
        createdAt: parsed.createdAt || 0,
        importance: parsed.importance ?? 0.5,
        lastAccessedAt: parsed.lastAccessedAt || 0,
        tags: parsed.tags || [],
        type: parsed.type || 'fact',
      });
    }
  }

  /**
   * Export index state for persistence.
   * @returns {object}
   */
  exportIndex() {
    const docLengths = new Map();
    const docMeta = new Map();
    for (const [id, doc] of this.docs) {
      docLengths.set(id, doc.dl);
      docMeta.set(id, JSON.stringify({
        createdAt: doc.createdAt,
        importance: doc.importance,
        lastAccessedAt: doc.lastAccessedAt,
        tags: doc.tags,
        type: doc.type,
      }));
    }
    return {
      df: this.df,
      docLengths,
      docMeta,
      totalDocs: this.totalDocs,
      totalLength: this.totalLength,
      lastIndexedTimestamp: this.lastIndexedTimestamp,
    };
  }

  /**
   * Check if index has term frequencies loaded (needed for search).
   * After restoreFromIndex, TFs are empty — need full rebuild or addDocument for search.
   */
  get hasTF() {
    if (this.docs.size === 0) return true;
    const first = this.docs.values().next().value;
    return first && first.tf && first.tf.size > 0;
  }

  /**
   * Search the index.
   * @param {string} query
   * @param {object} opts
   * @param {number} opts.limit
   * @param {string[]} opts.tags - filter by tags (AND logic)
   * @param {string} opts.type - filter by episode type
   * @param {number} opts.after - timestamp, only episodes after this
   * @param {number} opts.before - timestamp, only episodes before this
   * @param {number} opts.minImportance - minimum current importance score
   * @param {boolean} opts.useSynonyms - enable synonym expansion (default true)
   * @returns {{ id: string, score: number, bm25: number, recency: number }[]}
   */
  search(query, opts = {}) {
    const { limit = 10, tags, type, after, before, minImportance, useSynonyms = true } = opts;
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    // Synonym expansion
    let synonymTokens = [];
    if (useSynonyms) {
      const { expanded } = expandQuery(query);
      synonymTokens = expanded.map(t => tokenize(t)).flat().filter(t => !queryTokens.includes(t));
    }

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const results = [];

    for (const [id, doc] of this.docs) {
      // Tag filter
      if (tags?.length && !tags.every(t => doc.tags.includes(t))) continue;
      // Type filter
      if (type && doc.type !== type) continue;
      // Time range filter
      if (after && doc.createdAt < after) continue;
      if (before && doc.createdAt > before) continue;

      // Importance with decay
      const daysSinceAccess = (now - doc.lastAccessedAt) / DAY_MS;
      const currentImportance = doc.importance * Math.pow(this.importanceDecay, daysSinceAccess);
      if (minImportance && currentImportance < minImportance) continue;

      // BM25 score — original terms (weight 1.0)
      let bm25 = 0;
      for (const term of queryTokens) {
        const tf = doc.tf.get(term) || 0;
        if (tf === 0) continue;
        const termDf = this.df.get(term) || 0;
        const termIdf = idf(termDf, this.totalDocs);
        bm25 += bm25Score(tf, doc.dl, this.avgdl, termIdf);
      }

      // BM25 score — synonym terms (weighted lower)
      let synonymBm25 = 0;
      if (synonymTokens.length > 0) {
        for (const term of synonymTokens) {
          const tf = doc.tf.get(term) || 0;
          if (tf === 0) continue;
          const termDf = this.df.get(term) || 0;
          const termIdf = idf(termDf, this.totalDocs);
          synonymBm25 += bm25Score(tf, doc.dl, this.avgdl, termIdf);
        }
      }

      const totalBm25 = bm25 + synonymBm25 * this.synonymWeight;
      if (totalBm25 === 0) continue; // no matching terms at all

      // Recency score (exponential decay)
      const daysSinceCreation = (now - doc.createdAt) / DAY_MS;
      const recency = Math.exp(-this.recencyLambda * daysSinceCreation);

      // Combined score
      const score = (1 - this.recencyWeight) * totalBm25 + this.recencyWeight * recency;

      // Boost by importance
      const finalScore = score * (0.5 + currentImportance);

      results.push({ id, score: finalScore, bm25: totalBm25, recency });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
