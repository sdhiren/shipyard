import { describe, expect, it } from 'vitest';
import { parseBacklogMarkdown, suggestAllowedTools } from './scanner.js';

const md = `# Backlog

## P0 — Security & correctness bugs

- [x] **B-01 · Remove committed secrets (S)**: done.
- [ ] **B-02 · Redirect endpoint doesn't redirect (S)**: returns JSON instead of 302.
  Continuation line with more detail.
  - Nested detail bullet

## P1 — Testing

- [ ] **T-01 · Repository integration tests (M)**: run against real Postgres.
- [ ] Plain checkbox without bold
* [ ] Star bullet: with a colon description
`;

describe('parseBacklogMarkdown', () => {
  const items = parseBacklogMarkdown(md, 'BACKLOG.md');

  it('skips checked items and keeps unchecked ones', () => {
    expect(items.map((i) => i.title)).toEqual([
      "Redirect endpoint doesn't redirect",
      'Repository integration tests',
      'Plain checkbox without bold',
      'Star bullet',
    ]);
  });

  it('extracts ids, effort and section priority', () => {
    const [b02, t01] = items;
    expect(b02).toMatchObject({ sourceRef: 'BACKLOG.md:B-02', effort: 's', priority: 'p0', type: 'bug' });
    expect(t01).toMatchObject({ sourceRef: 'BACKLOG.md:T-01', effort: 'm', priority: 'p1', type: 'testing' });
  });

  it('folds indented continuation lines into the description', () => {
    expect(items[0]!.description).toContain('Continuation line with more detail.');
    expect(items[0]!.description).toContain('- Nested detail bullet');
  });

  it('uses the line number as the ref when there is no id', () => {
    expect(items[2]!.sourceRef).toMatch(/^BACKLOG\.md:\d+$/);
    expect(items[3]!.description).toBe('with a colon description');
  });
});

describe('suggestAllowedTools', () => {
  it('allow-lists the package manager for the stack', () => {
    const tools = suggestAllowedTools({
      languages: ['Go'],
      frameworks: [],
      packageManagers: ['go modules'],
      hasTests: true,
      hasCi: true,
      hasDocker: false,
      keyFiles: [],
    });
    expect(tools).toContain('Bash(go *)');
    expect(tools).not.toContain('Bash(npm *)');
  });
});
