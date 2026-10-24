import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredRepo, Effort, ItemType, Priority, ProjectStack } from '@shipyard/shared';
import { expandHome } from '../config.js';
import { exec } from '../lib/exec.js';

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const readText = (p: string) => fs.readFile(p, 'utf8').catch(() => '');

const KEY_FILE_CANDIDATES = [
  'README.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'BACKLOG.md',
  'docs/BACKLOG.md',
  'TODO.md',
  'ROADMAP.md',
  'HANDOFF.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'ARCHITECTURE.md',
];

export const BACKLOG_FILES = ['BACKLOG.md', 'docs/BACKLOG.md', 'TODO.md', 'ROADMAP.md'];

/** Detect languages, frameworks and tooling from files on disk. Pure filesystem; no AI. */
export async function detectStack(root: string): Promise<ProjectStack> {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const has = (rel: string) => exists(path.join(root, rel));
  const entries = await fs.readdir(root).catch(() => [] as string[]);

  // JavaScript / TypeScript
  if (await has('package.json')) {
    const pkg = JSON.parse((await readText(path.join(root, 'package.json'))) || '{}') as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    languages.add((await has('tsconfig.json')) || deps.typescript ? 'TypeScript' : 'JavaScript');
    const fw: Record<string, string> = {
      next: 'Next.js',
      react: 'React',
      vue: 'Vue',
      svelte: 'Svelte',
      '@angular/core': 'Angular',
      express: 'Express',
      fastify: 'Fastify',
      '@nestjs/core': 'NestJS',
      hono: 'Hono',
      vite: 'Vite',
      electron: 'Electron',
      'drizzle-orm': 'Drizzle',
      prisma: 'Prisma',
      tailwindcss: 'Tailwind',
      vitest: 'Vitest',
      jest: 'Jest',
      playwright: 'Playwright',
      '@playwright/test': 'Playwright',
    };
    for (const [dep, label] of Object.entries(fw)) if (deps[dep]) frameworks.add(label);
    if (await has('pnpm-lock.yaml')) packageManagers.add('pnpm');
    else if (await has('yarn.lock')) packageManagers.add('yarn');
    else if (await has('bun.lockb')) packageManagers.add('bun');
    else packageManagers.add('npm');
  }

  // Python
  if ((await has('pyproject.toml')) || (await has('requirements.txt')) || (await has('setup.py'))) {
    languages.add('Python');
    const manifest = `${await readText(path.join(root, 'pyproject.toml'))}\n${await readText(path.join(root, 'requirements.txt'))}`.toLowerCase();
    const fw: Record<string, string> = {
      fastapi: 'FastAPI',
      django: 'Django',
      flask: 'Flask',
      playwright: 'Playwright',
      scrapy: 'Scrapy',
      'beautifulsoup4': 'BeautifulSoup',
      pandas: 'pandas',
      sqlalchemy: 'SQLAlchemy',
      pydantic: 'Pydantic',
      pytest: 'pytest',
      streamlit: 'Streamlit',
      typer: 'Typer',
    };
    for (const [dep, label] of Object.entries(fw)) if (manifest.includes(dep)) frameworks.add(label);
    if (await has('uv.lock')) packageManagers.add('uv');
    else if (await has('poetry.lock')) packageManagers.add('poetry');
    else packageManagers.add('pip');
  }

  // Go
  if (await has('go.mod')) {
    languages.add('Go');
    const gomod = await readText(path.join(root, 'go.mod'));
    const fw: Record<string, string> = {
      'gin-gonic/gin': 'Gin',
      'labstack/echo': 'Echo',
      'go-chi/chi': 'chi',
      'gofiber/fiber': 'Fiber',
      'gorm.io/gorm': 'GORM',
      'jackc/pgx': 'pgx',
      testcontainers: 'Testcontainers',
    };
    for (const [dep, label] of Object.entries(fw)) if (gomod.includes(dep)) frameworks.add(label);
    packageManagers.add('go modules');
  }

  // .NET / JVM / Rust / Ruby
  if (entries.some((e) => e.endsWith('.sln') || e.endsWith('.slnx') || e.endsWith('.csproj'))) {
    languages.add('C#');
    frameworks.add('.NET');
    packageManagers.add('dotnet');
  }
  if ((await has('pom.xml')) || (await has('build.gradle')) || (await has('build.gradle.kts'))) {
    languages.add((await has('build.gradle.kts')) ? 'Kotlin' : 'Java');
    packageManagers.add((await has('pom.xml')) ? 'maven' : 'gradle');
  }
  if (await has('Cargo.toml')) {
    languages.add('Rust');
    packageManagers.add('cargo');
  }
  if (await has('Gemfile')) {
    languages.add('Ruby');
    packageManagers.add('bundler');
  }

  const hasTests =
    (await has('tests')) ||
    (await has('test')) ||
    (await has('__tests__')) ||
    frameworks.has('Vitest') ||
    frameworks.has('Jest') ||
    frameworks.has('pytest') ||
    (languages.has('Go') && (await quickGrepFiles(root, '_test.go')));

  const keyFiles: string[] = [];
  for (const f of KEY_FILE_CANDIDATES) if (await has(f)) keyFiles.push(f);

  return {
    languages: [...languages],
    frameworks: [...frameworks],
    packageManagers: [...packageManagers],
    hasTests,
    hasCi: await has('.github/workflows'),
    hasDocker: (await has('Dockerfile')) || entries.some((e) => /^(docker-)?compose\.ya?ml$/.test(e)),
    keyFiles,
  };
}

