import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock, ensureSafeUrlMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn<(url: string, init?: RequestInit, options?: Record<string, unknown>) => Promise<Response>>(),
  ensureSafeUrlMock: vi.fn<(url: string, options?: Record<string, unknown>) => Promise<URL>>(),
}));

vi.mock('./safe-fetch', () => ({ safeFetch: safeFetchMock }));
vi.mock('./ssrf.utils', () => ({ ensureSafeUrl: ensureSafeUrlMock }));

import { fetchForPlugin, PLUGIN_MAX_REDIRECTS } from './plugin-fetch';

function page(url: string, status = 200, headers: Record<string, string> = {}, body = 'ok'): Response {
  const response = new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('fetchForPlugin', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    ensureSafeUrlMock.mockReset();
    ensureSafeUrlMock.mockImplementation((url) => Promise.resolve(new URL(url)));
  });

  it("refuses private addresses and pins the address it checked, since the URLs are a third party's", async () => {
    safeFetchMock.mockResolvedValueOnce(page('https://example.com/a'));

    await fetchForPlugin('https://example.com/a', undefined);

    expect(safeFetchMock).toHaveBeenCalledWith('https://example.com/a', expect.objectContaining({ method: 'GET', redirect: 'manual' }), {
      allowPrivate: false,
      pinResolvedAddress: true,
    });
  });

  it('returns the body of a plain response', async () => {
    safeFetchMock.mockResolvedValueOnce(page('https://example.com/a', 200, {}, 'hello'));

    const response = await fetchForPlugin('https://example.com/a', undefined);

    expect(await response.text()).toBe('hello');
    expect(response.url).toBe('https://example.com/a');
  });

  it('follows a redirect itself, checking the next address before going there, and reports the final URL', async () => {
    safeFetchMock
      .mockResolvedValueOnce(page('https://example.com/a', 302, { location: '/product/9' }))
      .mockResolvedValueOnce(page('https://example.com/product/9'));

    const response = await fetchForPlugin('https://example.com/a', undefined);

    expect(ensureSafeUrlMock).toHaveBeenCalledWith('https://example.com/product/9', { allowPrivate: false, pinResolvedAddress: true });
    expect(safeFetchMock.mock.calls[1]![0]).toBe('https://example.com/product/9');
    expect(response.url).toBe('https://example.com/product/9');
  });

  it('does not follow a redirect to an address that fails the check', async () => {
    safeFetchMock.mockResolvedValueOnce(page('https://example.com/a', 302, { location: 'http://169.254.169.254/latest' }));
    ensureSafeUrlMock.mockRejectedValueOnce(new Error('private address'));

    await expect(fetchForPlugin('https://example.com/a', undefined)).rejects.toThrow('private address');
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands a redirect back untouched when the plugin asks to see it', async () => {
    safeFetchMock.mockResolvedValueOnce(page('https://example.com/a', 302, { location: '/login' }));

    const response = await fetchForPlugin('https://example.com/a', { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops credential headers when a redirect leaves the origin, and keeps them within it', async () => {
    safeFetchMock
      .mockResolvedValueOnce(page('https://a.example/x', 302, { location: 'https://a.example/y' }))
      .mockResolvedValueOnce(page('https://a.example/y', 302, { location: 'https://b.example/z' }))
      .mockResolvedValueOnce(page('https://b.example/z'));

    await fetchForPlugin('https://a.example/x', { headers: { Authorization: 'Bearer t', Cookie: 'k=v', 'X-Other': '1' } });

    const headersOf = (call: number) => safeFetchMock.mock.calls[call]![1]!.headers as Record<string, string>;
    expect(headersOf(1)).toEqual({ Authorization: 'Bearer t', Cookie: 'k=v', 'X-Other': '1' });
    expect(headersOf(2)).toEqual({ 'X-Other': '1' });
  });

  it('turns a redirected POST into a GET without replaying the body, as a browser would', async () => {
    safeFetchMock
      .mockResolvedValueOnce(page('https://example.com/search', 303, { location: '/results' }))
      .mockResolvedValueOnce(page('https://example.com/results'));

    await fetchForPlugin('https://example.com/search', { method: 'POST', body: 'q=dune' });

    expect(safeFetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: 'q=dune' });
    expect(safeFetchMock.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
    expect(safeFetchMock.mock.calls[1]![1]).not.toHaveProperty('body');
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    safeFetchMock.mockImplementation(() => Promise.resolve(page('https://example.com/loop', 302, { location: '/loop' })));

    await expect(fetchForPlugin('https://example.com/loop', undefined)).rejects.toThrow(/redirected more than/);
    expect(safeFetchMock).toHaveBeenCalledTimes(PLUGIN_MAX_REDIRECTS + 1);
  });

  it('gives the request the plugin deadline as well as its own ceiling', async () => {
    safeFetchMock.mockResolvedValueOnce(page('https://example.com/a'));
    const deadline = new AbortController();

    await fetchForPlugin('https://example.com/a', undefined, deadline.signal);
    const signal = safeFetchMock.mock.calls[0]![1]!.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    deadline.abort();
    expect(signal.aborted).toBe(true);
  });

  it('reads a streamed body in full when it is under the ceiling', async () => {
    const big = new Response(new Blob([new Uint8Array(1024)]).stream(), { status: 200 });
    Object.defineProperty(big, 'url', { value: 'https://example.com/big' });
    safeFetchMock.mockResolvedValueOnce(big);
    const response = await fetchForPlugin('https://example.com/big', undefined);

    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });
});
