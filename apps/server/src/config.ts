import os from 'node:os';
import path from 'node:path';

/** Expand a leading "~" to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const dataDir = path.resolve(expandHome(process.env.SHIPYARD_DATA_DIR ?? '~/.shipyard'));

export const config = {
  port: Number(process.env.SHIPYARD_PORT ?? 4317),
  host: process.env.SHIPYARD_HOST ?? '127.0.0.1',
  dataDir,
  dbPath: path.join(dataDir, 'shipyard.db'),
  /** Git worktrees for implementation runs live here, never inside the user's checkout. */
  worktreesDir: path.join(dataDir, 'worktrees'),
  claudeBin: process.env.SHIPYARD_CLAUDE_BIN ?? 'claude',
  ghBin: process.env.SHIPYARD_GH_BIN ?? 'gh',
  /** Built web app, served in production mode. */
  webDist: path.resolve(import.meta.dirname, '../../web/dist'),
  isProd: process.env.NODE_ENV === 'production',
};