async function quickGrepFiles(root: string, suffix: string): Promise<boolean> {
  const r = await exec('git', ['ls-files', `*${suffix}`], { cwd: root, timeoutMs: 15_000 }).catch(() => null);
  return !!r && r.code === 0 && r.stdout.trim().length > 0;
}

/** A sensible verification command for the stack, used as the default `testCommand`. */
export async function suggestTestCommand(root: string, stack: ProjectStack): Promise<string> {
  const makefile = await readText(path.join(root, 'Makefile'));
  if (/^test:/m.test(makefile)) return 'make test';
  if (stack.languages.includes('Go')) return 'go test ./...';
  if (stack.languages.includes('TypeScript') || stack.languages.includes('JavaScript')) {
    const pkg = JSON.parse((await readText(path.join(root, 'package.json'))) || '{}') as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) {
      const pm = stack.packageManagers[0] ?? 'npm';
      return pm === 'npm' ? 'npm test' : `${pm} test`;
    }
  }
  if (stack.languages.includes('Python')) return stack.packageManagers.includes('uv') ? 'uv run pytest' : 'pytest';
  if (stack.languages.includes('C#')) return 'dotnet test';
  if (stack.languages.includes('Rust')) return 'cargo test';
  return '';
}

/** Shell commands Claude may run without asking in "guarded" autonomy. */
export function suggestAllowedTools(stack: ProjectStack): string[] {
  const tools = new Set<string>(['Bash(make *)']);
  for (const pm of stack.packageManagers) {
    if (pm === 'npm') ['Bash(npm *)', 'Bash(npx *)', 'Bash(node *)'].forEach((t) => tools.add(t));
    if (pm === 'pnpm') ['Bash(pnpm *)', 'Bash(node *)'].forEach((t) => tools.add(t));
    if (pm === 'yarn') ['Bash(yarn *)', 'Bash(node *)'].forEach((t) => tools.add(t));
    if (pm === 'bun') tools.add('Bash(bun *)');
    if (pm === 'uv') ['Bash(uv *)', 'Bash(python *)', 'Bash(pytest *)'].forEach((t) => tools.add(t));
    if (pm === 'poetry') ['Bash(poetry *)', 'Bash(python *)', 'Bash(pytest *)'].forEach((t) => tools.add(t));
    if (pm === 'pip') ['Bash(python *)', 'Bash(python3 *)', 'Bash(pytest *)', 'Bash(pip install *)'].forEach((t) => tools.add(t));
    if (pm === 'go modules') ['Bash(go *)', 'Bash(gofmt *)', 'Bash(golangci-lint *)'].forEach((t) => tools.add(t));
    if (pm === 'dotnet') tools.add('Bash(dotnet *)');
    if (pm === 'cargo') tools.add('Bash(cargo *)');
    if (pm === 'maven') tools.add('Bash(mvn *)');
    if (pm === 'gradle') ['Bash(gradle *)', 'Bash(./gradlew *)'].forEach((t) => tools.add(t));
    if (pm === 'bundler') ['Bash(bundle *)', 'Bash(ruby *)'].forEach((t) => tools.add(t));
  }
  return [...tools];
}

// ---------------------------------------------------------------------------
// Importers: BACKLOG.md style checklists and TODO/FIXME comments
// ---------------------------------------------------------------------------

export interface RawImport {
  title: string;
  description: string;
  sourceRef: string;
  source: 'backlog_file' | 'todo_comment' | 'github_issue';
  type: ItemType;
  priority?: Priority;
  effort?: Effort;
}

const SIZE_TO_EFFORT: Record<string, Effort> = { XS: 'xs', S: 's', M: 'm', L: 'l', XL: 'xl' };

/**
 * Parse unchecked "- [ ]" items from a markdown backlog. Understands the common
 * "**ID · Title (S)**: details" convention and P0–P3 section headings.
 */
