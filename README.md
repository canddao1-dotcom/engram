# Engram — Persistent Memory for AI Agents

> Production-grade memory system for OpenClaw agents. Zero dependencies. File-based by default, optional Redis.

## Changelog

### v1.3.1 (2026-02-08)

**Token Budget Fix** — Episodes truncated to 300 chars in context building. Token estimation uses chars/3.5 for more accurate LLM token counts. Prevents context injection from blowing past budget limits.

### v1.3.0 (2026-02-08)

**Pre-prompt Injection** — `inject(query, opts)` returns a ready-to-use context block with token budget awareness. Integrates with OpenClaw's compaction and heartbeat flows.

**Session Transcript Digestion** — `digest(file)` reads JSONL session transcripts and extracts key episodes (decisions, errors, tool results) automatically.

**Compaction Hooks** — `checkpoint()` creates a compaction episode summarizing recent activity. `post-compaction` command provides context for fresh sessions after memory compaction.

**Hourly Summaries** — `hourly-summary` command creates periodic roll-up episodes to reduce noise from high-frequency events.

### v1.2.0 (2026-02-08)

**Configurable Synonyms** — Synonym groups extracted to `config/synonyms.json`. Layered loading: built-in defaults → `ENGRAM_SYNONYMS` env → `<dataDir>/synonyms.json` → explicit `synonymsFile` option → runtime `addSynonymGroup()`. Each layer merges.

**Supersession Chains** — Episodes can supersede others via `supersedes` field for conflict resolution. Superseded episodes rank 70% lower. `getSupersessionChain(id)` traces the full history. CLI: `--supersedes` flag and `chain` command.

### v1.1.0 (2026-02-08)

**Incremental BM25 Index** — The BM25 index is now persisted to `memory/engram/index/bm25-index.json` and updated incrementally on startup instead of rebuilding from scratch. Falls back to full rebuild if the index is missing or corrupt.

**Domain Synonym Expansion** — BM25 queries now expand terms using domain-aware synonym groups (Flare ecosystem tokens, DeFi concepts, protocol names). "FXRP allocation" now matches episodes containing "Flare XRP position". Original terms weighted 1.0, synonyms weighted 0.5. Custom synonyms supported via `addSynonymGroup()` or JSON file.

**Lazy Episode Loading** — Episodes are loaded on-demand from disk only when they appear in search results, rather than all being held in memory.

## Why Engram Exists

AI agents wake up fresh every session. Engram gives them persistent, searchable, structured memory that survives restarts — stored as plain JSON files, searchable via BM25, with recency boosting and temporal reasoning.

