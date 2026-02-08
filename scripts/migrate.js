/**
 * Engram Migration — Import existing memory/*.md and MEMORY.md files.
 */

import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';

/**
 * Migrate existing memory files into Engram.
 * @param {import('../src/agent.js').AgentMemory} mem
 * @param {object} flags
 */
export async function migrate(mem, flags = {}) {
  const memoryDir = flags['memory-dir'] || resolve(process.cwd(), 'memory');
  let imported = 0;

  // 1. Import daily memory files (YYYY-MM-DD.md)
  try {
    const files = await readdir(memoryDir);
    const dailyFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();

    for (const file of dailyFiles) {
      const date = file.replace('.md', '');
      const content = await readFile(join(memoryDir, file), 'utf-8');
      if (!content.trim()) continue;

      // Split by sections (## headers)
      const sections = content.split(/^## /m).filter(Boolean);

      for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0]?.trim() || date;
        const body = lines.slice(1).join('\n').trim();
        if (!body) continue;

        await mem.remember(body, {
          type: 'document',
          tags: ['daily', 'migrated', date],
          importance: 0.4,
          metadata: { source: file, title, date },
        });
        imported++;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Warning reading memory dir: ${e.message}`);
  }

  // 2. Import MEMORY.md (long-term)
  try {
    const memoryMd = await readFile(resolve(process.cwd(), 'MEMORY.md'), 'utf-8');
    if (memoryMd.trim()) {
      const sections = memoryMd.split(/^## /m).filter(Boolean);
      for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0]?.trim();
        const body = lines.slice(1).join('\n').trim();
        if (!body) continue;

        await mem.remember(body, {
          type: 'fact',
          tags: ['long-term', 'migrated', ...(title ? [title.toLowerCase().replace(/[^a-z0-9]+/g, '-')] : [])],
          importance: 0.7,
          metadata: { source: 'MEMORY.md', title },
        });
        imported++;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Warning reading MEMORY.md: ${e.message}`);
  }

  console.log(`✓ Migrated ${imported} sections into Engram`);
}
