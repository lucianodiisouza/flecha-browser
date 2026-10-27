import type { ImportNode } from '../shared/importApply';

/**
 * Reads the bookmarks file every browser can export: the old Netscape format, HTML where
 * each folder is an `<H3>` followed by a `<DL>` of its contents and each bookmark an `<A HREF>`.
 * Browsers write it loosely (`<DT>` and `<p>` are never closed), so this only looks at the
 * tags that matter rather than parsing it as a document.
 *
 * The folder marked as the toolbar (Chrome's "Bookmarks bar", Firefox's "Bookmarks Toolbar")
 * becomes the top level, as it does when reading those browsers directly.
 */
export function parseBookmarksHtml(html: string): ImportNode[] {
  const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  const top: ImportNode[] = [];
  /** The open folders' contents; the innermost last. */
  const stack: ImportNode[][] = [top];
  /** A folder's heading, waiting for the `<DL>` that holds its contents. */
  let heading: { name: string; toolbar: boolean } | undefined;

  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const [, closing, name, attrs] = m;
    const kind = name.toLowerCase();
    if (kind === 'dl') {
      if (closing) {
        if (stack.length > 1) stack.pop();
      } else if (heading?.toolbar && stack[stack.length - 1] === top) {
        // The toolbar's contents go straight into the top level.
        stack.push(top);
        heading = undefined;
      } else if (heading) {
        const children: ImportNode[] = [];
        stack[stack.length - 1].push({ kind: 'folder', name: heading.name, children });
        stack.push(children);
        heading = undefined;
      } else {
        // The outermost list, or one without a heading: its contents join the current folder.
        stack.push(stack[stack.length - 1]);
      }
    } else if (!closing) {
      const text = textUntil(html, kind, tag);
      if (kind === 'h3') {
        heading = { name: text || 'Untitled folder', toolbar: /\bPERSONAL_TOOLBAR_FOLDER\s*=\s*["']?true/i.test(attrs) };
      } else {
        const url = decodeHtml(/\bHREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(1).find((v) => v !== undefined) ?? '');
        if (url) stack[stack.length - 1].push({ kind: 'tab', url, title: text || url });
      }
    }
  }
  return top;
}

/** The text up to `</kind>`, without tags; moves `tag` past it. */
function textUntil(html: string, kind: string, tag: RegExp) {
  const close = new RegExp(`</${kind}\\s*>`, 'gi');
  close.lastIndex = tag.lastIndex;
  const m = close.exec(html);
  const end = m ? m.index : html.length;
  const text = html.slice(tag.lastIndex, end);
  tag.lastIndex = m ? close.lastIndex : end;
  return decodeHtml(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtml(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
    const hex = e[1].toLowerCase() === 'x';
    const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
