import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/**
 * Run a command without a shell (arguments are never interpolated),
 * resolving with its output whatever the exit code.
 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          stderr += `\n[timed out after ${opts.timeoutMs}ms]`;
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Like exec, but throws when the command exits non-zero. */
export async function execOrThrow(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await exec(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}): ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout;
}

/** Whether a binary is on PATH and runnable. */
export async function hasBinary(cmd: string): Promise<boolean> {
  try {
    const res = await exec(cmd, ['--version'], { timeoutMs: 10_000 });
    return res.code === 0;
  } catch {
    return false;
  }
}
