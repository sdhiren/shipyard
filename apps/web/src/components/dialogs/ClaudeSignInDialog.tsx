import type { ClaudeLoginSession } from '@shipyard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, ExternalLink, KeyRound, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { showError, useClaudeAuth } from '../../api/hooks';
import { cn } from '../../lib/utils';
import { Button, Dialog, Field, Input, Spinner } from '../ui';

type Method = 'claudeai' | 'console';

/**
 * Re-authenticates the Claude Code CLI that Shipyard runs. The server starts
 * `claude auth login`, which opens claude.com; the owner signs in there and
 * pastes back the code it shows. Passwords never pass through Shipyard.
 */
export function ClaudeSignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useClaudeAuth({ pollWhileSigningIn: open });
  const [method, setMethod] = useState<Method>('claudeai');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const status = data?.status;
  const login: ClaudeLoginSession | null = data?.login ?? null;
  const active = login && ['starting', 'waiting_for_code', 'verifying'].includes(login.state);

  // Re-check the real status whenever the dialog opens.
  useEffect(() => {
    if (open) void qc.fetchQuery({ queryKey: ['claude-auth'], queryFn: () => api.claudeAuth(true) });
    else setCode('');
  }, [open, qc]);

  useEffect(() => {
    if (open && login?.state === 'succeeded') toast.success('Signed in to Claude');
  }, [open, login?.state]);

  const refresh = () => qc.fetchQuery({ queryKey: ['claude-auth'], queryFn: () => api.claudeAuth() });

  const start = async () => {
    setBusy(true);
    try {
      await api.startClaudeLogin(method);
      // Re-read rather than use the response: a live update may already be newer.
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      await api.submitClaudeCode(code);
      setCode('');
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (active) void api.cancelClaudeLogin();
    onClose();
  };

  const signedIn = status?.loggedIn === true && !active;
  const showResult = login && (login.state === 'succeeded' || login.state === 'failed');

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-accent" /> Sign in to Claude
        </span>
      }
      description="Shipyard runs Claude Code on this machine, using its sign-in. You sign in on claude.com; your password never passes through Shipyard."
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {login?.state === 'succeeded' ? 'Done' : 'Cancel'}
          </Button>
          {!active && login?.state !== 'succeeded' && (
            <Button variant="primary" icon={<LogIn className="size-3.5" />} loading={busy} onClick={() => void start()}>
              {login?.state === 'failed' ? 'Try again' : signedIn ? 'Sign in again' : 'Start sign-in'}
            </Button>
          )}
          {login?.state === 'waiting_for_code' && (
            <Button variant="primary" loading={busy} disabled={!code.trim()} onClick={() => void submit()}>
              Finish sign-in
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <StatusLine loggedIn={status?.loggedIn ?? null} email={status?.email ?? null} authMethod={status?.authMethod ?? null} />

        {!active && !showResult && (
          <Field label="Account">
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['claudeai', 'Claude subscription', 'Pro, Max, Team or Enterprise'],
                  ['console', 'Anthropic Console', 'API usage billing'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMethod(value)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors',
                    method === value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
                  )}
                >
                  <div className="text-sm text-fg">{label}</div>
                  <div className="text-xs text-faint">{hint}</div>
                </button>
              ))}
            </div>
          </Field>
        )}

        {login?.state === 'starting' && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Starting the sign-in…
          </div>
        )}

        {login?.state === 'waiting_for_code' && (
          <ol className="space-y-4">
            <li>
              <div className="mb-1.5 text-muted">
                <span className="font-medium text-fg">1.</span> The sign-in page should have opened in your browser. If it didn't:
              </div>
              {login.url && (
                <a href={login.url} target="_blank" rel="noreferrer">
                  <Button size="sm" icon={<ExternalLink className="size-3.5" />}>
                    Open the sign-in page
                  </Button>
                </a>
              )}
            </li>
            <li>
              <div className="mb-1.5 text-muted">
                <span className="font-medium text-fg">2.</span> Sign in, then copy the code claude.com shows and paste it here:
              </div>
              <Input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="Paste the code"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </li>
          </ol>
        )}

        {login?.state === 'verifying' && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Checking the code…
          </div>
        )}

        {login?.state === 'succeeded' && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-emerald-400">
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
            <span>You're signed in. Retry anything that failed, and new runs will use this login.</span>
          </div>
        )}

        {login?.state === 'failed' && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-rose-400">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>Sign-in didn't complete{login.error ? `: ${login.error}` : '.'}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function StatusLine({ loggedIn, email, authMethod }: { loggedIn: boolean | null; email: string | null; authMethod: string | null }) {
  if (loggedIn === true) {
    return (
      <div className="flex items-center gap-2 text-emerald-400">
        <CircleCheck className="size-4" /> Signed in{email ? ` as ${email}` : ''}
        {authMethod && authMethod !== 'none' && <span className="text-xs text-faint">({authMethod})</span>}
      </div>
    );
  }
  if (loggedIn === false) {
    return (
      <div className="flex items-center gap-2 text-amber-400">
        <CircleAlert className="size-4" /> Claude Code isn't signed in, so plans, discussions and implementations can't run.
      </div>
    );
  }
  return <div className="text-faint">Checking the current sign-in…</div>;
}
