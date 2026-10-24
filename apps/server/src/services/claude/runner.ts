import { spawn } from 'node:child_process';
import type { RunEventType } from '@shipyard/shared';
import { config } from '../../config.js';
import { truncate } from '../../lib/util.js';

/**
 * Drives the Claude Code CLI in headless mode (`claude -p --output-format stream-json`).
 *
 * Using the CLI rather than calling the API directly means Shipyard inherits the
 * user's existing Claude Code login, CLAUDE.md files, MCP servers and the full
 * built-in toolset (Read/Edit/Bash/Grep…) with its permission system.
 */

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  effort?: string;
  /** JSON Schema the final answer must satisfy; returned as `structuredOutput`. */
  jsonSchema?: object;
  /** 'readonly' = analysis/planning, 'guarded' = edits + allow-listed bash, 'full' = no permission checks. */
  mode: 'readonly' | 'guarded' | 'full';
  allowedTools?: string[];
  maxBudgetUsd?: number;
  resumeSessionId?: string | null;
  appendSystemPrompt?: string;
  persistSession?: boolean;
  signal?: AbortSignal;
  onEvent: (event: { type: RunEventType; text: string; data?: unknown }) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  sessionId: string | null;
  resultText: string;
  structuredOutput: unknown;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  error: string | null;
  permissionDenials: unknown[];
}

const READONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git diff*)',
  'Bash(git status*)',
  'Bash(git ls-files*)',
  'Bash(ls*)',
  'Bash(wc*)',
  'Bash(cat*)',
  'Bash(head*)',
  'Bash(tree*)',
];
const EDIT_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write', 'MultiEdit', 'TodoWrite', 'Task'];
const GIT_WRITE_TOOLS = ['Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git show*)', 'Bash(ls*)', 'Bash(mkdir*)', 'Bash(cat*)', 'Bash(wc*)'];
/** Tools that make no sense for a background worker. */
const ALWAYS_DISALLOWED = [
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'PushNotification',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'Bash(git push*)',
  'Bash(gh *)',
];

export function buildArgs(opts: ClaudeRunOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', opts.model];
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.persistSession === false) args.push('--no-session-persistence');

  const disallowed = [...ALWAYS_DISALLOWED];
  if (opts.mode === 'readonly') {
    args.push('--allowedTools', ...READONLY_TOOLS);
    disallowed.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit');
  } else if (opts.mode === 'guarded') {
    args.push('--permission-mode', 'acceptEdits');
    args.push('--allowedTools', ...EDIT_TOOLS, ...GIT_WRITE_TOOLS, ...(opts.allowedTools ?? []));
  } else {
    args.push('--dangerously-skip-permissions');
  }
  args.push('--disallowedTools', ...disallowed);
  return args;
}

/** One-line description of a tool call for the live log. */
export function describeToolUse(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
      return `$ ${truncate(s('command'), 300)}`;
    case 'Read':
      return `Read ${s('file_path')}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${s('file_path')}`;
    case 'Write':
      return `Write ${s('file_path')}`;
    case 'Grep':
      return `Grep "${s('pattern')}"${s('path') ? ` in ${s('path')}` : ''}`;
    case 'Glob':
      return `Glob ${s('pattern')}`;
    case 'TodoWrite': {
      const todos = (input.todos as { content: string; status: string }[] | undefined) ?? [];
      return `Plan: ${todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}`).join(' · ')}`;
    }
    case 'Task':
      return `Subagent: ${s('description')}`;
    default:
      return `${name} ${truncate(JSON.stringify(input), 200)}`;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(content ?? '');
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const args = buildArgs(opts);
    const started = Date.now();
    const child = spawn(config.claudeBin, args, {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'shipyard' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderr = '';
    let final: Record<string, unknown> | null = null;
    let sessionId: string | null = opts.resumeSessionId ?? null;
    let lastText = '';

    const onAbort = () => {
      opts.onEvent({ type: 'status', text: 'Cancelling…' });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        opts.onEvent({ type: 'stderr', text: truncate(line, 500) });
        return;
      }
      const type = msg.type as string;
      if (type === 'system' && msg.subtype === 'init') {
        sessionId = (msg.session_id as string) ?? sessionId;
        opts.onEvent({ type: 'system', text: `Session started · ${String(msg.model ?? opts.model)} · ${opts.cwd}`, data: { sessionId } });
      } else if (type === 'assistant') {
        const content = ((msg.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            lastText = block.text;
            opts.onEvent({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            opts.onEvent({ type: 'tool_use', text: describeToolUse(block.name as string, input), data: { id: block.id, name: block.name, input } });
          }
        }
      } else if (type === 'user') {
        const content = ((msg.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
        for (const block of content) {
          if (block.type === 'tool_result') {
            const text = toolResultText(block.content);
            opts.onEvent({
              type: 'tool_result',
              text: truncate(text.trim(), 2000),
              data: { toolUseId: block.tool_use_id, isError: Boolean(block.is_error) },
            });
          }
        }
      } else if (type === 'system' && msg.subtype === 'post_turn_summary' && typeof msg.status_detail === 'string') {
        opts.onEvent({ type: 'step', text: msg.status_detail });
      } else if (type === 'result') {
        final = msg;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (text.trim()) opts.onEvent({ type: 'stderr', text: truncate(text.trim(), 1000) });
    });

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        sessionId,
        resultText: '',
        structuredOutput: null,
        costUsd: 0,
        durationMs: Date.now() - started,
        numTurns: 0,
        error: `Could not start "${config.claudeBin}": ${err.message}. Is Claude Code installed and on PATH?`,
        permissionDenials: [],
      });
    });

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) handleLine(buffer);
      const r = final as Record<string, unknown> | null;
      const isError = !r || Boolean(r.is_error) || r.subtype !== 'success';
      const cancelled = opts.signal?.aborted ?? false;
      let error: string | null = null;
      if (cancelled) error = 'Cancelled by user';
      else if (!r) error = `Claude exited with code ${code} without a result. ${truncate(stderr.trim(), 1500)}`;
      else if (isError) error = `Claude finished with "${String(r.subtype)}"${r.result ? `: ${truncate(String(r.result), 1000)}` : ''}`;

      resolve({
        ok: !isError && !cancelled,
        sessionId: (r?.session_id as string) ?? sessionId,
        resultText: typeof r?.result === 'string' ? (r.result as string) : lastText,
        structuredOutput: r?.structured_output ?? null,
        costUsd: Number(r?.total_cost_usd ?? 0),
        durationMs: Number(r?.duration_ms ?? Date.now() - started),
        numTurns: Number(r?.num_turns ?? 0),
        error,
        permissionDenials: (r?.permission_denials as unknown[]) ?? [],
      });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
