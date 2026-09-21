import { Logger } from '@nestjs/common';
import type {
  MetadataProviderCandidate,
  MetadataProviderFailure,
  MetadataProviderHost,
  MetadataProviderPlugin,
  MetadataProviderQuery,
  MetadataProviderRequestInit,
} from '@bookorbit/plugin-api';
import { pluginProviderKey, parseSeriesIndex, type ConcreteBookMediaKind, type MetadataCandidate, type PluginProviderKey } from '@bookorbit/types';

import { fetchForPlugin } from '../../common/utils/plugin-fetch';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { isPublishedDateKey, parsePublishedDateKey, parsePublishedYear, publishedYearFromDateKey } from '../../common/utils/published-date.utils';
import { withDeadline } from '../../common/utils/with-deadline.utils';
import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import type { MetadataProvider } from '../metadata-fetch/providers/metadata-provider';
import type { MetadataSearchParams } from '../metadata-fetch/providers/metadata-search-params';
import { normalizeMaxCandidates } from '../metadata-fetch/providers/provider-utils';
import { DEFAULT_PLUGIN_TIMEOUT_MS } from './plugin-shape';

/**
 * Bounds on what one call may hand back. A plugin is hand-written JavaScript with no compile-time
 * contract, so these are the numbers a result set is allowed to cost rather than a statement about
 * any real source: a source returning many times its own page size is malfunctioning either way.
 */
const DEFAULT_MAX_CANDIDATES = 10;
const MAX_PLUGIN_CANDIDATES = 25;
const MAX_TEXT_LENGTH = 1_000;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_LIST_ITEMS = 50;
const MAX_URL_LENGTH = 2_000;
const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_PAGE_COUNT = 100_000;
const MAX_SLEEP_MS = 10_000;

/**
 * Wraps a plugin so the rest of the metadata pipeline sees an ordinary provider and never learns
 * that this one came off disk.
 *
 * The wrapper is what a well-behaved plugin is held to, not a sandbox: a plugin runs in this process
 * with this process's reach, and the loader states that trade openly. What the wrapper does hold is
 * every path through it. `host.fetch` applies the address policy and the deadline, whatever a plugin
 * throws is normalised here, and what it returns is reduced to what the pipeline is willing to
 * believe, because one malformed row must not fail a whole fetch.
 */
export class PluginMetadataProvider implements MetadataProvider {
  readonly key: PluginProviderKey;
  readonly label: string;
  readonly description?: string;
  readonly version?: string;
  readonly identifiable = false as const;
  readonly timeoutMs: number;
  readonly mediaKinds?: readonly ConcreteBookMediaKind[];

  private readonly logger: Logger;

  constructor(private readonly definition: MetadataProviderPlugin) {
    this.key = pluginProviderKey(definition.type);
    this.label = definition.label;
    this.description = definition.description;
    this.version = definition.version;
    this.timeoutMs = definition.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS;
    this.mediaKinds = definition.mediaKinds as readonly ConcreteBookMediaKind[] | undefined;
    this.logger = new Logger(`plugin:${definition.type}`);
  }

  async search(params: MetadataSearchParams): Promise<MetadataCandidate[]> {
    const query = toQuery(params);
    if (!query.title && !query.author && !query.isbn) return [];

    const signal = params.signal ?? new AbortController().signal;
    const found = await withDeadline(this.definition.search(query, this.host(signal), signal), signal);
    return this.sanitizeCandidates(found, query.limit);
  }

  private host(signal: AbortSignal): MetadataProviderHost {
    return {
      fetch: (url: string, init?: MetadataProviderRequestInit) => fetchForPlugin(url, init, signal),
      logger: {
        log: (message: string) => this.logger.log(sanitizeLogValue(message)),
        warn: (message: string) => this.logger.warn(sanitizeLogValue(message)),
      },
      sleep: (ms: number) => sleep(Math.min(Math.max(0, Number(ms) || 0), MAX_SLEEP_MS), signal),
      fail: (failure: MetadataProviderFailure, message: string, retryAfterSeconds?: number) => buildFailure(failure, message, retryAfterSeconds),
    };
  }

