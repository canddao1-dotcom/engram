/**
 * Engram FileStorage — JSON file-based storage backend.
 * Episodes stored as individual JSON files. Zero dependencies.
 *
 * v1.1: Persistent BM25 index, incremental updates, lazy episode loading.
 */

import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'fs/promises';
import { join } from 'path';

export class FileStorage {
  /**
   * @param {string} basePath - base directory for Engram data (e.g., 'memory/engram')
   */
  constructor(basePath = 'memory/engram') {
    this.basePath = basePath;
    this.episodesDir = join(basePath, 'episodes');
    this.indexDir = join(basePath, 'index');
    this._bm25IndexPath = join(basePath, 'index', 'bm25-index.json');
  }

  async init() {
    await mkdir(this.episodesDir, { recursive: true });
    await mkdir(this.indexDir, { recursive: true });
  }

  // ─── Episode CRUD ────────────────────────────────────────────

  _episodePath(id) {
    return join(this.episodesDir, `${id}.json`);
  }

  async saveEpisode(episode) {
    await this.init();
    const path = this._episodePath(episode.id);
    await writeFile(path, JSON.stringify(episode, null, 2));
  }

  async getEpisode(id) {
    try {
      const data = await readFile(this._episodePath(id), 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async deleteEpisode(id) {
    try {
      await unlink(this._episodePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async getAllEpisodes() {
    await this.init();
    const files = await readdir(this.episodesDir);
    const episodes = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = await readFile(join(this.episodesDir, f), 'utf-8');
        episodes.push(JSON.parse(data));
      } catch {
        // skip corrupted files
      }
    }
    return episodes;
  }

  /**
   * Get episodes newer than a timestamp (for incremental indexing).
   * @param {number} afterTimestamp
   * @returns {object[]}
   */
  async getEpisodesSince(afterTimestamp) {
    await this.init();
    const files = await readdir(this.episodesDir);
    const episodes = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = await readFile(join(this.episodesDir, f), 'utf-8');
        const ep = JSON.parse(data);
        if (ep.createdAt > afterTimestamp) episodes.push(ep);
      } catch {
        // skip corrupted
      }
    }
    return episodes;
  }

  /**
   * List all episode IDs without loading full content.
   * @returns {string[]}
   */
  async listEpisodeIds() {
    await this.init();
    const files = await readdir(this.episodesDir);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  }

  async updateEpisode(id, updates) {
    const ep = await this.getEpisode(id);
    if (!ep) return null;
    Object.assign(ep, updates);
    await this.saveEpisode(ep);
    return ep;
  }

  // ─── BM25 Index Persistence ──────────────────────────────────

  /**
   * Save the BM25 index to disk.
   * @param {object} indexData - { df, docLengths, totalDocs, totalLength, lastIndexedTimestamp }
   */
  async saveBM25Index(indexData) {
    await this.init();
    const serializable = {
      df: Object.fromEntries(indexData.df),
      docLengths: Object.fromEntries(indexData.docLengths),
      docMeta: Object.fromEntries(indexData.docMeta),
      totalDocs: indexData.totalDocs,
      totalLength: indexData.totalLength,
      lastIndexedTimestamp: indexData.lastIndexedTimestamp,
      version: '1.1',
    };
    await writeFile(this._bm25IndexPath, JSON.stringify(serializable));
  }

  /**
   * Load the BM25 index from disk.
   * @returns {object|null} - null if missing or corrupt
   */
  async loadBM25Index() {
    try {
      const data = await readFile(this._bm25IndexPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!parsed.version || !parsed.df || !parsed.docLengths) return null;
      return {
        df: new Map(Object.entries(parsed.df).map(([k, v]) => [k, Number(v)])),
        docLengths: new Map(Object.entries(parsed.docLengths).map(([k, v]) => [k, Number(v)])),
        docMeta: new Map(Object.entries(parsed.docMeta || {})),
        totalDocs: parsed.totalDocs,
        totalLength: parsed.totalLength,
        lastIndexedTimestamp: parsed.lastIndexedTimestamp,
      };
    } catch {
      return null;
    }
  }

  // ─── Tag Index ───────────────────────────────────────────────

  async loadTagIndex() {
    try {
      const data = await readFile(join(this.indexDir, 'tags.json'), 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async saveTagIndex(index) {
    await writeFile(join(this.indexDir, 'tags.json'), JSON.stringify(index));
  }

  async addToTagIndex(episode) {
    const index = await this.loadTagIndex();
    for (const tag of episode.tags || []) {
      if (!index[tag]) index[tag] = [];
      if (!index[tag].includes(episode.id)) index[tag].push(episode.id);
    }
    await this.saveTagIndex(index);
  }

  async removeFromTagIndex(id) {
    const index = await this.loadTagIndex();
    for (const tag of Object.keys(index)) {
      index[tag] = index[tag].filter(eid => eid !== id);
      if (!index[tag].length) delete index[tag];
    }
    await this.saveTagIndex(index);
  }

  async getByTag(tag) {
    const index = await this.loadTagIndex();
    return index[tag] || [];
  }

  // ─── Stats ───────────────────────────────────────────────────

  async getStats() {
    const files = await readdir(this.episodesDir).catch(() => []);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    let totalSize = 0;
    for (const f of jsonFiles) {
      try {
        const s = await stat(join(this.episodesDir, f));
        totalSize += s.size;
      } catch {}
    }
    return {
      episodeCount: jsonFiles.length,
      totalSizeBytes: totalSize,
      storagePath: this.basePath,
    };
  }
}
