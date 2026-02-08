/**
 * Engram RedisStorage — Upstash Redis compatible storage backend.
 * Optional: only used if redis config is provided.
 * Uses Upstash REST API (no npm dependencies).
 */

export class RedisStorage {
  /**
   * @param {{ url: string, token: string, prefix?: string }} config
   */
  constructor(config) {
    this.url = config.url;
    this.token = config.token;
    this.prefix = config.prefix || 'engram:';
  }

  async _cmd(...args) {
    const res = await fetch(`${this.url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    if (json.error) throw new Error(`Redis: ${json.error}`);
    return json.result;
  }

  async init() { /* no-op for Redis */ }

  _key(id) { return `${this.prefix}ep:${id}`; }

  async saveEpisode(episode) {
    await this._cmd('SET', this._key(episode.id), JSON.stringify(episode));
    await this._cmd('SADD', `${this.prefix}ids`, episode.id);
    for (const tag of episode.tags || []) {
      await this._cmd('SADD', `${this.prefix}tag:${tag}`, episode.id);
    }
  }

  async getEpisode(id) {
    const data = await this._cmd('GET', this._key(id));
    return data ? JSON.parse(data) : null;
  }

  async deleteEpisode(id) {
    const ep = await this.getEpisode(id);
    if (!ep) return false;
    await this._cmd('DEL', this._key(id));
    await this._cmd('SREM', `${this.prefix}ids`, id);
    for (const tag of ep.tags || []) {
      await this._cmd('SREM', `${this.prefix}tag:${tag}`, id);
    }
    return true;
  }

  async getAllEpisodes() {
    const ids = await this._cmd('SMEMBERS', `${this.prefix}ids`) || [];
    const episodes = [];
    for (const id of ids) {
      const ep = await this.getEpisode(id);
      if (ep) episodes.push(ep);
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

  async addToTagIndex(episode) { /* handled in saveEpisode */ }
  async removeFromTagIndex(id) { /* handled in deleteEpisode */ }

  async getByTag(tag) {
    return await this._cmd('SMEMBERS', `${this.prefix}tag:${tag}`) || [];
  }

  async getStats() {
    const ids = await this._cmd('SMEMBERS', `${this.prefix}ids`) || [];
    return { episodeCount: ids.length, storagePath: this.url };
  }
}
