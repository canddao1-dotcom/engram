#!/usr/bin/env node
/**
 * Engram Tests — Basic test suite, no test framework needed.
 */

import { tokenize, chunk, idf, bm25Score, createEpisode, contentHash, termFrequencies } from '../src/core.js';
import { QueryEngine } from '../src/query.js';
import { parseTemporalQuery } from '../src/temporal.js';
import { AgentMemory } from '../src/agent.js';
import { rm } from 'fs/promises';
import { join } from 'path';

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function section(name) { console.log(`\n${name}`); }

// ─── Core Tests ──────────────────────────────────────────────────
section('Core: Tokenizer');
{
  const tokens = tokenize('The quick brown fox jumped over the lazy dogs');
  assert(tokens.length > 0, 'produces tokens');
  assert(!tokens.includes('the'), 'removes stop words');
  assert(tokens.includes('quick'), 'keeps content words');
  assert(tokens.includes('brown'), 'keeps adjectives');
  assert(tokens.includes('jump'), 'stems -ed suffix'); // jumped → jump
  assert(tokens.includes('dog'), 'stems -s suffix');   // dogs → dog
}

section('Core: Chunker');
{
  const text = 'First sentence. Second sentence. Third sentence here. Fourth one. Fifth sentence about stuff.';
  const chunks = chunk(text, { mode: 'sentence', maxTokens: 5 });
  assert(chunks.length > 1, `sentence chunking produces ${chunks.length} chunks`);

  const paras = chunk('Para one.\n\nPara two.\n\nPara three.', { mode: 'paragraph' });
  assert(paras.length === 3, `paragraph chunking produces ${paras.length} chunks`);
}

section('Core: BM25 Math');
{
  const score = bm25Score(2, 10, 15, idf(5, 100));
  assert(score > 0, `BM25 score is positive: ${score.toFixed(4)}`);
  assert(typeof score === 'number', 'returns a number');

  const highTf = bm25Score(10, 10, 15, idf(5, 100));
  assert(highTf > score, 'higher TF → higher score');

  const rareIdf = idf(1, 100);
  const commonIdf = idf(50, 100);
  assert(rareIdf > commonIdf, 'rare terms have higher IDF');
}

section('Core: Episode');
{
  const ep = createEpisode('User prefers dark mode', { type: 'fact', tags: ['preferences'] });
  assert(ep.id.startsWith('ep_'), 'episode ID format');
  assert(ep.type === 'fact', 'episode type');
  assert(ep.tags.includes('preferences'), 'episode tags');
  assert(ep.tokens.length > 0, 'episode tokenized');
  assert(ep.createdAt > 0, 'has timestamp');
}

section('Core: Content Hash');
{
  const h1 = contentHash('hello world');
  const h2 = contentHash('hello world');
  const h3 = contentHash('different text');
  assert(h1 === h2, 'same text → same hash');
  assert(h1 !== h3, 'different text → different hash');
}

// ─── Query Engine Tests ──────────────────────────────────────────
section('QueryEngine');
{
  const engine = new QueryEngine({ recencyWeight: 0.1 });

  const ep1 = createEpisode('Bitcoin price reached 100k today', { type: 'event', tags: ['crypto'] });
  const ep2 = createEpisode('User prefers dark mode in the interface', { type: 'fact', tags: ['preferences'] });
  const ep3 = createEpisode('Ethereum gas fees are very high this week', { type: 'event', tags: ['crypto'] });

  engine.addDocument(ep1);
  engine.addDocument(ep2);
  engine.addDocument(ep3);

  assert(engine.totalDocs === 3, `indexed 3 docs (got ${engine.totalDocs})`);

  const results = engine.search('bitcoin price', { limit: 5 });
  assert(results.length > 0, 'search returns results');
  assert(results[0].id === ep1.id, 'best result is bitcoin episode');

  const tagResults = engine.search('crypto prices', { tags: ['preferences'] });
  assert(tagResults.length === 0 || tagResults.every(r => {
    const d = engine.docs.get(r.id);
    return d.tags.includes('preferences');
  }), 'tag filtering works');

  engine.removeDocument(ep1.id);
  assert(engine.totalDocs === 2, 'removed document');
}

// ─── Temporal Tests ──────────────────────────────────────────────
section('Temporal');
{
  const now = new Date('2026-02-08T12:00:00Z');
  const DAY = 86400000;

  const r1 = parseTemporalQuery('what happened yesterday', now);
  assert(r1.after !== null, 'yesterday: has after');
  assert(r1.before !== null, 'yesterday: has before');
  assert(r1.before - r1.after === DAY, 'yesterday: exactly 1 day range');

  const r2 = parseTemporalQuery('what happened last week', now);
  assert(r2.after !== null, 'last week: has after');
  assert(r2.before - r2.after === 7 * DAY, 'last week: 7 day range');

  const r3 = parseTemporalQuery('3 days ago', now);
  assert(r3.after !== null, '3 days ago: parsed');

  const r4 = parseTemporalQuery('random query with no time', now);
  assert(r4.after === null, 'no time expression: after is null');
}

// ─── Integration Test ────────────────────────────────────────────
section('Integration: AgentMemory');
{
  const testPath = join(process.cwd(), '.engram-test-' + Date.now());
  const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

  try {
    // Remember
    const eps = await mem.remember('User prefers dark mode for the interface', { type: 'fact', tags: ['preferences', 'ui'] });
    assert(eps.length >= 1, `stored ${eps.length} episode(s)`);

    await mem.remember('Traded 100 FXRP at 2.5 USDT', { type: 'trade', tags: ['fxrp', 'trade'] });
    await mem.remember('Lesson: always check gas fees before bridging', { type: 'lesson', tags: ['lesson', 'bridge'] });

    // Recall
    const results = await mem.recall('dark mode preferences', { limit: 5 });
    assert(results.length > 0, 'recall returns results');
    assert(results[0].text.includes('dark mode'), 'best result matches query');

    // Recent
    const recent = await mem.getRecent(5);
    assert(recent.length === 3, `getRecent returns ${recent.length} (expected 3)`);

    // Find by tag
    const tagged = await mem.findByTag('fxrp');
    assert(tagged.length === 1, 'findByTag works');

    // Stats
    const stats = await mem.getStats();
    assert(stats.episodeCount === 3, `stats: ${stats.episodeCount} episodes`);
    assert(stats.indexedDocs === 3, 'stats: indexed');

    // Forget
    const firstId = eps[0].id;
    const forgot = await mem.forget(firstId);
    assert(forgot === true, 'forget returns true');
    const afterForget = await mem.getRecent(10);
    assert(afterForget.length === 2, 'episode deleted');

    // Context
    const ctx = await mem.buildContext('trading FXRP');
    assert(ctx.length > 0, 'buildContext produces output');

    // Prune
    const pruneResult = await mem.prune({ keep: 1 });
    assert(pruneResult.pruned >= 1, `pruned ${pruneResult.pruned} memories`);

    // Hooks
    const hooks = mem.createHooks();
    assert(typeof hooks.onTrade === 'function', 'hooks.onTrade exists');

    console.log('\n✓ Integration tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