export function parseBacklogMarkdown(markdown: string, file: string): RawImport[] {
  const lines = markdown.split('\n');
  const out: RawImport[] = [];
  let sectionPriority: Priority | undefined;
  let sectionType: ItemType = 'feature';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      const h = heading[1]!;
      const p = h.match(/\bP([0-3])\b/i);
      sectionPriority = p ? (`p${p[1]}` as Priority) : sectionPriority;
      sectionType = inferType(h, 'feature');
      continue;
    }
    const item = line.match(/^(\s*)[-*]\s+\[ \]\s+(.*)$/);
    if (!item) continue;
    const indent = item[1]!.length;
    let text = item[2]!.trim();

    // Collect continuation lines (indented deeper than the bullet).
    const extra: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() === '') break;
      const nextIndent = next.match(/^(\s*)/)![1]!.length;
      if (nextIndent <= indent || /^\s*[-*]\s+\[[ x]\]/i.test(next)) break;
      extra.push(next.trim());
      i++;
    }

    let title = text;
    let rest = '';
    let effort: Effort | undefined;
    let id: string | undefined;
    const bold = text.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (bold) {
      title = bold[1]!;
      rest = bold[2]!;
    } else {
      const colon = text.indexOf(': ');
      if (colon > 0 && colon < 120) {
        title = text.slice(0, colon);
        rest = text.slice(colon + 2);
      }
    }
    const idMatch = title.match(/^([A-Z]{1,4}-\d{1,4})\s*[·:\-–]\s*/);
    if (idMatch) {
      id = idMatch[1];
      title = title.slice(idMatch[0].length);
    }
    const size = title.match(/\s*\((XS|S|M|L|XL)\)\s*$/i);
    if (size) {
      effort = SIZE_TO_EFFORT[size[1]!.toUpperCase()];
      title = title.slice(0, size.index);
    }
    text = [rest, ...extra].filter(Boolean).join('\n');
    out.push({
      title: title.replace(/[`*_]/g, '').trim().slice(0, 200),
      description: text,
      sourceRef: `${file}:${id ?? i + 1}`,
      source: 'backlog_file',
      type: inferType(`${title} ${id ?? ''}`, sectionType),
      priority: sectionPriority,
      effort,
    });
  }
  return out.filter((r) => r.title.length >= 3);
}

function inferType(text: string, fallback: ItemType): ItemType {
  const t = text.toLowerCase();
  if (/\b(bugs?|fix(es)?|broken|crash|race)\b/.test(t)) return 'bug';
  if (/\b(security|secret|auth|vuln|xss|csrf|injection)\b/.test(t)) return 'security';
  if (/\b(tests?|testing|coverage|e2e|end-to-end)\b/.test(t)) return 'testing';
  if (/\b(perf|performance|latency|cache|slow|optimi[sz])/.test(t)) return 'performance';
  if (/\b(doc|readme|documentation)\b/.test(t)) return 'docs';
  if (/\b(refactor|cleanup|debt|quality|lint|layout|structure)\b/.test(t)) return 'tech_debt';
  if (/\b(ci|tooling|dx|developer)\b/.test(t)) return 'dx';
  return fallback;
}

export async function scanBacklogFiles(root: string): Promise<RawImport[]> {
  const out: RawImport[] = [];
  for (const f of BACKLOG_FILES) {
    const md = await readText(path.join(root, f));
    if (md) out.push(...parseBacklogMarkdown(md, f));
  }
  return out;
}

/** TODO/FIXME/HACK comments in tracked files, via `git grep` (respects .gitignore). */
export async function scanTodoComments(root: string, limit = 150): Promise<RawImport[]> {
  const r = await exec(
    'git',
    ['grep', '-n', '-I', '-E', '(//|#|/\\*|<!--|--)[[:space:]]*(TODO|FIXME|HACK|XXX)', '--', '.', ':!*.md', ':!*lock*', ':!vendor/', ':!node_modules/', ':!dist/'],
    { cwd: root, timeoutMs: 30_000 },
  ).catch(() => null);
  if (!r || r.code !== 0) return [];
  const out: RawImport[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNo, content] = m;
    const tag = content!.match(/\b(TODO|FIXME|HACK|XXX)\b[:(]?\s*(.*)$/);
    if (!tag) continue;
    const body = tag[2]!.replace(/\*\/|-->/g, '').replace(/^\)?:?\s*/, '').trim();
    if (body.length < 4) continue;
    out.push({
      title: body.slice(0, 120),
      description: `Found a \`${tag[1]}\` comment in \`${file}:${lineNo}\`:\n\n> ${body}`,
      sourceRef: `${file}:${lineNo}`,
      source: 'todo_comment',
      type: tag[1] === 'FIXME' ? 'bug' : 'tech_debt',
      priority: tag[1] === 'FIXME' ? 'p1' : 'p3',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Find git repositories one or two levels below the given roots. */
export async function discoverRepos(roots: string[], knownPaths: Set<string>): Promise<DiscoveredRepo[]> {
  const found = new Map<string, DiscoveredRepo>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      const remote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 5000 }).catch(() => null);
      found.set(dir, {
        path: dir,
        name: path.basename(dir),
        remoteUrl: remote && remote.code === 0 ? remote.stdout.trim() : null,
        alreadyAdded: knownPaths.has(dir),
      });
      return;
    }
    if (depth >= 2) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'Library', 'Applications'].includes(e.name))
        .slice(0, 80)
        .map((e) => visit(path.join(dir, e.name), depth + 1)),
    );
  };
  await Promise.all(roots.map((r) => visit(path.resolve(expandHome(r)), 0)));
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
