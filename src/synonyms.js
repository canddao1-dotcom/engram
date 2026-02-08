/**
 * Engram Synonyms — Domain-aware query expansion for BM25 search.
 * Zero dependencies.
 */

import { readFile } from 'fs/promises';

// Domain-aware synonym groups
const SYNONYM_GROUPS = [
  // Flare ecosystem tokens
  ['FXRP', 'Flare XRP', 'FAsset XRP'],
  ['sFLR', 'staked FLR', 'Sceptre FLR', 'liquid staked FLR'],
  ['WFLR', 'wrapped FLR', 'wrapped Flare'],
  ['FLR', 'Flare', 'Flare token'],
  ['USDT0', 'USD₮0', 'Tether', 'USDT'],
  ['CDP', 'CDP Dollar', 'Enosys Dollar'],
  ['BANK', 'FlareBank token', 'FB token'],
  ['stXRP', 'staked XRP'],
  ['earnXRP', 'Upshift XRP', 'FXRP vault shares'],
  ['rFLR', 'reward FLR'],

  // DeFi concepts
  ['LP', 'liquidity position', 'liquidity provider', 'pool position'],
  ['APY', 'annual yield', 'yearly return', 'annual percentage yield'],
  ['APR', 'annual rate', 'annual percentage rate'],
  ['TVL', 'total value locked', 'total liquidity'],
  ['IL', 'impermanent loss', 'divergence loss'],
  ['arb', 'arbitrage', 'arb opportunity'],
  ['swap', 'trade', 'exchange', 'token swap'],
  ['mint', 'create', 'issue'],
  ['burn', 'redeem', 'destroy'],
  ['stake', 'staking', 'delegate'],
  ['unstake', 'unstaking', 'undelegate', 'withdraw stake'],
  ['bridge', 'cross-chain transfer', 'bridging'],
  ['slippage', 'price impact'],

  // Protocols
  ['Enosys', 'Enosys DEX', 'Enosys V3'],
  ['SparkDex', 'Spark DEX', 'SparkDex V3'],
  ['Blazeswap', 'Blaze swap', 'Blazeswap V2'],
  ['Sceptre', 'Sceptre Finance', 'sFLR protocol'],
  ['Spectra', 'Spectra Finance', 'PT/YT', 'yield trading'],
  ['Upshift', 'Upshift Finance', 'earnXRP vault'],
  ['Rysk', 'Rysk Finance', 'covered calls'],

  // Position types
  ['V3 position', 'concentrated liquidity', 'V3 LP', 'CL position'],
  ['stability pool', 'SP deposit', 'CDP stability'],
  ['covered call', 'CC position', 'short call'],

  // Actions
  ['rebalance', 'adjust position', 'reposition'],
  ['compound', 'reinvest', 'auto-compound'],
  ['claim', 'harvest', 'collect rewards'],
  ['deposit', 'add liquidity', 'provide liquidity'],
  ['withdraw', 'remove liquidity', 'pull out'],
];

// Runtime synonym groups (built-in + custom)
const _groups = [...SYNONYM_GROUPS];

// Build lookup: lowercased term/phrase → Set of synonyms
let _lookup = null;

function _buildLookup() {
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
  // Sort lookup keys by length descending for greedy matching
  const sortedKeys = [...lookup.keys()].sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    if (lowerQuery.includes(key)) {
      const synonyms = lookup.get(key);
      for (const syn of synonyms) {
        // Add individual words from synonym phrases
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
  _groups.push(terms);
  _lookup = null; // invalidate cache
}

/**
 * Load custom synonym groups from a JSON file.
 * Expected format: array of arrays of strings.
 * @param {string} filePath
 */
export async function loadCustomSynonyms(filePath) {
  try {
    const data = await readFile(filePath, 'utf-8');
    const groups = JSON.parse(data);
    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (Array.isArray(group) && group.length >= 2) {
          _groups.push(group);
        }
      }
      _lookup = null; // invalidate cache
    }
  } catch {
    // silently ignore missing/invalid file
  }
}
