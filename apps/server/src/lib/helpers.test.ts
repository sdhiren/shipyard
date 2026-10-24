import { describe, expect, it } from 'vitest';
import { buildArgs, describeToolUse } from '../services/claude/runner.js';
import { parseGithubRepo } from '../services/git.js';
import { summarizeChecks } from '../services/github.js';
import { keyPrefixFor, slugify } from './util.js';

describe('keyPrefixFor', () => {
  it.each([
    ['url-shortener', 'US'],
    ['learning-assistant', 'LA'],
    ['job scraping tool', 'JST'],
    ['shipyard', 'SHI'],
    ['orderProcessingApi', 'OPA'],
  ])('%s → %s', (name, key) => expect(keyPrefixFor(name)).toBe(key));
});

describe('slugify', () => {
  it('makes branch-safe slugs', () => {
    expect(slugify('Add rate limiting (per IP) — v2!')).toBe('add-rate-limiting-per-ip-v2');
    expect(slugify('')).toBe('item');
  });
});

describe('parseGithubRepo', () => {
  it.each([
    ['git@github.com:sdhiren/url-shortener.git', 'sdhiren/url-shortener'],
    ['https://github.com/sdhiren/learning-assistant', 'sdhiren/learning-assistant'],
    ['https://github.com/a/b.git/', 'a/b'],
    ['https://gitlab.com/a/b.git', null],
    [null, null],
  ])('%s', (url, repo) => expect(parseGithubRepo(url)).toBe(repo));
});

describe('summarizeChecks', () => {
  it('reports the worst state', () => {
    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing');
    expect(summarizeChecks([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pending');
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing');
    expect(summarizeChecks([{ state: 'SUCCESS' }])).toBe('passing');
  });
});

describe('buildArgs', () => {
  const base = { prompt: '', cwd: '/tmp', model: 'opus', onEvent: () => {} };

  it('keeps analysis read-only', () => {
    const args = buildArgs({ ...base, mode: 'readonly', jsonSchema: { type: 'object' } });
    expect(args).toContain('--json-schema');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const disallowed = args.slice(args.indexOf('--disallowedTools'));
    expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write']));
  });

  it('never lets Claude push or call gh itself', () => {
    for (const mode of ['readonly', 'guarded', 'full'] as const) {
      const args = buildArgs({ ...base, mode });
      expect(args).toEqual(expect.arrayContaining(['Bash(git push*)', 'Bash(gh *)']));
    }
  });

  it('adds project allow-list rules in guarded mode', () => {
    const args = buildArgs({ ...base, mode: 'guarded', allowedTools: ['Bash(go *)'], resumeSessionId: 'abc', maxBudgetUsd: 2 });
    expect(args).toEqual(expect.arrayContaining(['acceptEdits', 'Bash(go *)', '--resume', 'abc', '--max-budget-usd', '2']));
  });
});

describe('describeToolUse', () => {
  it('summarises common tools', () => {
    expect(describeToolUse('Bash', { command: 'go test ./...' })).toBe('$ go test ./...');
    expect(describeToolUse('Edit', { file_path: 'main.go' })).toBe('Edit main.go');
  });
});
