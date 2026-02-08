/**
 * Engram Synonyms — Domain-aware query expansion for BM25 search.
 * Zero dependencies.
 *
 * v1.2: Configurable synonyms. Loading order:
 *   built-in defaults (config/synonyms.json) → ENGRAM_SYNONYMS env → agent dataDir → explicit file → runtime addSynonymGroup()
 */

import { readFileSync } from 'fs';
import { readFile as readFileAsync } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYNONYMS_PATH = join(__dirname, '..', 'config', 'synonyms.json');

// Runtime synonym groups (loaded lazily)
let _groups = null;
let _lookup = null;
let _defaultsLoaded = false;

/**
 * Load built-in defaults synchronously (fallback for when expandQuery is called before async init).
 */
function _loadDefaultsSync() {
  if (_defaultsLoaded) return;
  if (!_groups) _groups = [];
  try {
    const data = readFileSync(DEFAULT_SYNONYMS_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    const groups = parsed.groups || [];
    for (const group of groups) {
      if (Array.isArray(group) && group.length >= 2) {
        _groups.push(group);
      }
    }
  } catch {
    // config file missing — no defaults
  }
  _defaultsLoaded = true;
  _lookup = null;
}

/**
 * Initialize synonyms asynchronously — loads defaults + env file.
 * Called automatically by AgentMemory.init().
 */
export async function initSynonyms() {
  if (_defaultsLoaded) return; // already initialized
  _groups = [];
  _lookup = null;

  // 1. Load built-in defaults from config/synonyms.json
  await _mergeFromFile(DEFAULT_SYNONYMS_PATH);
  _defaultsLoaded = true;

  // 2. Load from ENGRAM_SYNONYMS env variable
  if (process.env.ENGRAM_SYNONYMS) {
    await _mergeFromFile(process.env.ENGRAM_SYNONYMS);
  }
}

/**
 * Merge synonym groups from a JSON file. Supports both formats:
 *   { "groups": [...] }   or   [ [...], [...] ]
 */
async function _mergeFromFile(filePath) {
  try {
    const data = await readFileAsync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    const groups = Array.isArray(parsed) ? parsed : (parsed.groups || []);
    for (const group of groups) {
      if (Array.isArray(group) && group.length >= 2) {
        _groups.push(group);
      }
    }
    _lookup = null; // invalidate cache
  } catch {
    // silently ignore missing/invalid file
  }
}

function _ensureGroups() {
  if (!_groups || (!_defaultsLoaded && _groups.length === 0)) {
    _loadDefaultsSync();
  }
}

function _buildLookup() {
  _ensureGroups();
  _lookup = new Map();
  for (const group of _groups) {
    const lowerGroup = group.map(t => t.toLowerCase());
    for (const term of lowerGroup) {
      const synonyms = lowerGroup.filter(t => t !== term);
      const existing = _lookup.get(term);
      if (existing) {
        for (const s of synonyms) existing.add(s);
      } else {
        _lookup.set(term, new Set(synonyms));
      }
    }
  }
}

function getLookup() {
  if (!_lookup) _buildLookup();
  return _lookup;
}

/**
 * Expand a query string with synonym terms.
 * Returns { original: string[], expanded: string[] } where expanded contains
 * only the NEW synonym terms (not already in original).
 */
export function expandQuery(query) {
  const lookup = getLookup();
  const lowerQuery = query.toLowerCase();
  const originalTerms = lowerQuery.split(/\s+/).filter(Boolean);
  const expandedSet = new Set();

  // Check multi-word phrases first (longest match), then single words
  const sortedKeys = [...lookup.keys()].sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    if (lowerQuery.includes(key)) {
      const synonyms = lookup.get(key);
      for (const syn of synonyms) {
        for (const word of syn.split(/\s+/)) {
          if (!originalTerms.includes(word)) {
            expandedSet.add(word);
          }
        }
      }
    }
  }

  return {
    original: originalTerms,
    expanded: [...expandedSet],
  };
}

/**
 * Add a custom synonym group at runtime.
 * @param {string[]} terms
 */
export function addSynonymGroup(terms) {
  if (!Array.isArray(terms) || terms.length < 2) return;
  _ensureGroups();
  _groups.push(terms);
  _lookup = null; // invalidate cache
}

/**
 * Load custom synonym groups from a JSON file (merges with existing).
 * Supports both formats: { "groups": [...] } or [ [...], [...] ]
 * @param {string} filePath
 */
export async function loadCustomSynonyms(filePath) {
  _ensureGroups();
  await _mergeFromFile(filePath);
}

/**
 * Get current synonym group count (for testing/debugging).
 */
export function getSynonymGroupCount() {
  _ensureGroups();
  return _groups.length;
}
