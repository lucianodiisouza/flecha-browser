export type UseRow = (key: string, create: () => HTMLElement) => HTMLElement;

/** Owns the direct children of a list. Nested folders and split rows own their own lists. */
export function keyedRows(parent: HTMLElement, draw: (use: UseRow) => void) {
  const previous = new Map(Array.from(parent.children, child => {
    const row = child as HTMLElement;
    return [row.dataset.rowKey, row] as const;
  }));
  const rows: HTMLElement[] = [];
  draw((key, create) => {
    let row = previous.get(key);
    if (row) previous.delete(key);
    else {
      row = create();
      row.dataset.rowKey = key;
    }
    rows.push(row);
    return row;
  });
  for (const obsolete of previous.values()) obsolete.remove();
  let cursor = parent.firstElementChild;
  for (const row of rows) {
    if (row !== cursor) {
      // Chromium's state-preserving move keeps keyboard focus during reordering.
      if (row.parentElement === parent) parent.moveBefore(row, cursor);
      else parent.insertBefore(row, cursor);
    }
    cursor = row.nextElementSibling;
  }
}
