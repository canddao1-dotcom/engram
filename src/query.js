/**
 * Engram QueryEngine — BM25 search with recency boosting, tag filtering, time ranges.
 */

import { tokenize, termFrequencies, idf, bm25Score } from './core.js';

export class QueryEngine {
  /**
   * @param {object} opts
   * @param {number} opts.recencyWeight - 0-1, how much recency matters vs BM25 (default 0.3)
   * @param {number} opts.recencyLambda - decay rate for recency (default 0.1 = ~10 day half-life)
   * @param {number} opts.importanceDecay - daily decay factor (default 0.95)
   */
  constructor(opts = {}) {
    this.recencyWeight = opts.recencyWeight ?? 0.3;
    this.recencyLambda = opts.recencyLambda ?? 0.1;
    this.importanceDecay = opts.importanceDecay ?? 0.95;

    // Index state
    this.docs = new Map();       // id -> { tokens, dl, tf, createdAt, importance, lastAccessedAt, tags, type }
    this.df = new Map();         // term -> document frequency
    this.totalDocs = 0;
    this.totalLength = 0;
  }

  /** Average document length */
  get avgdl() {
    return this.totalDocs > 0 ? this.totalLength / this.totalDocs : 1;
  }

  /**
   * Add a document (episode) to the index.
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

    this.docs.set(id, { tokens, dl, tf, createdAt, importance: importance ?? 0.5, lastAccessedAt: lastAccessedAt ?? createdAt, tags: tags || [], type });
    this.totalDocs++;
    this.totalLength += dl;
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
    for (const ep of episodes) this.addDocument(ep);
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
   * @returns {{ id: string, score: number, bm25: number, recency: number }[]}
   */
  search(query, opts = {}) {
    const { limit = 10, tags, type, after, before, minImportance } = opts;
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

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

      // BM25 score
      let bm25 = 0;
      for (const term of queryTokens) {
        const tf = doc.tf.get(term) || 0;
        if (tf === 0) continue;
        const termDf = this.df.get(term) || 0;
        const termIdf = idf(termDf, this.totalDocs);
        bm25 += bm25Score(tf, doc.dl, this.avgdl, termIdf);
      }
      if (bm25 === 0) continue; // no matching terms at all

      // Recency score (exponential decay)
      const daysSinceCreation = (now - doc.createdAt) / DAY_MS;
      const recency = Math.exp(-this.recencyLambda * daysSinceCreation);

      // Combined score
      const score = (1 - this.recencyWeight) * bm25 + this.recencyWeight * recency;

      // Boost by importance
      const finalScore = score * (0.5 + currentImportance);

      results.push({ id, score: finalScore, bm25, recency });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
