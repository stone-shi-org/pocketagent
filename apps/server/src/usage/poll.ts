export interface Polled<T> {
  /** Cached value, refreshed in the background after the first call primes it. */
  get(): Promise<T>;
  /** Stops the background timer. Any in-flight refresh is left to finish. */
  stop(): void;
}

/**
 * Lazily-started background poll, shared by every usage source.
 *
 * The poll starts on the first `get()` rather than at construction, so
 * booting the app in a test, or on a host missing the binary a source needs,
 * never spawns anything unless a client actually asks for usage info. That
 * first call awaits one live refresh so the browser's first paint reflects a
 * real reading instead of the initial placeholder; every call after that
 * returns the cache instantly and the timer keeps it warm underneath.
 *
 * `doRefresh` must never reject — a source that can fail (a missing binary, a
 * malformed response) reports that by returning its own "unavailable" value,
 * not by throwing, so one broken source can never take the others down with
 * it via `Promise.all` in `UsageService.list`.
 */
export function createPolled<T>(initial: T, refreshMs: number, doRefresh: () => Promise<T>): Polled<T> {
  let snapshot = initial;
  let timer: NodeJS.Timeout | null = null;
  let refreshing: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = doRefresh()
      .then((next) => {
        snapshot = next;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return {
    async get(): Promise<T> {
      if (!timer) {
        await refresh();
        timer = setInterval(() => void refresh(), refreshMs);
        timer.unref?.();
      }
      return snapshot;
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
