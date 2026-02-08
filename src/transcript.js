/**
 * Engram Transcript — Parse OpenClaw .jsonl session transcripts.
 * Extract key exchanges and auto-digest into Engram episodes.
 */

import { readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

/**
 * Read an OpenClaw session transcript and extract key exchanges.
 * @param {string} transcriptPath - Path to .jsonl file
 * @param {object} options
 * @param {number} options.userMessages - Last N user messages to extract (default: 15)
 * @param {number} options.systemMessages - Last N system messages (default: 10)
 * @param {number} options.assistantMessages - Last N assistant messages (default: 10)
 * @returns {object} { userMessages: [], systemMessages: [], assistantMessages: [], toolMessages: [], summary: string }
 */
export async function readTranscript(transcriptPath, options = {}) {
  const {
    userMessages: maxUser = 15,
    systemMessages: maxSystem = 10,
    assistantMessages: maxAssistant = 10,
  } = options;

  const messages = { user: [], assistant: [], system: [], tool: [] };

  const rl = createInterface({
    input: createReadStream(transcriptPath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const role = obj.role;
      const content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || '');
      if (role && messages[role] !== undefined) {
        messages[role].push({ role, content, timestamp: obj.timestamp || null });
      }
    } catch {
      // skip malformed lines
    }
  }

  const userMessages = messages.user.slice(-maxUser);
  const systemMessages = messages.system.slice(-maxSystem);
  const assistantMessages = messages.assistant.slice(-maxAssistant);
  const toolMessages = messages.tool;

  const totalMessages = messages.user.length + messages.assistant.length + messages.system.length + messages.tool.length;
  const summary = `Transcript: ${totalMessages} total messages (${messages.user.length} user, ${messages.assistant.length} assistant, ${messages.system.length} system, ${messages.tool.length} tool)`;

  return { userMessages, systemMessages, assistantMessages, toolMessages, summary };
}

// Patterns for extracting key information from transcripts
const DECISION_PATTERNS = [
  /\b(?:decided|decision|chose|choosing|going with|opted for|will go with)\b/i,
  /\b(?:strategy|plan|approach):\s/i,
];
const TRADE_PATTERNS = [
  /\b(?:swap|swapped|trade|traded|bought|sold|bridge|bridged|staked|unstaked)\b/i,
  /\b(?:\d+\.?\d*)\s*(?:FXRP|WFLR|sFLR|FLR|USDT|USDC|ETH|BTC|HYPE)\b/i,
];
const LESSON_PATTERNS = [
  /\b(?:lesson|learned|mistake|note to self|important|remember|never|always)\b/i,
  /\b(?:bug|issue|fix|workaround|gotcha)\b/i,
];
const EVENT_PATTERNS = [
  /\b(?:deployed|registered|created|updated|completed|finished|launched)\b/i,
];

function classifyContent(text) {
  const types = [];
  for (const p of DECISION_PATTERNS) if (p.test(text)) { types.push('decision'); break; }
  for (const p of TRADE_PATTERNS) if (p.test(text)) { types.push('trade'); break; }
  for (const p of LESSON_PATTERNS) if (p.test(text)) { types.push('lesson'); break; }
  for (const p of EVENT_PATTERNS) if (p.test(text)) { types.push('event'); break; }
  return types.length ? types : null;
}

/**
 * Auto-summarize a transcript into Engram episodes.
 * Extracts decisions, trades, lessons, and key events.
 * @param {string} transcriptPath
 * @param {AgentMemory} mem - Engram instance to store episodes
 * @param {object} options
 * @param {number} options.maxEpisodes - Max episodes to create (default: 50)
 * @returns {number} Number of episodes created
 */
export async function digestTranscript(transcriptPath, mem, options = {}) {
  const { maxEpisodes = 50 } = options;
  const { userMessages, assistantMessages } = await readTranscript(transcriptPath, {
    userMessages: 100,
    assistantMessages: 100,
  });

  let created = 0;
  const allMessages = [...userMessages, ...assistantMessages]
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  for (const msg of allMessages) {
    if (created >= maxEpisodes) break;
    const content = msg.content;
    if (!content || content.length < 20) continue;

    const types = classifyContent(content);
    if (!types) continue;

    for (const type of types) {
      if (created >= maxEpisodes) break;
      // Truncate to first 500 chars for episode text
      const text = content.length > 500 ? content.slice(0, 500) + '...' : content;
      const tags = [type, 'transcript'];
      const importance = type === 'decision' ? 0.9 : type === 'lesson' ? 0.85 : type === 'trade' ? 0.7 : 0.6;

      await mem.remember(text, { type, tags, importance, metadata: { source: 'transcript', path: transcriptPath } });
      created++;
    }
  }

  return created;
}
