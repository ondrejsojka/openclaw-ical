/**
 * Feed fetching, in-memory caching and secret-safe error redaction.
 *
 * Simplicity contract (2026-09-06, user-endorsed simplification review):
 *  - One fixed TTL and timeout live as constants here; not configurable.
 *  - A calendar's URL comes from exactly ONE source:
 *      url  — either a plain https URL string, or an OpenClaw SecretRef
 *             object ({provider?, source, id}) resolved through the host
 *             secrets runtime (0.1.2+),
 *      secretEnv — legacy: env var holding the COMPLETE URL.
 * url XOR secretEnv; an object `url` needs a ref resolver (provided by the
 * plugin entry from the OpenClaw runtime context).
 */

/** OpenClaw SecretRef shape ({provider?, source, id}); resolution is host-side. */
export interface SecretRefLike {
  provider?: string;
  source: string;
  id: string;
}

export function isSecretRefLike(v: unknown): v is SecretRefLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { source?: unknown }).source === "string" &&
    typeof (v as { id?: unknown }).id === "string"
  );
}

export interface FeedConfig {
  id: string;
  name: string;
  /** ICS feed URL (https) or SecretRef object. Mutually exclusive with secretEnv. */
  url?: string | SecretRefLike;
  /** Env var holding the COMPLETE feed URL. Mutually exclusive with url. */
  secretEnv?: string;
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface CacheEntry {
  raw: string;
  /** Last SUCCESSFUL fetch time. Staleness is derived from this. */
  fetchedAt: number;
  /** Last ATTEMPT time (success or failure) — backoff gate only. */
  lastAttempt: number;
  /** Resolved URL the bytes came from; guards against ID reuse across reconfigs. */
  sourceKey: string;
}

export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export class FeedFetchError extends Error {
  constructor(
    public readonly feedId: string,
    message: string,
  ) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export class FeedCache {
  private entries = new Map<string, CacheEntry>();

  has(feedId: string): boolean {
    return this.entries.has(feedId);
  }

  fetchedAt(feedId: string): number | undefined {
    return this.entries.get(feedId)?.fetchedAt;
  }

  put(feedId: string, raw: string, at: number = Date.now(), sourceKey: string = ""): void {
    this.entries.set(feedId, { raw, fetchedAt: at, lastAttempt: at, sourceKey });
  }

  raw(feedId: string): string | undefined {
    return this.entries.get(feedId)?.raw;
  }

  /** True when the cached bytes belong to a different resolved source URL. */
  sourceChanged(feedId: string, sourceKey: string): boolean {
    const entry = this.entries.get(feedId);
    if (!entry) return false;
    return entry.sourceKey !== "" && sourceKey !== "" && entry.sourceKey !== sourceKey;
  }

  /** Raw entry for staleness/backoff bookkeeping (no copy; internal use). */
  entry(feedId: string): CacheEntry | undefined {
    return this.entries.get(feedId);
  }

  /** Drop whatever we hold for this feed (e.g. it now points at a new source). */
  evict(feedId: string): void {
    this.entries.delete(feedId);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Strip every configured URL, its path, and percent-decoded variants from text. */
export function makeRedactor(urls: string[]): (s: string) => string {
  const needles = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    needles.add(url);
    try {
      needles.add(new URL(url).pathname);
    } catch {
      /* path stays */
    }
    try {
      needles.add(decodeURIComponent(url));
    } catch {
      /* not encodable */
    }
    try {
      needles.add(decodeURIComponent(new URL(url).pathname));
    } catch {
      /* not encodable */
    }
    const at = url.indexOf("://");
    if (at >= 0) needles.add(url.slice(at + 3));
  }
  const sorted = [...needles].filter(Boolean).sort((a, b) => b.length - a.length);
  return (s: string) => {
    if (!s) return s;
    let out = s;
    for (const needle of sorted) {
      if (needle.length < 8) continue;
      out = out.split(needle).join("[redacted]");
    }
    return out;
  };
}

export type RefResolver = (ref: SecretRefLike) => Promise<string>;

/** Resolve the full feed URL from config (+ optional SecretRef resolver). Never logged. */
export async function resolveFeedUrl(
  feed: FeedConfig,
  resolveRef?: RefResolver,
): Promise<string> {
  let raw: string;
  if (feed.secretEnv) {
    const value = process.env[feed.secretEnv];
    if (!value) {
      throw new FeedFetchError(feed.id, `env ${feed.secretEnv} is not set`);
    }
    if (feed.url !== undefined && feed.url !== null && feed.url !== "") {
      throw new FeedFetchError(feed.id, "set either url or secretEnv, not both");
    }
    raw = value.trim();
  } else if (isSecretRefLike(feed.url)) {
    if (!resolveRef) {
      throw new FeedFetchError(feed.id, "SecretRef url needs a secrets runtime context");
    }
    raw = (await resolveRef(feed.url)).trim();
  } else if (typeof feed.url === "string" && feed.url) {
    raw = feed.url.trim();
  } else {
    throw new FeedFetchError(feed.id, "calendar needs url or secretEnv");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FeedFetchError(feed.id, "feed URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FeedFetchError(feed.id, "feed URL must be http(s)"); // webcal:// → rewrite to https:// at config time
  }
  return raw;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface FeedOutcome {
  raw: string;
  fetchedAt: number;
  stale: boolean;
  /** Seconds since the last successful fetch; present whenever data is stale. */
  ageSeconds?: number;
}

/**
 * Return feed bytes: fresh cache, network fetch, or last-good-copy fallback.
 * `validate` (optional) throws when freshly fetched bytes are unusable — the
 * previous good copy is kept in that case instead of being overwritten.
 */
export async function ensureFeed(
  feed: FeedConfig,
  ttlMs: number,
  timeoutMs: number,
  cache: FeedCache,
  validate?: (raw: string) => void,
  fetchImpl?: FetchLike,
  runtimeResolveRef?: RefResolver,
): Promise<FeedOutcome> {
  const doFetch = fetchImpl ?? fetch;
  const url = await resolveFeedUrl(feed, runtimeResolveRef);
  const now = Date.now();

  // If this id was reconfigured to a different source URL, the cached bytes
  // are a DIFFERENT calendar. Serving them under the new id would be a
  // wrong-calendar answer — drop them before any hit/fallback logic.
  if (cache.sourceChanged(feed.id, url)) {
    cache.evict(feed.id);
  }
  const rawEntry = cache.entry(feed.id);

  if (rawEntry) {
    const age = now - rawEntry.fetchedAt;
    // Fresh: within TTL since last SUCCESS.
    if (age <= ttlMs) {
      return { raw: rawEntry.raw, fetchedAt: rawEntry.fetchedAt, stale: false };
    }
    // Backoff: a recent failed attempt — serve the old bytes, still honestly stale.
    if (now - rawEntry.lastAttempt < ttlMs) {
      return {
        raw: rawEntry.raw,
        fetchedAt: rawEntry.fetchedAt,
        stale: true,
        ageSeconds: Math.max(0, Math.round(age / 1000)),
      };
    }
  }

  // Fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new FeedFetchError(feed.id, `HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      throw new FeedFetchError(feed.id, "feed too large");
    }
    // Bounded streaming: count BYTES as they arrive and abort past the limit.
    // (response.text() would buffer the entire body first, and String.length
    // counts UTF-16 units, not bytes.)
    let bytes: Buffer;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          controller.abort();
          throw new FeedFetchError(feed.id, "feed body too large");
        }
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks);
    } else {
      bytes = Buffer.from(await response.text(), "utf8");
      if (bytes.byteLength > MAX_BODY_BYTES) {
        throw new FeedFetchError(feed.id, "feed body too large");
      }
    }
    const text = bytes.toString("utf8");
    // Bytes must be usable before they may evict the previous good copy.
    validate?.(text);
    cache.put(feed.id, text, Date.now(), url);
    return { raw: text, fetchedAt: Date.now(), stale: false };
  } catch (error) {
    if (rawEntry) {
      rawEntry.lastAttempt = Date.now();
    }
    if (rawEntry?.raw) {
      return {
        raw: rawEntry.raw,
        fetchedAt: rawEntry.fetchedAt,
        stale: true,
        ageSeconds: Math.max(0, Math.round((Date.now() - rawEntry.fetchedAt) / 1000)),
      };
    }
    if (error instanceof FeedFetchError) throw error;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new FeedFetchError(feed.id, message);
  } finally {
    clearTimeout(timer);
  }
}
