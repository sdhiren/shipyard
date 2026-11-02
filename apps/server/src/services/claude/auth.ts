import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CLAUDE_SIGNIN_ERROR, type ClaudeAuthStatus, type ClaudeLoginSession } from '@shipyard/shared';
import { config } from '../../config.js';
import { exec } from '../../lib/exec.js';
import { bus } from '../../lib/events.js';
import { HttpError, newId, now } from '../../lib/util.js';

/**
 * Claude Code sign-in, so an expired login can be fixed from the Shipyard UI.
 *
 * `claude auth login` opens a sign-in page, then waits for the code that
 * claude.com shows after the owner signs in. Shipyard runs that process,
 * shows the URL as a fallback link, and pipes the pasted code into its stdin.
 * Shipyard never sees the owner's password, and it doesn't store the code.
 */

const STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

let cached: ClaudeAuthStatus | null = null;
let cachedAt = 0;

function parseStatus(stdout: string): ClaudeAuthStatus {
  const status: ClaudeAuthStatus = { loggedIn: null, authMethod: null, email: null, checkedAt: now() };
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof raw.loggedIn === 'boolean') status.loggedIn = raw.loggedIn;
    if (typeof raw.authMethod === 'string') status.authMethod = raw.authMethod;
    const email = raw.email ?? raw.emailAddress ?? (raw.account as Record<string, unknown> | undefined)?.email;
    if (typeof email === 'string') status.email = email;
  } catch {
    // Older CLIs or unexpected output: leave loggedIn unknown rather than guessing.
  }
  return status;
}

/** `claude auth status`, cached briefly; it takes ~0.4s. */
export async function getAuthStatus(opts: { force?: boolean } = {}): Promise<ClaudeAuthStatus> {
  if (!opts.force && cached && Date.now() - cachedAt < STATUS_TTL_MS) return cached;
  try {
    const r = await exec(config.claudeBin, ['auth', 'status', '--json'], { timeoutMs: 15_000 });
    cached = parseStatus(r.stdout);
  } catch {
    cached = { loggedIn: null, authMethod: null, email: null, checkedAt: now() };
  }
  cachedAt = Date.now();
  return cached;
}

/** Forget the cached status, e.g. after a run fails with an auth error. */
export function markSignedOut(): void {
  cached = { loggedIn: false, authMethod: cached?.authMethod ?? null, email: cached?.email ?? null, checkedAt: now() };
  cachedAt = Date.now();
  publish();
}

/**
 * Refuse to start a run that would fail straight away because Claude Code is
 * signed out. When the status can't be determined, the run goes ahead.
 */
export async function assertSignedIn(): Promise<void> {
  const status = await getAuthStatus();
  if (status.loggedIn === false) {
    throw new HttpError(401, `${CLAUDE_SIGNIN_ERROR}. Sign in to Claude, then try again.`);
  }
}

const AUTH_FAILURE = /failed to authenticate|oauth (session|token).*(expired|invalid|revoked)|not logged in|please run \/login|invalid api key|authentication_error|401 unauthorized/i;

/** Whether a CLI error message means the login is missing or expired. */
export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

interface LoginProcess extends ClaudeLoginSession {
  child: ChildProcessWithoutNullStreams | null;
  output: string;
  timer: NodeJS.Timeout | null;
}

let login: LoginProcess | null = null;

function snapshot(): ClaudeLoginSession | null {
  if (!login) return null;
  const { id, state, url, error, startedAt } = login;
  return { id, state, url, error, startedAt };
}

function publish(): void {
  const status = cached ?? { loggedIn: null, authMethod: null, email: null, checkedAt: now() };
  bus.publish({ type: 'claude.auth', status, login: snapshot() });
}

function setState(patch: Partial<LoginProcess>): void {
  if (!login) return;
  Object.assign(login, patch);
  publish();
}

/** The last meaningful lines of CLI output, without escape codes or URLs. */
function tail(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    // The prompt has no trailing newline, so an error can follow it on the same line.
    .replace(/paste code here if prompted\s*>?/gi, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/opening browser|browser didn't open/i.test(l))
    .slice(-3)
    .join(' ');
}

export function getLoginSession(): ClaudeLoginSession | null {
  return snapshot();
}

/** Start `claude auth login`. Any flow already in progress is cancelled first. */
export function startLogin(method: 'claudeai' | 'console' = 'claudeai'): ClaudeLoginSession {
  cancelLogin();
  const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];
  // The CLI opens the sign-in page in the default browser itself; the UI also shows the link as a fallback.
  const child = spawn(config.claudeBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  login = { id: newId('login'), state: 'starting', url: null, error: null, startedAt: now(), child, output: '', timer: null };
  const session = login;

  const onData = (chunk: Buffer) => {
    if (login !== session) return;
    session.output += chunk.toString();
    const url = session.output.match(/https:\/\/\S+/)?.[0] ?? null;
    if (url && session.state === 'starting') setState({ url, state: 'waiting_for_code' });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    if (login !== session) return;
    setState({ state: 'failed', error: `Could not start "${config.claudeBin}": ${err.message}`, child: null });
  });

  child.on('close', async (code) => {
    if (login !== session || session.state === 'cancelled') return;
    if (session.timer) clearTimeout(session.timer);
    session.child = null;
    const status = await getAuthStatus({ force: true });
    if (code === 0 && status.loggedIn !== false) {
      setState({ state: 'succeeded', error: null });
    } else {
      setState({ state: 'failed', error: tail(session.output) || `claude auth login exited with code ${code}` });
    }
  });

  session.timer = setTimeout(() => {
    if (login === session && session.child) {
      session.child.kill('SIGTERM');
      setState({ state: 'failed', error: 'Sign-in timed out after 10 minutes. Start again when you are ready.' });
    }
  }, LOGIN_TIMEOUT_MS);
  session.timer.unref();

  publish();
  return snapshot()!;
}

/** Hand the code from claude.com to the waiting CLI. */
export function submitLoginCode(code: string): ClaudeLoginSession {
  const trimmed = code.trim();
  if (!login?.child || login.state !== 'waiting_for_code') {
    throw new HttpError(409, 'No sign-in is waiting for a code. Start the sign-in again.');
  }
  if (!trimmed || /\s/.test(trimmed)) throw new HttpError(400, 'Paste the code exactly as claude.com shows it.');
  login.child.stdin.write(`${trimmed}\n`);
  setState({ state: 'verifying', error: null });
  return snapshot()!;
}

export function cancelLogin(): void {
  if (!login) return;
  if (login.timer) clearTimeout(login.timer);
  if (login.child) login.child.kill('SIGTERM');
  if (login.state !== 'succeeded' && login.state !== 'failed') setState({ state: 'cancelled', child: null });
}
