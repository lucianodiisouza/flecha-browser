/** Flecha tab IDs mapped to their live Chromium tabs. */
export class LiveTabs extends Map<string, number> {
  onMembershipChange?: () => void;

  override set(id: string, chromeId: number): this {
    const existed = this.has(id);
    super.set(id, chromeId);
    if (!existed) this.onMembershipChange?.();
    return this;
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.onMembershipChange?.();
    return removed;
  }

  override clear(): void {
    if (!this.size) return;
    super.clear();
    this.onMembershipChange?.();
  }
}