Inspired by [Clawnch's CLAWS](https://clawn.ch/memory) but rebuilt from scratch for OpenClaw:
- **Zero npm dependencies** (Clawnch's CLAWS requires Upstash Redis)
- **File-based by default** (works offline, zero infra)
- **OpenClaw-native** (integrates with `memory/YYYY-MM-DD.md` and `MEMORY.md` patterns)
- **Domain-aware** (DeFi episode types: `trade`, `position`, `alert`, `decision`, `lesson`)
- **Temporal reasoning** (natural language time queries: "what happened last Tuesday?")

## Quick Start

```javascript
import { AgentMemory } from './skills/engram/src/index.js';

const mem = new AgentMemory({ agentId: 'my-agent' });

// Store
await mem.remember('User prefers dark mode', { type: 'fact', tags: ['preferences'] });

// Search (BM25 + recency boosting)
const results = await mem.recall('user preferences');

// Build LLM context
const context = await mem.buildContext('current settings', { maxTokens: 2000 });

// Temporal query
const yesterday = await mem.temporal('what happened yesterday');
```

## CLI Usage

```bash
cd skills/engram

# Store a memory
node scripts/engram.js remember "User prefers dark mode" --type fact --tags preferences,ui

# Search
node scripts/engram.js recall "user preferences" --limit 5

# Recent memories
node scripts/engram.js recent --limit 10

# Temporal query
node scripts/engram.js temporal "what happened yesterday"

# Build LLM context
node scripts/engram.js context "current positions" --max-tokens 2000

# Statistics
node scripts/engram.js stats

# Prune old memories (keep best 1000)
node scripts/engram.js prune --keep 1000

# Delete specific memory
node scripts/engram.js forget ep_default_1707000000_abc123

# Migrate existing memory/*.md files
node scripts/engram.js migrate
```

## Configurable Synonyms

Default synonym groups live in `config/synonyms.json`. Loading order (each layer merges):

1. **Built-in defaults** — `config/synonyms.json`
2. **Environment** — `ENGRAM_SYNONYMS=/path/to/custom.json`
3. **Agent data dir** — `<basePath>/synonyms.json` (auto-loaded)
4. **Constructor** — `new AgentMemory({ synonymsFile: '/path/to/file.json' })`
5. **Runtime** — `addSynonymGroup(['term1', 'term2'])`

```json
{ "groups": [["myToken", "MT", "My Token"]] }
```

## Supersession Chains

```javascript
const [old] = await mem.remember('BTC is 50k');
const [updated] = await mem.remember('BTC is 60k', { supersedes: [old.id] });
const chain = await mem.getSupersessionChain(old.id); // [old, updated]
```

```bash
node scripts/engram.js remember "BTC is 60k" --supersedes ep_default_123_abc
node scripts/engram.js chain ep_default_123_abc
```

Superseded episodes score ×0.3 by default. Use `includeSuperseded: true` for full history.

## API Reference

### `new AgentMemory(opts)`

| Option | Default | Description |
|--------|---------|-------------|
| `agentId` | `'default'` | Agent identifier for namespacing |
| `basePath` | `'memory/engram'` | Storage directory |
| `redis` | `null` | `{ url, token }` for Upstash Redis |
| `recencyWeight` | `0.3` | 0-1, weight of recency vs BM25 |
| `recencyLambda` | `0.1` | Decay rate (~10 day half-life) |
| `importanceDecay` | `0.95` | Daily importance decay factor |
| `chunkMode` | `'sentence'` | `'sentence'`, `'paragraph'`, or `'fixed'` |
| `maxChunkTokens` | `256` | Max tokens per chunk |
| `synonymsFile` | `null` | Path to custom synonyms JSON |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `remember(text, opts)` | `Episode[]` | Store with auto-chunking |
| `recall(query, opts)` | `Episode[]` | BM25 search + recency boost |
| `buildContext(query, opts)` | `string` | LLM-ready context string |
| `getRecent(limit)` | `Episode[]` | Latest memories |
| `findByTag(tag)` | `Episode[]` | Tag-based lookup |
| `forget(id)` | `boolean` | Delete a memory |
| `getStats()` | `object` | Memory statistics |
| `prune(opts)` | `{ pruned }` | Cleanup old/low-importance |
| `temporal(query, opts)` | `Episode[]` | Natural language time queries |
| `rememberSuperseding(text, ids, opts)` | `Episode[]` | Store + mark old as superseded |
| `getSupersessionChain(id)` | `Episode[]` | Full supersession chain |
| `summarize(ids, text, opts)` | `Episode` | Compress episodes into summary |
| `createHooks()` | `object` | Auto-capture hooks for tool calls |

### Episode Schema

```json
{
  "id": "ep_default_1707000000_abc123",
  "text": "User prefers dark mode",
  "type": "fact",
  "tags": ["preferences"],
  "importance": 0.5,
  "agentId": "default",
  "metadata": {},
  "createdAt": 1707000000000,
  "lastAccessedAt": 1707000000000,
  "accessCount": 0,
  "tokens": ["user", "prefer", "dark", "mode"]
}
```

### Episode Types

| Type | Use Case |
|------|----------|
| `fact` | Persistent knowledge |
| `conversation` | Chat summaries |
| `document` | Ingested documents |
| `event` | Things that happened |
| `custom` | Anything else |
| `summary` | Compressed memories |
| `trade` | Trade executions |
| `position` | Portfolio changes |
| `alert` | Triggered alerts |
| `decision` | Decisions + rationale |
| `lesson` | Lessons learned |

## Storage Backends

### FileStorage (default)

Episodes stored as individual JSON files in `memory/engram/episodes/`. Tag index in `memory/engram/index/tags.json`. BM25 index rebuilt on startup (fast — thousands of episodes in <1s).

### RedisStorage (optional)

```javascript
const mem = new AgentMemory({
  redis: { url: 'https://your-redis.upstash.io', token: 'your-token' }
});
```

Drop-in replacement. Same interface. Uses Upstash REST API (no npm deps).

## Auto-Capture Hooks

```javascript
const hooks = mem.createHooks();

// After a trade
await hooks.onTrade({ action: 'buy', amount: 100, token: 'FXRP', price: 2.5 });

// After a decision
await hooks.onDecision({ description: 'Increased FXRP position', rationale: 'Bullish FTSO data' });

// After learning something
await hooks.onLesson({ lesson: 'Always check gas fees before bridging' });
```

## Scoring

**BM25:** `score = IDF(term) × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × dl/avgdl))`

**Recency:** `recencyScore = exp(-λ × daysSinceCreation)`

**Combined:** `finalScore = ((1 - recencyWeight) × bm25 + recencyWeight × recency) × (0.5 + currentImportance)`

**Importance Decay:** `importance = base × 0.95^daysSinceLastAccess` (reinforced by access)

## Migration

Import existing `memory/YYYY-MM-DD.md` files and `MEMORY.md`:

```bash
node scripts/engram.js migrate
```

Splits by `## ` headers, preserves dates as tags, assigns appropriate importance levels.
