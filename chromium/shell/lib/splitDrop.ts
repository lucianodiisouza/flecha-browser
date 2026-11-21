/** Page and row split targets follow the same rules in the sidebar and background. */
import type { Space, TabInfo } from '../../shared/types';

export function pageSplitTarget(space: Pick<Space, 'split' | 'splitMode' | 'activeTabId'>, source: string) {
  const active = space.activeTabId;
  if (!active || !space.split?.includes(active)) return active;
  if (space.split.includes(source)) return undefined;
  return space.splitMode === 'responsive' ? space.split[0] : active;
}

export function canDropToSplit(tabs: Record<string, TabInfo>, source: string, target: string | undefined): target is string {
  return !!target && source !== target && !!tabs[source] && !!tabs[target] &&
    tabs[source].device !== 'mobile' && tabs[target].device !== 'mobile';
}
