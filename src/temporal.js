/**
 * Engram Temporal — Natural language time parsing.
 * Resolves relative time references to { after, before } timestamp ranges.
 */

/**
 * Parse a natural language time expression into a date range.
 * @param {string} query
 * @param {Date} [now] - override current time (for testing)
 * @returns {{ after: number, before: number, remaining: string }}
 */
export function parseTemporalQuery(query, now = new Date()) {
  const lq = query.toLowerCase().trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY = 86400000;

  let after = null, before = null, remaining = query;

  // "today"
  if (/\btoday\b/.test(lq)) {
    after = today.getTime();
    before = today.getTime() + DAY;
    remaining = lq.replace(/\btoday\b/, '').trim();
  }
  // "yesterday"
  else if (/\byesterday\b/.test(lq)) {
    after = today.getTime() - DAY;
    before = today.getTime();
    remaining = lq.replace(/\byesterday\b/, '').trim();
  }
  // "last N days/hours/weeks"
  else if (/\blast\s+(\d+)\s+(day|hour|week|month)s?\b/.test(lq)) {
    const m = lq.match(/\blast\s+(\d+)\s+(day|hour|week|month)s?\b/);
    const n = parseInt(m[1]);
    const unit = m[2];
    const ms = unit === 'hour' ? 3600000 : unit === 'day' ? DAY : unit === 'week' ? DAY * 7 : DAY * 30;
    after = now.getTime() - n * ms;
    before = now.getTime();
    remaining = lq.replace(m[0], '').trim();
  }
  // "last week" / "last month"
  else if (/\blast\s+(week|month)\b/.test(lq)) {
    const m = lq.match(/\blast\s+(week|month)\b/);
    const ms = m[1] === 'week' ? DAY * 7 : DAY * 30;
    after = now.getTime() - ms;
    before = now.getTime();
    remaining = lq.replace(m[0], '').trim();
  }
  // "this week"
  else if (/\bthis\s+week\b/.test(lq)) {
    const dow = today.getDay();
    const monday = new Date(today.getTime() - (dow === 0 ? 6 : dow - 1) * DAY);
    after = monday.getTime();
    before = now.getTime();
    remaining = lq.replace(/\bthis\s+week\b/, '').trim();
  }
  // "last tuesday", "last monday", etc.
  else if (/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lq)) {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const m = lq.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    const targetDay = days.indexOf(m[1]);
    const currentDay = today.getDay();
    let daysBack = currentDay - targetDay;
    if (daysBack <= 0) daysBack += 7;
    const target = new Date(today.getTime() - daysBack * DAY);
    after = target.getTime();
    before = target.getTime() + DAY;
    remaining = lq.replace(m[0], '').trim();
  }
  // "on Jan 15" / "on February 3" / "on 2026-01-15"
  else if (/\bon\s+(\w+\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/.test(lq)) {
    const m = lq.match(/\bon\s+(\w+\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/);
    const parsed = new Date(m[1] + (m[1].includes('-') ? '' : `, ${now.getFullYear()}`));
    if (!isNaN(parsed.getTime())) {
      const day = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      after = day.getTime();
      before = day.getTime() + DAY;
    }
    remaining = lq.replace(m[0], '').trim();
  }
  // "N days ago"
  else if (/\b(\d+)\s+days?\s+ago\b/.test(lq)) {
    const m = lq.match(/\b(\d+)\s+days?\s+ago\b/);
    const n = parseInt(m[1]);
    const target = new Date(today.getTime() - n * DAY);
    after = target.getTime();
    before = target.getTime() + DAY;
    remaining = lq.replace(m[0], '').trim();
  }

  // Clean up remaining
  remaining = remaining.replace(/\b(what|happened|was|did|do|the)\b/g, '').replace(/\s+/g, ' ').trim();

  return { after, before, remaining: remaining || null };
}
