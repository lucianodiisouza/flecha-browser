import type { TabInfo, UiState } from '../shared/types';

type Fields = Omit<UiState, 'tabs'>;
export interface StateUpdate {
  fields: Partial<Fields>;
  cleared: string[];
  tabs: Record<string, TabInfo>;
  removed: string[];
}

/** Shared across windows. History never crosses the page port. */
export class OpenTabSnapshot {
  readonly tabs: Record<string, TabInfo> = Object.create(null);

  update(open: Record<string, TabInfo>, dirty?: ReadonlySet<string>) {
    const tabs: Record<string, TabInfo> = Object.create(null);
    const removed: string[] = [];
    if (!dirty) for (const id of Object.keys(this.tabs)) {
      if (Object.hasOwn(open, id)) continue;
      delete this.tabs[id];
      removed.push(id);
    }
    for (const id of dirty ?? Object.keys(open)) {
      // A metadata event cannot change membership (including a closed window's Today tabs).
      if (!open[id] || (dirty && !Object.hasOwn(this.tabs, id))) continue;
      const { history, ...next } = open[id];
      const previous = this.tabs[id];
      const same = previous && (Object.keys(next) as (keyof typeof next)[]).every(k => next[k] === previous[k])
        && (Object.keys(previous) as (keyof typeof next)[]).every(k => previous[k] === next[k]);
      if (!same) this.tabs[id] = tabs[id] = next;
    }
    return { tabs, removed };
  }
}

/** Store values can mutate in place. Keep the last wire values, not references to them. */
export function changedFields(previous: Map<string, string>, fields: Partial<Fields>, full: boolean) {
  const changed: Record<string, unknown> = {};
  const cleared: string[] = [];
  if (full) for (const key of previous.keys()) {
    if (!Object.hasOwn(fields, key)) { previous.delete(key); cleared.push(key); }
  }
  for (const [key, value] of Object.entries(fields)) {
    const encoded = JSON.stringify(value);
    if (previous.get(key) === encoded) continue;
    if (encoded === undefined) { previous.delete(key); cleared.push(key); }
    else { previous.set(key, encoded); changed[key] = value; }
  }
  return { fields: changed as Partial<Fields>, cleared };
}

export function applyStateUpdate(state: UiState, update: StateUpdate): UiState {
  const next = { ...state, ...update.fields };
  for (const key of update.cleared) Reflect.deleteProperty(next, key);
  if (update.removed.length || Object.keys(update.tabs).length) {
    next.tabs = { ...state.tabs, ...update.tabs };
    for (const id of update.removed) delete next.tabs[id];
  }
  return next;
}
