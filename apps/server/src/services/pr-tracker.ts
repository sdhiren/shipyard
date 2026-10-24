import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { items } from '../db/schema.js';
import { syncPr } from './agent.js';
import { getSettings } from './settings.js';

/**
 * Background poller: keeps open PRs in sync with GitHub so items move to Done
 * on their own when a PR merges. Uses `gh`, so no tokens are stored here.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function pollOpenPrs(): Promise<{ synced: number; failed: number }> {
  if (running) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    const open = db
      .select({ id: items.id })
      .from(items)
      .where(and(isNotNull(items.prNumber), eq(items.prState, 'OPEN')))
      .all();
    for (const { id } of open) {
      try {
        await syncPr(id);
        synced++;
      } catch {
        failed++;
      }
    }
  } finally {
    running = false;
  }
  return { synced, failed };
}

export function startPrTracker(log: (msg: string) => void): void {
  stopPrTracker();
  const intervalMs = getSettings().prPollIntervalSec * 1000;
  const tick = async () => {
    const r = await pollOpenPrs();
    if (r.synced || r.failed) log(`PR sync: ${r.synced} synced, ${r.failed} failed`);
    timer = setTimeout(tick, getSettings().prPollIntervalSec * 1000);
  };
  timer = setTimeout(tick, Math.min(intervalMs, 15_000));
}

export function stopPrTracker(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
