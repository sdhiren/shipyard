import { FOCUS_LABELS, type AnalysisFocus, type ProjectStack } from '@shipyard/shared';
import type { ItemRow, ProjectRow } from '../../db/schema.js';

/**
 * Prompt builders. Prompts describe the goal and the context; they leave the
 * "how" to Claude, which explores the repository with its own tools.
 */

function stackLine(stack: ProjectStack): string {
  const parts = [
    stack.languages.join(', '),
    stack.frameworks.length ? `frameworks: ${stack.frameworks.join(', ')}` : '',
    stack.hasTests ? 'has tests' : 'no tests detected',
    stack.hasCi ? 'has CI' : 'no CI',
  ].filter(Boolean);
  return parts.join(' · ');
}

function projectContext(project: ProjectRow): string {
  return [
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : '',
    `Stack: ${stackLine(project.stack)}`,
    project.stack.keyFiles.length ? `Start by reading: ${project.stack.keyFiles.join(', ')}` : '',
    project.settings.customInstructions ? `\nOwner's standing instructions:\n${project.settings.customInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function analysisPrompt(opts: {
  project: ProjectRow;
  focus: AnalysisFocus[];
  count: number;
  guidance: string;
  existingTitles: string[];
  recentCommits: string;
}): string {
  const { project, focus, count, guidance, existingTitles, recentCommits } = opts;
  return `You are a senior engineer and product thinker reviewing a side project for its owner. Explore the repository in the current directory and propose the most valuable next pieces of work.

${projectContext(project)}

Focus areas for this review: ${focus.map((f) => FOCUS_LABELS[f]).join(', ')}.
${guidance ? `\nThe owner's steer for this review:\n${guidance}\n` : ''}
Recent commits:
${recentCommits || '(none)'}

Items already on the backlog or recently decided (do not propose these again, or near-duplicates of them):
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join('\n') : '(none)'}

How to work:
- Read the README and any agent or backlog docs first, then the code that matters. Ground every suggestion in what you actually found; cite files in \`affectedFiles\`.
- Propose up to ${count} suggestions, ordered by value to the owner. Prefer concrete, shippable increments (each one a single pull request) over vague themes.
- Write each description in Markdown: the current state, the proposed change, and why it matters. Include clear acceptance criteria that a reviewer could check.
- Score health honestly, 0–10 per dimension, based on what you saw.
- This is a read-only review. Do not modify any files.

Return your answer in the required JSON format.`;
}