  private sanitizeCandidates(found: readonly MetadataProviderCandidate[], limit: number): MetadataCandidate[] {
    if (!Array.isArray(found)) throw new Error('the plugin returned something that is not a list of candidates');

    const candidates: MetadataCandidate[] = [];
    for (const raw of found.slice(0, Math.min(limit, MAX_PLUGIN_CANDIDATES))) {
      const candidate = this.sanitizeCandidate(raw);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  /** Null for a row with no usable identity: without an id and a title there is nothing to store or show. */
  private sanitizeCandidate(raw: MetadataProviderCandidate): MetadataCandidate | null {
    const providerId = identifier(raw?.providerId);
    const title = text(raw?.title, MAX_TEXT_LENGTH);
    if (!providerId || !title) return null;

    const publishedDateKey = typeof raw.publishedDate === 'string' ? parsePublishedDateKey(raw.publishedDate) : undefined;
    const publishedYear = publishedDateKey ? publishedYearFromDateKey(publishedDateKey) : parsePublishedYear(raw.publishedDate);
    const seriesIndex = raw.seriesIndex === undefined ? undefined : (parseSeriesIndex(raw.seriesIndex) ?? undefined);
    const sourceUrl = httpUrl(raw.sourceUrl);

    return compact<MetadataCandidate>({
      provider: this.key,
      providerId,
      title,
      subtitle: text(raw.subtitle, MAX_TEXT_LENGTH),
      authors: list(raw.authors),
      description: text(raw.description, MAX_DESCRIPTION_LENGTH),
      publisher: text(raw.publisher, MAX_TEXT_LENGTH),
      publishedDate: publishedDateKey && isPublishedDateKey(publishedDateKey) ? publishedDateKey : undefined,
      publishedYear,
      language: text(raw.language, 20),
      pageCount: wholeNumber(raw.pageCount, 1, MAX_PAGE_COUNT),
      isbn10: isbn(raw.isbn10, 10),
      isbn13: isbn(raw.isbn13, 13),
      seriesName: text(raw.seriesName, MAX_TEXT_LENGTH),
      seriesIndex,
      genres: list(raw.genres),
      coverUrl: httpUrl(raw.coverUrl),
      sourceUrl,
      narrators: list(raw.narrators),
      durationSeconds: wholeNumber(raw.durationSeconds, 1, 10 * 365 * 24 * 3600),
    });
  }
}

function toQuery(params: MetadataSearchParams): MetadataProviderQuery {
  const query: MetadataProviderQuery = {
    mediaKind: params.isAudiobook ? 'audiobook' : 'ebook',
    limit: normalizeMaxCandidates(params.maxCandidatesPerProvider, DEFAULT_MAX_CANDIDATES),
  };
  const title = params.title?.trim();
  const author = params.author?.trim();
  const digits = params.isbn?.replace(/[^0-9Xx]/g, '').toUpperCase();
  const seriesName = params.seriesName?.trim();
  if (title) query.title = title;
  if (author) query.author = author;
  if (digits) query.isbn = digits;
  if (seriesName) query.seriesName = seriesName;
  return query;
}

/**
 * A function on the host rather than an exported class: a plugin imported at runtime holds its own
 * copy of any class, so `instanceof` would not survive the boundary. Errors built here are this
 * process's own, so the pipeline can still tell a throttle from an ordinary failure.
 */
function buildFailure(failure: MetadataProviderFailure, message: string, retryAfterSeconds?: number): Error {
  if (failure === 'throttled') {
    const seconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds! > 0 ? Math.ceil(retryAfterSeconds!) : undefined;
    return new ProviderThrottleError(seconds, message);
  }
  const error = new Error(message);
  error.name = failure === 'timeout' ? 'TimeoutError' : failure === 'unreachable' ? 'UnreachableError' : 'PluginProviderError';
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('the search was cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('the search was cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejected rather than truncated: a clipped id would name a different record. */
function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROVIDER_ID_LENGTH ? trimmed : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => text(item, MAX_TEXT_LENGTH))
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_LIST_ITEMS);
  return items.length > 0 ? items : undefined;
}

function wholeNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function isbn(value: unknown, length: 10 | 13): string | undefined {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  const pattern = length === 10 ? /^\d{9}[\dX]$/ : /^97[89]\d{10}$/;
  return pattern.test(digits) ? digits : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
