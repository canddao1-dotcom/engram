#!/usr/bin/env node
/**
 * Engram CLI — Command-line interface for Engram memory system.
 * Usage: node engram.js <command> [args] [--flags]
 */

import { AgentMemory } from '../src/agent.js';
import { resolve } from 'path';

// Parse args
const args = process.argv.slice(2);
const command = args[0];
const positional = args.filter(a => !a.startsWith('--'));
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
    flags[key] = val;
    if (val !== 'true') i++;
  }
}

const basePath = flags.path || resolve(process.cwd(), 'memory/engram');
const mem = new AgentMemory({ agentId: flags.agent || 'default', basePath });

async function main() {
  switch (command) {
    case 'remember': {
      const text = positional[1];
      if (!text) { console.error('Usage: engram remember "text" [--type fact] [--tags a,b] [--supersedes id1,id2]'); process.exit(1); }
      const tags = flags.tags ? flags.tags.split(',') : [];
      const type = flags.type || 'fact';
      const importance = parseFloat(flags.importance || '0.5');
      const supersedes = flags.supersedes ? flags.supersedes.split(',') : undefined;
      const eps = await mem.remember(text, { type, tags, importance, supersedes });
      console.log(`✓ Stored ${eps.length} episode(s)`);
      for (const ep of eps) {
        console.log(`  ${ep.id} [${ep.type}]`);
        if (ep.supersedes) console.log(`    supersedes: ${ep.supersedes.join(', ')}`);
      }
      break;
    }

    case 'recall': {
      const query = positional[1];
      if (!query) { console.error('Usage: engram recall "query" [--limit 5]'); process.exit(1); }
      const limit = parseInt(flags.limit || '5');
      const tags = flags.tags ? flags.tags.split(',') : undefined;
      const type = flags.type || undefined;
      const results = await mem.recall(query, { limit, tags, type });
      if (!results.length) { console.log('No matching memories.'); break; }
      for (const r of results) {
        const date = new Date(r.createdAt).toISOString().split('T')[0];
        const tagStr = r.tags.length ? ` [${r.tags.join(', ')}]` : '';
        console.log(`${date} (${r.type})${tagStr} score=${r._score.toFixed(3)}`);
        console.log(`  ${r.text.slice(0, 120)}${r.text.length > 120 ? '...' : ''}`);
        console.log();
      }
      break;
    }

    case 'recent': {
      const limit = parseInt(flags.limit || '10');
      const results = await mem.getRecent(limit);
      for (const r of results) {
        const date = new Date(r.createdAt).toISOString().split('T')[0];
        console.log(`${date} (${r.type}) ${r.text.slice(0, 100)}`);
      }
      break;
    }

    case 'temporal': {
      const query = positional[1];
      if (!query) { console.error('Usage: engram temporal "what happened yesterday"'); process.exit(1); }
      const results = await mem.temporal(query, { limit: parseInt(flags.limit || '10') });
      if (!results.length) { console.log('No matching memories for that time.'); break; }
      for (const r of results) {
        const date = new Date(r.createdAt).toISOString();
        console.log(`${date} (${r.type}) ${r.text.slice(0, 120)}`);
      }
      break;
    }

    case 'context': {
      const query = positional[1];
      if (!query) { console.error('Usage: engram context "query" [--max-tokens 2000]'); process.exit(1); }
      const maxTokens = parseInt(flags['max-tokens'] || '2000');
      const context = await mem.buildContext(query, { maxTokens });
      console.log(context || '(no relevant memories)');
      break;
    }

    case 'stats': {
      const stats = await mem.getStats();
      console.log('Engram Memory Statistics');
      console.log('═'.repeat(40));
      console.log(`Episodes:     ${stats.episodeCount}`);
      console.log(`Indexed:      ${stats.indexedDocs}`);
      console.log(`Unique terms: ${stats.uniqueTerms}`);
      console.log(`Avg length:   ${stats.avgDocLength} tokens`);
      console.log(`Storage:      ${stats.storagePath}`);
      if (stats.totalSizeBytes) console.log(`Size:         ${(stats.totalSizeBytes / 1024).toFixed(1)} KB`);
      if (stats.oldestMemory) console.log(`Oldest:       ${stats.oldestMemory}`);
      if (stats.newestMemory) console.log(`Newest:       ${stats.newestMemory}`);
      if (Object.keys(stats.typeCounts).length) {
        console.log('\nBy type:');
        for (const [t, c] of Object.entries(stats.typeCounts)) console.log(`  ${t}: ${c}`);
      }
      if (Object.keys(stats.tagCounts).length) {
        console.log('\nTop tags:');
        const sorted = Object.entries(stats.tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [t, c] of sorted) console.log(`  ${t}: ${c}`);
      }
      break;
    }

    case 'prune': {
      const keep = parseInt(flags.keep || '1000');
      const maxAgeDays = parseInt(flags['max-age'] || '90');
      const result = await mem.prune({ keep, maxAgeDays });
      console.log(`✓ Pruned ${result.pruned} memories`);
      break;
    }

    case 'forget': {
      const id = positional[1];
      if (!id) { console.error('Usage: engram forget <episode-id>'); process.exit(1); }
      const ok = await mem.forget(id);
      console.log(ok ? `✓ Forgot ${id}` : `✗ Not found: ${id}`);
      break;
    }

    case 'chain': {
      const id = positional[1];
      if (!id) { console.error('Usage: engram chain <episode-id>'); process.exit(1); }
      const chain = await mem.getSupersessionChain(id);
      if (!chain.length) { console.log('No supersession chain found.'); break; }
      console.log(`Supersession chain (${chain.length} episodes):`);
      for (let i = 0; i < chain.length; i++) {
        const ep = chain[i];
        const date = new Date(ep.createdAt).toISOString().split('T')[0];
        const arrow = i < chain.length - 1 ? ' → superseded by' : ' (current)';
        const marker = ep.supersededBy ? '✗' : '✓';
        console.log(`  ${marker} ${ep.id} [${date}] ${ep.text.slice(0, 80)}${ep.text.length > 80 ? '...' : ''}${arrow}`);
      }
      break;
    }

    case 'migrate': {
      // Delegate to migrate script
      const { migrate } = await import('./migrate.js');
      await migrate(mem, flags);
      break;
    }

    default:
      console.log(`Engram — Persistent Memory for AI Agents

Usage: node engram.js <command> [args] [--flags]

Commands:
  remember <text>     Store a memory
  recall <query>      Search memories (BM25 + recency)
  recent              Get recent memories
  temporal <query>    Time-based query ("what happened yesterday")
  context <query>     Build LLM-ready context string
  stats               Memory statistics
  prune               Cleanup old/low-importance memories
  forget <id>         Delete a specific memory
  chain <id>          Show supersession chain for an episode
  migrate             Import existing memory/*.md files

Flags:
  --type <type>       Episode type (fact, trade, lesson, etc.)
  --tags <a,b>        Comma-separated tags
  --importance <0-1>  Importance score
  --limit <n>         Result limit
  --max-tokens <n>    Max tokens for context
  --keep <n>          Keep N best memories (prune)
  --supersedes <ids>  Comma-separated episode IDs to supersede
  --path <dir>        Storage directory
  --agent <id>        Agent ID
`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
