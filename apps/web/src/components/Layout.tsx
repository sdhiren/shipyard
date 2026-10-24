import { ITEM_STATUSES, type ItemStatus } from '@shipyard/shared';
import { Command } from 'cmdk';
import {
  Anchor,
  CircleAlert,
  FolderPlus,
  Inbox,
  LayoutDashboard,
  Moon,
  Pin,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useHealth, useProjects } from '../api/hooks';
import { useLiveConnection, useLiveUpdates } from '../api/live';
import { UiContext, useUi, type Ui } from '../lib/ui-context';
import { cn, isTypingTarget } from '../lib/utils';
import { AddProjectDialog } from './dialogs/AddProjectDialog';
import { NewItemDialog } from './dialogs/NewItemDialog';
import { ProjectDot } from './domain';
import { ItemDrawer } from './ItemDrawer';
import { Kbd } from './ui';

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('shipyard-theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('shipyard-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function Layout() {
  useLiveUpdates();
  const [params, setParams] = useSearchParams();
  const [newItem, setNewItem] = useState<{ projectId?: string; status?: ItemStatus } | null>(null);
  const [addProject, setAddProject] = useState(false);
  const [palette, setPalette] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const location = useLocation();
  const itemId = params.get('item');

  const openItem = useCallback(
    (id: string) =>
      setParams((p) => {
        p.set('item', id);
        return p;
      }),
    [setParams],
  );
  const closeItem = useCallback(
    () =>
      setParams((p) => {
        p.delete('item');
        return p;
      }),
    [setParams],
  );

  // Infer the current project from the URL so "c" creates items in it.
  const currentProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];

  const ui = useMemo<Ui>(
    () => ({
      openItem,
      newItem: (opts) => setNewItem(opts ?? { projectId: currentProjectId }),
      addProject: () => setAddProject(true),
      openPalette: () => setPalette(true),
    }),
    [openItem, currentProjectId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c' && !itemId) {
        e.preventDefault();
        setNewItem({ projectId: currentProjectId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentProjectId, itemId]);

  return (
    <UiContext.Provider value={ui}>
      <div className="flex h-full">
        <Sidebar theme={theme} toggleTheme={toggleTheme} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {itemId && <ItemDrawer itemId={itemId} onClose={closeItem} />}
      <NewItemDialog open={!!newItem} onClose={() => setNewItem(null)} projectId={newItem?.projectId} status={newItem?.status} />
      <AddProjectDialog open={addProject} onClose={() => setAddProject(false)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </UiContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function NavItem({ to, icon, label, count, end }: { to: string; icon: ReactNode; label: ReactNode; count?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
          isActive ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg',
        )
      }
    >
      <span className="flex size-4 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {!!count && <span className="text-xs text-faint tabular-nums">{count}</span>}
    </NavLink>
  );
}

function Sidebar({ theme, toggleTheme }: { theme: string; toggleTheme: () => void }) {
  const { data: projects } = useProjects();
  const { data: health } = useHealth();
  const live = useLiveConnection();
  const ui = useUi();
  const inbox = projects?.reduce((n, p) => n + p.stats.inbox, 0) ?? 0;
  const activeRuns = projects?.reduce((n, p) => n + p.stats.activeRuns, 0) ?? 0;
  const problems = health && (!health.claude || !health.gh.authenticated);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
          <Anchor className="size-4" />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Shipyard</span>
        <span className={cn('ml-auto size-1.5 rounded-full', live ? 'bg-emerald-400' : 'bg-rose-400')} title={live ? 'Live updates connected' : 'Reconnecting…'} />
      </div>

      <div className="px-3">
        <button
          onClick={ui.openPalette}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-sm text-faint transition-colors hover:border-line-strong"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search or jump…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <nav className="mt-4 space-y-0.5 px-3">
        <NavItem to="/" end icon={<LayoutDashboard className="size-4" />} label="Dashboard" />
        <NavItem to="/inbox" icon={<Inbox className="size-4" />} label="Inbox" count={inbox} />
        <NavItem to="/runs" icon={<Terminal className="size-4" />} label="Claude runs" count={activeRuns} />
      </nav>

      <div className="mt-6 flex items-center justify-between px-5 text-[11px] font-semibold tracking-wider text-faint uppercase">
        Projects
        <button onClick={ui.addProject} className="rounded p-0.5 hover:bg-hover hover:text-fg" title="Add project">
          <Plus className="size-3.5" />
        </button>
      </div>
      <nav className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {projects?.map((p) => (
          <NavItem
            key={p.id}
            to={`/projects/${p.id}`}
            icon={<ProjectDot color={p.color} />}
            label={
              <span className="flex items-center gap-1.5">
                {p.name}
                {p.pinned && <Pin className="size-3 text-faint" />}
                {p.stats.activeRuns > 0 && <Sparkles className="size-3 animate-pulse text-amber-400" />}
              </span>
            }
            count={p.stats.open || undefined}
          />
        ))}
        {projects?.length === 0 && (
          <button onClick={ui.addProject} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted hover:border-accent hover:text-fg">
            <FolderPlus className="size-4" /> Add your first project
          </button>
        )}
      </nav>

      <div className="space-y-1 border-t border-line p-3">
        {problems && (
          <NavLink to="/settings" className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs text-amber-400">
            <CircleAlert className="size-3.5 shrink-0" />
            {!health.claude ? 'Claude CLI not found' : 'GitHub CLI not signed in'}
          </NavLink>
        )}
        <div className="flex items-center gap-1">
          <NavItem to="/settings" icon={<Settings className="size-4" />} label="Settings" />
          <button onClick={toggleTheme} className="ml-auto rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" title="Toggle theme">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Command palette (⌘K)
// ---------------------------------------------------------------------------

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const ui = useUi();
  const { data: projects } = useProjects();
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<{ id: string; key: string; title: string; status: string; projectName: string }[]>([]);

  // Search items across all projects (debounced).
  useEffect(() => {
    if (!open || search.trim().length < 2 || !projects) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const all = await Promise.all(
        projects.map((p) =>
          api
            .items(p.id, { q: search.trim(), status: ITEM_STATUSES.filter((s) => s !== 'archived') })
            .then((list) => list.slice(0, 6).map((i) => ({ id: i.id, key: i.key, title: i.title, status: i.status, projectName: p.name }))),
        ),
      );
      setHits(all.flat().slice(0, 12));
    }, 150);
    return () => clearTimeout(t);
  }, [search, open, projects]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  if (!open) return null;
  const go = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <Command
        label="Command palette"
        shouldFilter={true}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-faint" />
          <Command.Input autoFocus value={search} onValueChange={setSearch} placeholder="Search items, projects, actions…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase">
          <Command.Empty className="px-3 py-6 text-center text-sm text-faint">No results.</Command.Empty>
          {hits.length > 0 && (
            <Command.Group heading="Items">
              {hits.map((h) => (
                <PaletteItem key={h.id} value={`${h.key} ${h.title}`} onSelect={() => go(() => ui.openItem(h.id))}>
                  <span className="font-mono text-xs text-faint">{h.key}</span>
                  <span className="flex-1 truncate">{h.title}</span>
                  <span className="text-xs text-faint">{h.projectName}</span>
                </PaletteItem>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Actions">
            <PaletteItem value="new item create backlog" onSelect={() => go(() => ui.newItem())}>
              <Plus className="size-4 text-faint" /> New backlog item <Kbd>C</Kbd>
            </PaletteItem>
            <PaletteItem value="add project repository" onSelect={() => go(ui.addProject)}>
              <FolderPlus className="size-4 text-faint" /> Add project
            </PaletteItem>
          </Command.Group>
          <Command.Group heading="Go to">
            <PaletteItem value="dashboard home" onSelect={() => go(() => navigate('/'))}>
              <LayoutDashboard className="size-4 text-faint" /> Dashboard
            </PaletteItem>
            <PaletteItem value="inbox suggestions triage" onSelect={() => go(() => navigate('/inbox'))}>
              <Inbox className="size-4 text-faint" /> Inbox
            </PaletteItem>
            <PaletteItem value="claude runs logs" onSelect={() => go(() => navigate('/runs'))}>
              <Terminal className="size-4 text-faint" /> Claude runs
            </PaletteItem>
            <PaletteItem value="settings preferences" onSelect={() => go(() => navigate('/settings'))}>
              <Settings className="size-4 text-faint" /> Settings
            </PaletteItem>
            {projects?.map((p) => (
              <PaletteItem key={p.id} value={`project ${p.name}`} onSelect={() => go(() => navigate(`/projects/${p.id}`))}>
                <ProjectDot color={p.color} /> {p.name}
              </PaletteItem>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function PaletteItem({ children, onSelect, value }: { children: ReactNode; onSelect: () => void; value: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg data-[selected=true]:bg-hover">
      {children}
    </Command.Item>
  );
}
