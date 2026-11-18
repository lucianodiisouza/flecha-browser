import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArcImport, ImportNode, ImportTab } from '../shared/importApply';

/**
 * Reads Arc's local sidebar file (~/Library/Application Support/Arc/StorableSidebar.json).
 *
 * Shape, as observed on disk: `sidebar.containers[n]` holds `spaces` and `items`, both
 * flat arrays alternating `"<id>", { ...object }`. Each space lists
 * `containerIDs: ["pinned", <id>, "unpinned", <id>]`, which point at items whose
 * `childrenIds` are the sidebar entries. An item's `data` is `{ tab: { savedURL, savedTitle } }`
 * for a tab or `{ list: {} }` for a folder. `topAppsContainerIDs` points at the favorites.
 */

export type { ArcImport, ImportNode, ImportTab } from '../shared/importApply';

interface ArcItem {
  id: string;
  title?: string | null;
  childrenIds?: string[];
  data?: { tab?: { savedURL?: string; savedTitle?: string }; list?: unknown };
}

interface ArcSpace {
  id: string;
  title?: string | null;
  containerIDs?: unknown[];
  customInfo?: { iconType?: { emoji_v2?: string; icon?: string }; windowTheme?: { primaryColorPalette?: { midTone?: ArcColor } } };
  /** `{ default: true }`, or `{ custom: … }` for a Space on a profile of its own. */
  profile?: Record<string, unknown>;
}

interface ArcColor {
  red?: number;
  green?: number;
  blue?: number;
}

/** Arc's built-in Space icons (SF Symbols names) that have a close emoji; the rest get none. */
const ARC_ICONS: Record<string, string> = {
  checkbox: '☑️', star: '⭐', heart: '❤️', briefcase: '💼', book: '📖', house: '🏠', home: '🏠', bolt: '⚡',
  flame: '🔥', leaf: '🌿', globe: '🌐', gamecontroller: '🎮', music: '🎵', camera: '📷', paintbrush: '🖌️',
  hammer: '🔨', flag: '🚩', bookmark: '🔖', cart: '🛒', airplane: '✈️', graduationcap: '🎓', terminal: '💻',
  moon: '🌙', sun: '☀️', cloud: '☁️', person: '👤', bubble: '💬', envelope: '✉️', calendar: '📅', folder: '📁',
};

/**
 * Arc's theme color as a Flecha Space color: its mid tone, mixed 40/60 with white, so it reads
 * as the same pastel as Flecha's own colors. Arc stores extended sRGB, which can go past 0–1.
 */
export function arcColor(color: ArcColor | undefined): string | undefined {
  if (!color || [color.red, color.green, color.blue].some((c) => typeof c !== 'number' || Number.isNaN(c))) return undefined;
  const channel = (c: number) => Math.round((Math.min(1, Math.max(0, c)) * 0.4 + 0.6) * 255).toString(16).padStart(2, '0');
  return `#${channel(color.red!)}${channel(color.green!)}${channel(color.blue!)}`;
}

function arcIcon(name: string | undefined) {
  if (!name) return undefined;
  const base = name.toLowerCase().split('.')[0];
  return ARC_ICONS[base];
}

/** Electron's appData on macOS; spelled out so the native messaging host can read it without Electron. */
export function arcSidebarPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json');
}

export function readArcSidebar(file = arcSidebarPath()): ArcImport {
  return parseArcSidebar(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function parseArcSidebar(json: any): ArcImport {
  const containers: any[] = json?.sidebar?.containers ?? [];
  const main = containers.find((c) => Array.isArray(c?.spaces) && Array.isArray(c?.items));
  if (!main) throw new Error('This does not look like an Arc StorableSidebar.json file.');

  const items = new Map<string, ArcItem>();
  for (const entry of main.items) if (isObject(entry) && typeof entry.id === 'string') items.set(entry.id, entry as ArcItem);

  const toTab = (item: ArcItem): ImportTab | undefined => {
    const url = item.data?.tab?.savedURL;
    return url ? { url, title: item.title || item.data?.tab?.savedTitle || url } : undefined;
  };

  const toNodes = (ids: string[] = []): ImportNode[] =>
    ids.flatMap((id): ImportNode[] => {
      const item = items.get(id);
      if (!item) return [];
      if (item.data?.list) return [{ kind: 'folder', name: item.title || 'Untitled folder', children: toNodes(item.childrenIds) }];
      const tab = toTab(item);
      return tab ? [{ kind: 'tab', ...tab }] : [];
    });

  const flatTabs = (nodes: ImportNode[]): ImportTab[] =>
    nodes.flatMap((n) => (n.kind === 'tab' ? [{ url: n.url, title: n.title }] : flatTabs(n.children)));

  const containerChildren = (space: ArcSpace, key: 'pinned' | 'unpinned') => {
    const ids = space.containerIDs ?? [];
    const at = ids.indexOf(key);
    const id = at >= 0 ? ids[at + 1] : undefined;
    return typeof id === 'string' ? items.get(id)?.childrenIds : undefined;
  };

  const spaces = (main.spaces as unknown[]).filter(isObject).map((raw) => {
    const space = raw as ArcSpace;
    return {
      name: space.title || 'Space',
      emoji: space.customInfo?.iconType?.emoji_v2 ?? arcIcon(space.customInfo?.iconType?.icon),
      color: arcColor(space.customInfo?.windowTheme?.primaryColorPalette?.midTone),
      isolated: !!space.profile && !space.profile.default,
      pinned: toNodes(containerChildren(space, 'pinned')),
      today: flatTabs(toNodes(containerChildren(space, 'unpinned'))),
    };
  });

  const favoritesId = (main.topAppsContainerIDs as unknown[] | undefined)?.find(
    (id): id is string => typeof id === 'string' && items.has(id),
  );
  const favorites = favoritesId ? flatTabs(toNodes(items.get(favoritesId)?.childrenIds)) : [];

  return { spaces, favorites };
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
