/** Page and row split targets follow the same rules in the sidebar and background. */
import type { Space, TabInfo } from '../../shared/types';

export function pageSplitTarget(space: Pick<Space, 'split' | 'splitMode' | 'activeTabId'>) {
  return space.splitMode === 'responsive' ? space.split?.[0] : space.activeTabId;
}

export function canDropToSplit(tabs: Record<string, TabInfo>, source: string, target: string | undefined): target is string {
  return !!target && source !== target && !!tabs[source] && !!tabs[target] &&
    tabs[source].device !== 'mobile' && tabs[target].device !== 'mobile';
}
