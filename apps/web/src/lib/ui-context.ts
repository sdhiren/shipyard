import type { ItemStatus } from '@shipyard/shared';
import { createContext, useContext } from 'react';

/**
 * App-wide UI actions (open the item drawer, new-item dialog, …), provided by
 * <Layout>. Kept in its own module so React Fast Refresh can hot-swap Layout
 * without re-creating the context.
 */
export interface Ui {
  openItem: (id: string) => void;
  newItem: (opts?: { projectId?: string; status?: ItemStatus }) => void;
  addProject: () => void;
  openPalette: () => void;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi() must be used inside <Layout>');
  return ui;
}
