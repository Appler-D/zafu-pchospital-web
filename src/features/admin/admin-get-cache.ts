/** 有界短期缓存；单个定时器回收空闲期间的过期结果，读写按 LRU 淘汰。 */
export class AdminGetCache<T> {
  private readonly entries = new Map<string, { expires: number; value: T }>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly capacity = 100,
    private readonly ttl = 15_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T): void {
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + this.ttl, value: structuredClone(value) });
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.schedule();
  }

  clear(): void {
    this.entries.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(key);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.entries.size === 0) return;
    const expires = Math.min(...Array.from(this.entries.values(), (entry) => entry.expires));
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.prune();
        this.schedule();
      },
      Math.max(0, expires - Date.now()),
    );
    this.timer.unref?.();
  }
}
