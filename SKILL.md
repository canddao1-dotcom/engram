# Engram — Persistent Memory for AI Agents

> Production-grade memory system for OpenClaw agents. Zero dependencies. File-based by default, optional Redis.

## Changelog

### v1.2.0 (2026-02-08)

**Configurable Synonyms** — Synonym groups are now loaded from `config/synonyms.json` instead of being hardcoded. Supports layered loading: built-in defaults → `ENGRAM_SYNONYMS` env var → `<dataDir>/synonyms.json` → explicit `synonymsFile` option → runtime `addSynonymGroup()`. Each layer merges, never replaces.

**Supersession Chains** — Episodes can now supersede other episodes via `supersedes` field. Superseded episodes rank 70% lower in search by default. Use `includeSuperseded: true` for full history. `getSupersessionChain(id)` walks the full chain. CLI: `engram remember "new fact" --supersedes ep_xxx` and `engram chain ep_xxx`.

### v1.1.0 (2026-02-08)

**Incremental BM25 Index** — The BM25 index is now persisted to `memory/engram/index/bm25-index.json` and updated incrementally on startup instead of rebuilding from scratch. Falls back to full rebuild if the index is missing or corrupt.

**Domain Synonym Expansion** — BM25 queries now expand terms using domain-aware synonym groups (Flare ecosystem tokens, DeFi concepts, protocol names). "FXRP allocation" now matches episodes containing "Flare XRP position". Original terms weighted 1.0, synonyms weighted 0.5. Custom synonyms supported via `addSynonymGroup()` or JSON file.

**Lazy Episode Loading** — Episodes are loaded on-demand from disk only when they appear in search results, rather than all being held in memory.

## Quick Start

```javascript
import { AgentMemory } from './skills/engram/src/index.js';

const mem = new AgentMemory({ agentId: 'my-agent' });

// Store
await mem.remember('User prefers dark mode', { type: 'fact', tags: ['preferences'] });

// Search (BM25 + recency boosting)
const results = await mem.recall('user preferences');

// Supersede old info
await mem.rememberSuperseding('User prefers light mode now', [results[0].id]);

// Build LLM context
const context = await mem.buildContext('current settings', { maxTokens: 2000 });
```

## CLI Usage

```bash
cd skills/engram

# Store a memory
node scripts/engram.js remember "User prefers dark mode" --type fact --tags preferences,ui

# Store with supersession
node scripts/engram.js remember "FXRP price is 3.0" --supersedes ep_default_123_abc

# Show supersession chain
node scripts/engram.js chain ep_default_123_abc

# Search
node scripts/engram.js recall "user preferences" --limit 5

# Statistics
node scripts/engram.js stats
```

## Configurable Synonyms

Default synonyms live in `config/synonyms.json`. Loading order (each merges):

1. **Built-in defaults** — `config/synonyms.json`
2. **Environment variable** — `ENGRAM_SYNONYMS=/path/to/custom.json`
3. **Agent data dir** — `<basePath>/synonyms.json` (auto-loaded if exists)
4. **Constructor option** — `new AgentMemory({ synonymsFile: '/path/to/file.json' })`
5. **Runtime** — `addSynonymGroup(['term1', 'term2', 'term3'])`

### Custom synonyms file format

```json
{
  "groups": [
    ["myToken", "MY", "My Token"],
    ["protocol", "proto", "the protocol"]
  ]
}
```

Or flat array format: `[["term1", "term2"], ["term3", "term4"]]`

### Agent-specific vocabulary

Place a `synonyms.json` in your agent's data directory (`<basePath>/synonyms.json`). It will be auto-loaded on init, merged with defaults.

## Supersession Chains

When facts change, supersede old episodes instead of deleting them:

```javascript
// Original
const [old] = await mem.remember('BTC price is 50k');

// Correction — old episode gets supersededBy field, ranks lower in search
const [updated] = await mem.remember('BTC price is 60k', { supersedes: [old.id] });

// Convenience method
const [v3] = await mem.rememberSuperseding('BTC price is 65k', [updated.id]);

// View the chain
const chain = await mem.getSupersessionChain(old.id);
// → [old, updated, v3]

// Include superseded in search (full history)
const all = await mem.recall('BTC price', { includeSuperseded: true });
```

Superseded episodes get their score multiplied by 0.3 by default, so current info always ranks first.

## API Reference

### `new AgentMemory(opts)`

| Option | Default | Description |
|--------|---------|-------------|
| `agentId` | `'default'` | Agent identifier |
| `basePath` | `'memory/engram'` | Storage directory |
| `synonymsFile` | `null` | Path to custom synonyms JSON |
| `recencyWeight` | `0.3` | 0-1, recency vs BM25 weight |
| `synonymWeight` | `0.5` | Weight for synonym matches |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `remember(text, opts)` | `Episode[]` | Store with auto-chunking |
| `recall(query, opts)` | `Episode[]` | BM25 search + recency boost |
| `rememberSuperseding(text, oldIds, opts)` | `Episode[]` | Store + mark old as superseded |
| `getSupersessionChain(id)` | `Episode[]` | Get full supersession chain |
| `buildContext(query, opts)` | `string` | LLM-ready context string |
| `getRecent(limit)` | `Episode[]` | Latest memories |
| `forget(id)` | `boolean` | Delete a memory |
| `getStats()` | `object` | Memory statistics |
| `prune(opts)` | `{ pruned }` | Cleanup old/low-importance |
| `temporal(query, opts)` | `Episode[]` | Natural language time queries |

### Episode Schema (v1.2)

```json
{
  "id": "ep_default_1707000000_abc123",
  "text": "FXRP price is 3.0 USDT",
  "type": "fact",
  "tags": ["fxrp"],
  "importance": 0.5,
  "supersedes": ["ep_default_1706000000_def456"],
  "supersededBy": ["ep_default_1708000000_ghi789"],
  "createdAt": 1707000000000,
  "tokens": ["fxrp", "price", "3.0", "usdt"]
}
```
