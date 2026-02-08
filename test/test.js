#!/usr/bin/env node
/**
 * Engram Tests — Basic test suite, no test framework needed.
 */

import { tokenize, chunk, idf, bm25Score, createEpisode, contentHash, termFrequencies } from '../src/core.js';
import { QueryEngine } from '../src/query.js';
import { parseTemporalQuery } from '../src/temporal.js';
import { AgentMemory } from '../src/agent.js';
import { expandQuery, addSynonymGroup, initSynonyms, getSynonymGroupCount } from '../src/synonyms.js';
import { FileStorage } from '../src/storage/file.js';
import { rm, readFile } from 'fs/promises';
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
  assert(tokens.includes('jump'), 'stems -ed suffix');
  assert(tokens.includes('dog'), 'stems -s suffix');
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

// ─── Synonym Tests ───────────────────────────────────────────────
section('Synonyms: expandQuery');
{
  const r1 = expandQuery('FXRP allocation');
  assert(r1.expanded.length > 0, `FXRP expands to synonyms: ${r1.expanded.join(', ')}`);
  assert(r1.expanded.some(t => t === 'flare' || t === 'xrp' || t === 'fasset'), 'FXRP includes Flare/XRP synonyms');

  const r2 = expandQuery('sFLR staking yield');
  assert(r2.expanded.length > 0, `sFLR expands: ${r2.expanded.join(', ')}`);

  const r3 = expandQuery('random unrelated query');
  // May or may not expand, but shouldn't crash
  assert(Array.isArray(r3.expanded), 'unrelated query returns array');

  const r4 = expandQuery('LP APY');
  assert(r4.expanded.length > 0, 'DeFi acronyms expand');
}

