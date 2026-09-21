import { boundedResponse } from './bounded-response';
import { safeFetch } from './safe-fetch';
import { ensureSafeUrl } from './ssrf.utils';

/** A ceiling on any one request a plugin makes, and one it cannot opt out of. */
export const PLUGIN_REQUEST_TIMEOUT_MS = 25_000;
/** What a plugin reads is a page or a JSON document, never a book. */
export const PLUGIN_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PLUGIN_MAX_REDIRECTS = 5;

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'cookie2', 'proxy-authorization']);

export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}

/**
 * The one way a plugin reaches the network.
 *
 * Redirects are followed here rather than by `fetch`, because `redirect: 'follow'` checks the first
 * URL and nothing after it: a hop to loopback or to a link-local metadata address would be taken
 * without ever being seen. A plugin that asks for `'manual'` gets the 3xx itself and never a body
 * fetched from an address that was not checked. The address that passed the check is the address
 * the connection uses, because the URLs come from a third party rather than from an operator.
 */
export async function fetchForPlugin(rawUrl: string, init: PluginFetchInit | undefined, deadline?: AbortSignal): Promise<Response> {
  const ceiling = AbortSignal.timeout(PLUGIN_REQUEST_TIMEOUT_MS);
  const signal = deadline ? AbortSignal.any([deadline, ceiling]) : ceiling;
  const options = { allowPrivate: false, pinResolvedAddress: true };

  let current = rawUrl;
  let method = init?.method ?? 'GET';
  let headers = { ...(init?.headers ?? {}) };
  let body = init?.body;

  for (let hop = 0; hop <= PLUGIN_MAX_REDIRECTS; hop++) {
    const response = await safeFetch(current, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal }, options);

    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (init?.redirect === 'manual' || !location) return boundedResponse(response, PLUGIN_MAX_RESPONSE_BYTES);

    void response.body?.cancel().catch(() => undefined);
    const next = await ensureSafeUrl(new URL(location, current).href, options);

    if (downgradesToGet(response.status, method)) {
      method = 'GET';
      body = undefined;
    }
    if (new URL(current).origin !== next.origin) headers = withoutCredentialHeaders(headers);
    current = next.href;
  }

  throw new Error(`The request was redirected more than ${PLUGIN_MAX_REDIRECTS} times`);
}

/** 303 always, and 301 or 302 for anything that was not already a GET or a HEAD. */
function downgradesToGet(status: number, method: string): boolean {
  const safeMethod = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD';
  return status === 303 || ((status === 301 || status === 302) && !safeMethod);
}

function withoutCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}
