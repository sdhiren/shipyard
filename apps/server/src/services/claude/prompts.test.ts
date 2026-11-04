import { describe, expect, it } from 'vitest';
import type { ItemRow, ProjectRow } from '../../db/schema.js';
import { discussPrompt, implementPrompt, planPrompt, revisePrompt } from './prompts.js';
import { buildArgs } from './runner.js';

const project = {
  name: 'design-site',
  description: '',
  stack: { languages: ['TypeScript'], frameworks: [], hasTests: true, hasCi: false, keyFiles: [] },
  settings: { customInstructions: '', testCommand: 'make test' },
} as unknown as ProjectRow;
const item = {
  title: 'Match the mockup',
  type: 'feature',
  priority: 'p1',
  effort: null,
  status: 'planned',
  description: 'See attached.',
  acceptanceCriteria: [],
  plan: null,
  openQuestions: [],
  branch: 'shipyard/ds-1-match-the-mockup',
} as unknown as ItemRow;

const files = [
  '- mockup.png (image/png, 412 KB, added with the item) — /data/attachments/p/i/a1/mockup.png',
  '- brief.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 20 KB, added with the item) (format not readable by you) — /data/attachments/p/i/a2/brief.docx',
].join('\n');

const prompts = {
  plan: (f?: string) => planPrompt(project, item, '', f),
  discuss: (f?: string) => discussPrompt(project, item, 'DS-1', '**Owner**: thoughts?', f),
  implement: (f?: string) => implementPrompt(project, item, 'DS-1', '', f),
  revise: (f?: string) => revisePrompt(project, item, 'DS-1', 'Use the new colours', f),
};

describe('attachment blocks in prompts', () => {
  it.each(Object.entries(prompts))('%s lists the attachments with reading and reference-only instructions', (_kind, build) => {
    const prompt = build(files);
    expect(prompt).toContain('/data/attachments/p/i/a1/mockup.png');
    expect(prompt).toContain('brief.docx');
    expect(prompt).toContain('(format not readable by you)');
    expect(prompt).toContain('Read tool');
    expect(prompt).toContain('`pages` parameter');
    expect(prompt).toContain("say you can't read that format instead of guessing");
    expect(prompt).toContain('never copy, move or commit them into the repo or worktree');
    expect(prompt).toContain('the owner must add that file by hand');
  });

  it.each(Object.entries(prompts))('%s has no attachment section without attachments', (_kind, build) => {
    const prompt = build();
    expect(prompt).not.toContain('reference material only');
    expect(prompt).not.toContain('Read tool');
  });

  it('points a revision at the folder holding earlier attachments', () => {
    expect(revisePrompt(project, item, 'DS-1', 'Tweak it', '', '/data/attachments/p/i')).toContain('Earlier attachments on this item are in `/data/attachments/p/i`');
  });
});

describe('buildArgs --add-dir', () => {
  const base = { prompt: '', cwd: '/repo', model: 'opus', onEvent: () => undefined };

  it('passes each extra directory', () => {
    const args = buildArgs({ ...base, mode: 'readonly', addDirs: ['/x', '/y'] });
    expect(args.join(' ')).toContain('--add-dir /x --add-dir /y');
  });

  it('omits the flag without extra directories', () => {
    expect(buildArgs({ ...base, mode: 'guarded' })).not.toContain('--add-dir');
  });
});
