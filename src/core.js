/**
 * Engram Core — Tokenizer, Chunker, BM25 Math, Episode utilities
 * Zero dependencies. Pure Node.js.
 */

import { createHash, randomBytes } from 'crypto';

// ─── Episode Types ───────────────────────────────────────────────
export const EPISODE_TYPES = {
  // Generic
  fact: 'fact',
  conversation: 'conversation',
  document: 'document',
  event: 'event',
  custom: 'custom',
  summary: 'summary',
  // Domain-specific (DeFi)
  trade: 'trade',
  position: 'position',
  alert: 'alert',
  decision: 'decision',
  lesson: 'lesson',
  checkpoint: 'checkpoint',
};

// ─── Tokenizer ───────────────────────────────────────────────────
// Simple stemming: strip common suffixes
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'i','me','my','we','our','you','your','he','him','his','she','her','it','its',
  'they','them','their','this','that','these','those','am','in','on','at','to','for',
  'of','with','by','from','as','into','through','during','before','after','above',
  'below','between','and','but','or','nor','not','no','so','if','then','than','too',
  'very','just','about','up','out','off','over','under','again','further','once',
]);

function stemLight(word) {
  // Very lightweight suffix stripping — not Porter, just good enough
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('tion') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ment') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ness') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ful') && word.length > 4) return word.slice(0, -3);
  if (word.endsWith('less') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('able') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ible') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('er') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('est') && word.length > 4) return word.slice(0, -3);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * Tokenize text into stemmed, lowercased, stop-word-filtered tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  const words = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.filter(w => !STOP_WORDS.has(w) && w.length > 1).map(stemLight);
}

/**
 * Get term frequencies for a token list.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
export function termFrequencies(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// ─── Chunker ─────────────────────────────────────────────────────

/**
 * Split text into chunks.
 * @param {string} text
 * @param {{ mode?: 'sentence'|'paragraph'|'fixed', maxTokens?: number, overlap?: number }} opts
 * @returns {string[]}
 */
export function chunk(text, opts = {}) {
  const { mode = 'sentence', maxTokens = 256, overlap = 32 } = opts;

  if (mode === 'paragraph') {
    const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    return paras.length ? paras : [text];
  }

  if (mode === 'sentence') {
    // Split on sentence boundaries
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if (tokenize(current + s).length > maxTokens && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  // Fixed token splits with overlap
  const tokens = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < tokens.length; i += maxTokens - overlap) {
    chunks.push(tokens.slice(i, i + maxTokens).join(' '));
  }
  return chunks;
}

// ─── BM25 Math ───────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;

/**
 * Compute IDF for a term given corpus stats.
 * @param {number} df - document frequency (how many docs contain the term)
 * @param {number} N - total documents
 * @returns {number}
 */
export function idf(df, N) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * BM25 score for a single term in a document.
 * @param {number} tf - term frequency in document
 * @param {number} dl - document length (tokens)
 * @param {number} avgdl - average document length
 * @param {number} termIdf - precomputed IDF
 * @returns {number}
 */
export function bm25Score(tf, dl, avgdl, termIdf) {
  const num = tf * (K1 + 1);
  const den = tf + K1 * (1 - B + B * dl / avgdl);
  return termIdf * num / den;
}

// ─── Episode ─────────────────────────────────────────────────────

/**
 * Generate a unique episode ID.
 * @param {string} agentId
 * @returns {string}
 */
export function generateEpisodeId(agentId = 'default') {
  const ts = Date.now();
  const hash = randomBytes(4).toString('hex');
  return `ep_${agentId}_${ts}_${hash}`;
}

/**
 * Create an episode object.
 * @param {string} text
 * @param {object} opts
 * @returns {object}
 */
export function createEpisode(text, opts = {}) {
  const now = Date.now();
  const {
    type = 'fact',
    tags = [],
    importance = 0.5,
    agentId = 'default',
    metadata = {},
    chunkIndex = 0,
    totalChunks = 1,
    sourceId = null,
    supersedes = null,
  } = opts;

  const episode = {
    id: generateEpisodeId(agentId),
    text,
    type,
    tags: Array.isArray(tags) ? tags : [tags],
    importance,
    agentId,
    metadata,
    chunkIndex,
    totalChunks,
    sourceId,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    tokens: tokenize(text),
  };

  if (supersedes && Array.isArray(supersedes) && supersedes.length > 0) {
    episode.supersedes = supersedes;
  }

  return episode;
}

/**
 * Compute content hash for dedup.
 */
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