function planState(item: ItemRow): string {
  return [
    item.plan ? `\n### Current plan\n${item.plan}` : '',
    item.openQuestions.length ? `\n### Open questions still unanswered\n${item.openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
  ].join('\n');
}

function discussionBlock(discussion: string): string {
  return discussion ? `\n### Discussion with the owner (oldest first)\nDecisions and answers here override the plan where they differ.\n\n${discussion}\n` : '';
}

export function planPrompt(project: ProjectRow, item: ItemRow, discussion = ''): string {
  return `You are planning the implementation of one backlog item for the project in the current directory. Explore the code as needed, then write a plan another engineer (or Claude) can follow to deliver it as a single pull request.

${projectContext(project)}

Backlog item: ${item.title}
Type: ${item.type} · Priority: ${item.priority}${item.effort ? ` · Estimated effort: ${item.effort}` : ''}

${item.description || '(no description)'}
${item.acceptanceCriteria.length ? `\nAcceptance criteria so far:\n${item.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}
${planState(item)}
${discussionBlock(discussion)}

The plan should cover the approach, the ordered steps with the files to touch, how it will be tested${project.settings.testCommand ? ` (the project's check command is \`${project.settings.testCommand}\`)` : ''}, and risks or migration concerns. Refine the acceptance criteria and re-estimate effort. List open questions only when an answer would change the design, and don't ask again about anything the discussion already settled. Keep open questions out of the plan text; return them in openQuestions.

This is a read-only planning step. Do not modify any files. Return your answer in the required JSON format.`;
}

export function discussPrompt(project: ProjectRow, item: ItemRow, key: string, discussion: string): string {
  return `You planned backlog item ${key} for the owner of the project in the current directory, and they've replied in the item's discussion thread. Reply to their latest message the way a thoughtful colleague would: answer questions directly, give your recommendation when they ask for one, and say plainly when you need a decision from them. Explore the code when it helps you give a grounded answer.

${projectContext(project)}

## ${key}: ${item.title}
Type: ${item.type} · Priority: ${item.priority}${item.effort ? ` · Effort: ${item.effort}` : ''} · Status: ${item.status}

${item.description || '(no description)'}
${item.acceptanceCriteria.length ? `\n### Acceptance criteria\n${item.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}
${planState(item) || '\n(There is no plan yet.)'}

### Discussion (oldest first; the last message is the one to reply to)
${discussion}

How to answer:
- Keep the reply focused and short enough to read in a comment thread. Use Markdown.
- If the owner's answers or decisions mean the plan should change (they answer open questions, change scope or approach, or ask you to), return the complete revised plan in updatedPlan: the full plan text, acceptance criteria, effort, and only the questions that are still open. Say in one or two sentences of your reply what you changed. Otherwise set updatedPlan to null.
- If there's no plan yet and the conversation gives you enough to write one, you may return one in updatedPlan.
- This is read-only. Do not modify any files.

Return your answer in the required JSON format.`;
}

export function implementPrompt(project: ProjectRow, item: ItemRow, key: string, discussion = ''): string {
  const test = project.settings.testCommand;
  return `You are implementing one backlog item in this repository. You are working in a dedicated git worktree on branch \`${item.branch}\`; the owner's main checkout is untouched, so work freely here.

${projectContext(project)}

## ${key}: ${item.title}
Type: ${item.type} · Priority: ${item.priority}

${item.description || '(no description)'}
${item.acceptanceCriteria.length ? `\n### Acceptance criteria\n${item.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}
${item.plan ? `\n### Approved plan\n${item.plan}` : ''}
${item.openQuestions.length ? `\n### Questions the owner hasn't answered yet\nMake a sensible, reversible choice for each and call it out in your summary.\n${item.openQuestions.map((q) => `- ${q}`).join('\n')}` : ''}
${discussionBlock(discussion)}

### How to deliver
- Follow the conventions you find in the codebase (structure, naming, error handling, test style) and any CLAUDE.md / AGENTS.md guidance.
- Keep the change focused on this item. Update docs (README, BACKLOG.md entries for this item) when behaviour or setup changes.
- Add or update tests for the new behaviour.${test ? `\n- Verify with \`${test}\` and fix what fails before you finish.` : '\n- Run the project\'s tests or build before you finish, if there are any.'}
- Commit your work with clear conventional commit messages (\`git add\` + \`git commit\`). Do not push and do not open a pull request; Shipyard does that after you finish.

When you are done, end with a short summary for the pull request description: what changed, how it was verified, and anything the reviewer should look at closely.`;
}

export function revisePrompt(project: ProjectRow, item: ItemRow, key: string, feedback: string): string {
  const test = project.settings.testCommand;
  return `The owner reviewed your work on ${key} ("${item.title}") and asked for changes:

${feedback}

Make the requested changes on the current branch, keep the tests passing${test ? ` (\`${test}\`)` : ''}, and commit them. Do not push. End with a short summary of what you changed.`;
}

export function rebasePrompt(project: ProjectRow, item: ItemRow, key: string, opts: { onto: string; ontoSubject: string; conflicts: string[] }): string {
  const test = project.settings.testCommand;
  return `You implemented ${key} ("${item.title}") on branch \`${item.branch}\`. Other work has since merged into the base branch, and Shipyard has started \`git rebase ${opts.onto}\` (latest: "${opts.ontoSubject}") to bring this branch up to date. The rebase stopped with conflicts.

Files with conflicts right now:
${opts.conflicts.map((f) => `- ${f}`).join('\n') || '- (run git status to see them)'}

Resolve the rebase:
- For each conflict, read both sides and the surrounding code. Keep the intent of both changes: what landed on ${opts.onto} and what this branch adds for ${key}. Don't simply pick one side.
- Remove every conflict marker, \`git add\` the resolved files, then run \`git rebase --continue\`. Repeat if later commits conflict too. The editor is non-interactive, so commit messages are kept as they are.
${test ? `- When the rebase is complete, run \`${test}\` and fix anything the merge broke, committing the fixes.` : '- When the rebase is complete, run the tests or build if the project has them, and commit any fixes.'}
- Do not run \`git rebase --abort\`, do not push, and don't make changes unrelated to resolving the rebase.

End with a short summary of how you resolved each conflict.`;
}

export function prBody(item: ItemRow, key: string, summary: string, diffStat: string, base?: { branch: string; sha: string | null }): string {
  return `${summary.trim() || item.title}

---

**Backlog item:** ${key} · ${item.type} · ${item.priority}${base?.sha ? `\n**Based on:** \`${base.branch}\` @ \`${base.sha}\`` : ''}
${item.acceptanceCriteria.length ? `\n**Acceptance criteria**\n${item.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}\n` : ''}
${diffStat ? `<details><summary>Diff stat</summary>\n\n\`\`\`\n${diffStat}\n\`\`\`\n</details>\n` : ''}
_Opened by Shipyard via Claude Code._`;
}
