/**
 * Engram FileStorage — JSON file-based storage backend.
 * Episodes stored as individual JSON files. Zero dependencies.
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

  async updateEpisode(id, updates) {
    const ep = await this.getEpisode(id);
    if (!ep) return null;
    Object.assign(ep, updates);
    await this.saveEpisode(ep);
    return ep;
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