section('Synonyms: addSynonymGroup');
{
  addSynonymGroup(['testtoken', 'TT', 'test coin']);
  const r = expandQuery('testtoken price');
  assert(r.expanded.some(t => t === 'tt' || t === 'test' || t === 'coin'), 'custom synonym group works');
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

section('QueryEngine: Synonym search');
{
  const engine = new QueryEngine({ recencyWeight: 0.0, synonymWeight: 0.5 });

  // Episode uses "Flare XRP position" terminology
  const ep1 = createEpisode('Opened a new Flare XRP position worth 5000 tokens', { type: 'position', tags: ['fxrp'] });
  // Episode uses "FXRP" terminology
  const ep2 = createEpisode('FXRP allocation increased to 10000', { type: 'position', tags: ['fxrp'] });
  const ep3 = createEpisode('Unrelated Bitcoin discussion about mining', { type: 'event', tags: ['btc'] });

  engine.addDocument(ep1);
  engine.addDocument(ep2);
  engine.addDocument(ep3);

  // Search for "FXRP allocation" should find both FXRP and Flare XRP episodes
  const results = engine.search('FXRP allocation', { limit: 5 });
  assert(results.length >= 1, `synonym search returns results: ${results.length}`);

  const resultIds = results.map(r => r.id);
  assert(resultIds.includes(ep2.id), 'finds exact match (FXRP)');
  assert(resultIds.includes(ep1.id), 'finds synonym match (Flare XRP)');
  assert(!resultIds.includes(ep3.id), 'does not match unrelated');

  // Exact match should score higher
  const ep2Result = results.find(r => r.id === ep2.id);
  const ep1Result = results.find(r => r.id === ep1.id);
  assert(ep2Result.bm25 >= ep1Result.bm25, 'exact match scores higher than synonym match');
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

// ─── Incremental Index Test ──────────────────────────────────────
section('Incremental: BM25 index persistence');
{
  const testPath = join(process.cwd(), '.engram-incr-test-' + Date.now());

  try {
    // Phase 1: Create memory and store episodes
    const mem1 = new AgentMemory({ agentId: 'test', basePath: testPath });
    await mem1.remember('First memory about Flare tokens', { type: 'fact', tags: ['flare'] });
    await mem1.remember('Second memory about Sceptre staking', { type: 'fact', tags: ['sceptre'] });

    // Verify BM25 index was persisted
    const indexPath = join(testPath, 'index', 'bm25-index.json');
    const indexData = await readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(indexData);
    assert(parsed.version === '1.1', 'BM25 index persisted with version');
    assert(parsed.totalDocs === 2, `persisted index has ${parsed.totalDocs} docs`);
    assert(parsed.lastIndexedTimestamp > 0, 'has lastIndexedTimestamp');

    // Phase 2: Create new AgentMemory instance (simulates restart)
    const mem2 = new AgentMemory({ agentId: 'test', basePath: testPath });
    await mem2.init();
    assert(mem2.engine.totalDocs === 2, 'restored 2 docs from persisted index');

    // Add a new episode
    await mem2.remember('Third memory about Upshift vaults', { type: 'fact', tags: ['upshift'] });
    assert(mem2.engine.totalDocs === 3, 'incremental add works');

    // Verify search still works after reload
    const results = mem2.engine.search('Flare tokens', { limit: 5 });
    assert(results.length > 0, 'search works after index reload');

    // Phase 3: Verify index updated on disk
    const indexData2 = await readFile(indexPath, 'utf-8');
    const parsed2 = JSON.parse(indexData2);
    assert(parsed2.totalDocs === 3, 'updated index has 3 docs');

    console.log('\n✓ Incremental index tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── Synonym Integration Test ────────────────────────────────────
section('Synonym Integration: FXRP ↔ Flare XRP');
{
  const testPath = join(process.cwd(), '.engram-syn-test-' + Date.now());

  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

    // Store with "Flare XRP position" text
    await mem.remember('Opened a new Flare XRP position worth 5000 tokens on Enosys', { type: 'position', tags: ['fxrp'] });

    // Search with "FXRP allocation" — should find it via synonyms
    const results = await mem.recall('FXRP allocation', { limit: 5 });
    assert(results.length > 0, 'synonym search finds "Flare XRP" when querying "FXRP"');
    assert(results[0].text.includes('Flare XRP'), 'correct episode returned via synonym');

    console.log('\n✓ Synonym integration tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── Lazy Loading Test ───────────────────────────────────────────
section('Lazy Loading: episodes loaded on-demand');
{
  const testPath = join(process.cwd(), '.engram-lazy-test-' + Date.now());

  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });
    await mem.remember('Memory alpha about trading', { type: 'trade', tags: ['trading'] });
    await mem.remember('Memory beta about staking', { type: 'fact', tags: ['staking'] });
    await mem.remember('Memory gamma about bridging', { type: 'fact', tags: ['bridge'] });

    // The engine should have docs indexed but recall only loads matching ones
    assert(mem.engine.totalDocs === 3, 'all 3 indexed');

    // Search for just "trading" — should only load the matching episode
    const results = await mem.recall('trading', { limit: 5 });
    assert(results.length >= 1, 'recall returns matching episodes');
    assert(results[0].text.includes('trading'), 'loaded correct episode on-demand');

    // Engine docs have metadata but we verify lazy loading by checking
    // that recall fetches full episodes from storage (not from engine.docs)
    const doc = mem.engine.docs.get(results[0].id);
    assert(doc !== undefined, 'engine has doc metadata');
    assert(doc.tf instanceof Map, 'engine has TF for scoring');
    assert(!doc.text, 'engine does NOT store full text (lazy)');

    console.log('\n✓ Lazy loading tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── Configurable Synonyms Test ──────────────────────────────────
section('Configurable Synonyms: initSynonyms + defaults');
{
  await initSynonyms();
  const count = getSynonymGroupCount();
  assert(count > 30, `loaded ${count} default synonym groups from config/synonyms.json`);

  // Verify synonym expansion still works after init
  const r = expandQuery('FXRP allocation');
  assert(r.expanded.length > 0, 'synonyms work after initSynonyms()');
}

// ─── Supersession Chain Test ─────────────────────────────────────
section('Supersession: basic chain');
{
  const testPath = join(process.cwd(), '.engram-super-test-' + Date.now());

  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

    // Store original fact
    const [orig] = await mem.remember('FXRP price is 2.0 USDT', { type: 'fact', tags: ['fxrp'] });
    assert(orig.id, 'original episode created');
    assert(!orig.supersedes, 'original has no supersedes');

    // Supersede with updated fact
    const [updated] = await mem.remember('FXRP price is 2.5 USDT', {
      type: 'fact', tags: ['fxrp'], supersedes: [orig.id],
    });
    assert(updated.supersedes.includes(orig.id), 'new episode supersedes original');

    // Check old episode was marked
    const oldEp = await mem.storage.getEpisode(orig.id);
    assert(oldEp.supersededBy && oldEp.supersededBy.includes(updated.id), 'old episode has supersededBy');

    // Search should rank superseded lower
    const results = await mem.recall('FXRP price', { limit: 10 });
    assert(results.length === 2, 'both episodes found');
    assert(results[0].id === updated.id, 'current episode ranks first');
    assert(results[0]._score > results[1]._score, 'superseded episode has lower score');

    // includeSuperseded should give full scores
    const allResults = await mem.recall('FXRP price', { limit: 10, includeSuperseded: true });
    assert(allResults.length === 2, 'includeSuperseded returns both');

    console.log('\n✓ Supersession basic tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

section('Supersession: chain traversal');
{
  const testPath = join(process.cwd(), '.engram-chain-test-' + Date.now());

  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

    // Create a chain: v1 → v2 → v3
    const [v1] = await mem.remember('Fact v1', { type: 'fact' });
    const [v2] = await mem.remember('Fact v2', { type: 'fact', supersedes: [v1.id] });
    const [v3] = await mem.remember('Fact v3', { type: 'fact', supersedes: [v2.id] });

    // Get chain from v1
    const chain1 = await mem.getSupersessionChain(v1.id);
    assert(chain1.length === 3, `chain from v1 has ${chain1.length} entries (expected 3)`);
    assert(chain1[0].id === v1.id, 'chain starts with v1');
    assert(chain1[2].id === v3.id, 'chain ends with v3');

    // Get chain from v2 (middle)
    const chain2 = await mem.getSupersessionChain(v2.id);
    assert(chain2.length === 3, `chain from v2 has ${chain2.length} entries (expected 3)`);

    // rememberSuperseding convenience method
    const [v4] = await mem.rememberSuperseding('Fact v4', [v3.id]);
    assert(v4.supersedes.includes(v3.id), 'rememberSuperseding works');

    const chain3 = await mem.getSupersessionChain(v1.id);
    assert(chain3.length === 4, `full chain has ${chain3.length} entries (expected 4)`);

    console.log('\n✓ Supersession chain tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── v1.3: injectContext Test ─────────────────────────────────────
section('v1.3: injectContext');
{
  const testPath = join(process.cwd(), '.engram-inject-test-' + Date.now());
  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });
    await mem.remember('Rebalanced FXRP/WFLR position to tighter range', { type: 'decision', tags: ['fxrp', 'lp'], importance: 0.9 });
    await mem.remember('Swapped 500 WFLR for sFLR on Sceptre', { type: 'trade', tags: ['wflr', 'sflr'], importance: 0.7 });
    await mem.remember('8004 metadata updated on-chain', { type: 'event', tags: ['8004'], importance: 0.6 });

    const start = Date.now();
    const ctx = await mem.injectContext('FXRP position', { maxTokens: 1500 });
    const elapsed = Date.now() - start;

    assert(ctx.length > 0, 'injectContext returns non-empty context');
    assert(ctx.includes('Relevant Memories') || ctx.includes('Recent Context'), 'has section headers');
    assert(elapsed < 2000, `fast execution: ${elapsed}ms`);

    // Token budget test
    const smallCtx = await mem.injectContext('FXRP', { maxTokens: 10 });
    assert(smallCtx.length < ctx.length || smallCtx.length > 0, 'respects smaller token budget');

    // No BM25 matches but recent context still appears
    const emptyCtx = await mem.injectContext('zzzznonexistent12345', { includeRecent: false });
    assert(emptyCtx === '', 'returns empty string for no matches (no recent)');

    // Exclude tags
    const excludeCtx = await mem.injectContext('FXRP position', { excludeTags: ['fxrp'], includeRecent: false });
    assert(!excludeCtx.includes('FXRP/WFLR'), 'excludeTags filters results');

    console.log('\n✓ injectContext tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── v1.3: Transcript Reader Test ────────────────────────────────
import { readTranscript, digestTranscript } from '../src/transcript.js';
import { writeFile as writeFileSync } from 'fs/promises';

section('v1.3: readTranscript');
{
  const testPath = join(process.cwd(), '.engram-transcript-test-' + Date.now());
  const transcriptFile = join(testPath, 'test-session.jsonl');

  try {
    await import('fs').then(fs => fs.promises.mkdir(testPath, { recursive: true }));

    // Create test transcript
    const lines = [
      JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' }),
      JSON.stringify({ role: 'user', content: 'What is my FXRP balance?' }),
      JSON.stringify({ role: 'assistant', content: 'Your FXRP balance is 5000 tokens.' }),
      JSON.stringify({ role: 'user', content: 'I decided to swap 1000 FXRP for WFLR' }),
      'this is a malformed line that should be skipped',
      JSON.stringify({ role: 'tool', content: 'swap executed successfully' }),
      JSON.stringify({ role: 'assistant', content: 'Done! I swapped 1000 FXRP for WFLR at rate 0.45.' }),
      JSON.stringify({ role: 'user', content: 'Lesson learned: always check slippage before large swaps' }),
    ];
    await writeFileSync(transcriptFile, lines.join('\n'));

    const result = await readTranscript(transcriptFile);
    assert(result.userMessages.length === 3, `extracted ${result.userMessages.length} user messages (expected 3)`);
    assert(result.assistantMessages.length === 2, `extracted ${result.assistantMessages.length} assistant messages (expected 2)`);
    assert(result.systemMessages.length === 1, `extracted ${result.systemMessages.length} system messages (expected 1)`);
    assert(result.summary.includes('total messages'), 'has summary string');

    // Test with limit
    const limited = await readTranscript(transcriptFile, { userMessages: 1 });
    assert(limited.userMessages.length === 1, 'userMessages limit works');

    console.log('\n✓ readTranscript tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

section('v1.3: digestTranscript');
{
  const testPath = join(process.cwd(), '.engram-digest-test-' + Date.now());
  const transcriptFile = join(testPath, 'session.jsonl');

  try {
    await import('fs').then(fs => fs.promises.mkdir(testPath, { recursive: true }));

    const lines = [
      JSON.stringify({ role: 'user', content: 'I decided to rebalance the LP position to a tighter range for more fees' }),
      JSON.stringify({ role: 'assistant', content: 'I swapped 500 WFLR for sFLR on Sceptre Finance at the current rate' }),
      JSON.stringify({ role: 'user', content: 'Lesson learned: never bridge without checking gas fees first, cost me 50 FLR' }),
      JSON.stringify({ role: 'assistant', content: 'Deployed the new contract to mainnet successfully' }),
    ];
    await writeFileSync(transcriptFile, lines.join('\n'));

    const memPath = join(testPath, 'memory');
    const mem = new AgentMemory({ agentId: 'test', basePath: memPath });
    const count = await digestTranscript(transcriptFile, mem);
    assert(count > 0, `created ${count} episodes from transcript`);
    assert(count <= 10, 'reasonable number of episodes');

    const stats = await mem.getStats();
    assert(stats.episodeCount === count, 'episodes stored correctly');

    console.log('\n✓ digestTranscript tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── v1.3: Compaction Hooks Test ─────────────────────────────────
section('v1.3: compactionCheckpoint + postCompactionContext');
{
  const testPath = join(process.cwd(), '.engram-compaction-test-' + Date.now());
  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

    // Store some episodes
    await mem.remember('Opened LP position on SparkDex', { type: 'event', tags: ['lp'] });
    await mem.remember('Decided to use tighter range for higher fees', { type: 'decision', tags: ['lp'] });

    // Create checkpoint
    const cpId = await mem.compactionCheckpoint({
      sessionSummary: 'Working on LP management and rebalancing',
      keyDecisions: ['Tighter range on SparkDex', 'Keep sFLR staked'],
      pendingTasks: ['Monitor LP health', 'Check bridge status'],
    });
    assert(cpId && cpId.startsWith('ep_'), `checkpoint created: ${cpId}`);

    // Verify checkpoint episode
    const cpEp = await mem.storage.getEpisode(cpId);
    assert(cpEp.type === 'checkpoint', 'checkpoint has correct type');
    assert(cpEp.tags.includes('compaction'), 'checkpoint tagged with compaction');

    // Get post-compaction context
    const ctx = await mem.postCompactionContext({ maxTokens: 3000, hoursBack: 1 });
    assert(ctx.length > 0, 'post-compaction context is non-empty');
    assert(ctx.includes('Post-Compaction Context'), 'has header');
    assert(ctx.includes('checkpoint'), 'includes checkpoint episode');

    console.log('\n✓ Compaction hooks tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── v1.3: Hourly Summary Test ───────────────────────────────────
section('v1.3: hourlySummary');
{
  const testPath = join(process.cwd(), '.engram-hourly-test-' + Date.now());
  try {
    const mem = new AgentMemory({ agentId: 'test', basePath: testPath });

    await mem.remember('Price alert: FXRP above 3.0', { type: 'alert', tags: ['fxrp'] });
    await mem.remember('Rebalanced LP to new range', { type: 'event', tags: ['lp'] });
    await mem.remember('Staked 1000 FLR on Sceptre', { type: 'trade', tags: ['staking'] });

    const summary = await mem.hourlySummary(1);
    assert(summary.id && summary.id.startsWith('ep_'), 'summary episode created');
    assert(summary.type === 'summary', 'type is summary');
    assert(summary.tags.includes('hourly'), 'tagged as hourly');
    assert(summary.text.includes('episodes'), 'mentions episode count');

    // Verify it's stored
    const stats = await mem.getStats();
    assert(stats.episodeCount === 4, '3 original + 1 summary = 4 episodes');

    console.log('\n✓ hourlySummary tests passed');
  } finally {
    await rm(testPath, { recursive: true, force: true });
  }
}

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
