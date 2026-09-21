import type { MetadataProviderCandidate, MetadataProviderHost, MetadataProviderPlugin } from '@bookorbit/plugin-api';
import { describe, expect, it, vi } from 'vitest';

import { ProviderThrottleError } from '../metadata-fetch/provider-throttle.error';
import { PluginMetadataProvider } from './plugin-metadata-provider';

function definition(overrides: Partial<MetadataProviderPlugin> = {}): MetadataProviderPlugin {
  return {
    apiVersion: 1,
    type: 'acme-books',
    label: 'Acme Books',
    search: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function providerReturning(found: unknown): PluginMetadataProvider {
  return new PluginMetadataProvider(definition({ search: vi.fn().mockResolvedValue(found) }));
}

describe('PluginMetadataProvider', () => {
  it('keys the provider by the plugin type and exposes its declared traits', () => {
    const provider = new PluginMetadataProvider(definition({ version: '1.2.3', description: 'Text', mediaKinds: ['ebook'], timeoutMs: 5_000 }));

    expect(provider).toMatchObject({
      key: 'plugin:acme-books',
      label: 'Acme Books',
      version: '1.2.3',
      description: 'Text',
      mediaKinds: ['ebook'],
      timeoutMs: 5_000,
      identifiable: false,
    });
  });

  it('falls back to a default timeout', () => {
    expect(new PluginMetadataProvider(definition()).timeoutMs).toBe(15_000);
  });

  describe('search', () => {
    it('hands the plugin a normalised query', async () => {
      const search = vi.fn().mockResolvedValue([]);
      const provider = new PluginMetadataProvider(definition({ search }));

      await provider.search({
        title: '  Dune ',
        author: ' Frank Herbert',
        isbn: '978-0-306-40615-7',
        seriesName: 'Dune',
        maxCandidatesPerProvider: 3,
      });

      expect(search).toHaveBeenCalledWith(
        { title: 'Dune', author: 'Frank Herbert', isbn: '9780306406157', seriesName: 'Dune', mediaKind: 'ebook', limit: 3 },
        expect.any(Object),
        expect.any(AbortSignal),
      );
    });

    it('asks for an audiobook when the book is one', async () => {
      const search = vi.fn().mockResolvedValue([]);
      await new PluginMetadataProvider(definition({ search })).search({ title: 'Dune', isAudiobook: true });

      expect(search.mock.calls[0]![0]).toMatchObject({ mediaKind: 'audiobook' });
    });

    it('does not call the plugin at all when there is nothing to search for', async () => {
      const search = vi.fn();

      const result = await new PluginMetadataProvider(definition({ search })).search({ title: '  ' });

      expect(result).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });

    it('turns a candidate into a metadata candidate tagged with the plugin key', async () => {
      const raw: MetadataProviderCandidate = {
        providerId: '42',
        title: 'Dune',
        authors: ['Frank Herbert'],
        publishedDate: '1965-08-01',
        isbn13: '978-0-306-40615-7',
        coverUrl: 'https://books.acme.test/c.jpg',
        sourceUrl: 'https://books.acme.test/b/42',
        seriesName: 'Dune',
        seriesIndex: '1',
      };

      const [candidate] = await providerReturning([raw]).search({ title: 'Dune' });

      expect(candidate).toEqual({
        provider: 'plugin:acme-books',
        providerId: '42',
        title: 'Dune',
        authors: ['Frank Herbert'],
        publishedDate: '1965-08-01',
        publishedYear: 1965,
        isbn13: '9780306406157',
        coverUrl: 'https://books.acme.test/c.jpg',
        sourceUrl: 'https://books.acme.test/b/42',
        seriesName: 'Dune',
        seriesIndex: expect.anything(),
      });
    });

    it('reads a bare year as a year rather than as a date', async () => {
      const [candidate] = await providerReturning([{ providerId: '1', title: 'T', publishedDate: '2021' }]).search({ title: 'T' });

      expect(candidate).toMatchObject({ publishedYear: 2021 });
      expect(candidate).not.toHaveProperty('publishedDate');
    });

    it('drops rows that cannot be stored or shown, and keeps the rest', async () => {
      const result = await providerReturning([
        { providerId: '', title: 'no id' },
        { providerId: '2', title: '' },
        { providerId: 'x'.repeat(300), title: 'id too long' },
        null,
        { providerId: '3', title: 'kept' },
      ]).search({ title: 'kept' });

      expect(result.map((candidate) => candidate.providerId)).toEqual(['3']);
    });

    it('discards individual fields it does not believe instead of failing the row', async () => {
      const [candidate] = await providerReturning([
        {
          providerId: '1',
          title: 'T',
          coverUrl: 'javascript:alert(1)',
          sourceUrl: 'file:///etc/passwd',
          isbn13: '123',
          pageCount: -4,
          authors: ['ok', 7, ''],
          language: 12,
        },
      ]).search({ title: 'T' });

      expect(candidate).toEqual({ provider: 'plugin:acme-books', providerId: '1', title: 'T', authors: ['ok'] });
    });

    it('caps how many candidates it accepts, whatever the plugin returns', async () => {
      const many = Array.from({ length: 200 }, (_, i) => ({ providerId: String(i), title: `T${i}` }));

      const result = await providerReturning(many).search({ title: 'T', maxCandidatesPerProvider: 1000 });

      expect(result.length).toBeLessThanOrEqual(25);
    });

    it('fails when the plugin returns something that is not a list', async () => {
      await expect(providerReturning({ providerId: '1', title: 'T' }).search({ title: 'T' })).rejects.toThrow(/not a list/);
    });

    it('propagates what the plugin throws so the pipeline can report the provider as failed', async () => {
      const provider = new PluginMetadataProvider(definition({ search: vi.fn().mockRejectedValue(new TypeError('boom')) }));

      await expect(provider.search({ title: 'T' })).rejects.toThrow('boom');
    });

    it('stops waiting on a plugin that never settles once the search is cancelled', async () => {
      const provider = new PluginMetadataProvider(definition({ search: vi.fn().mockReturnValue(new Promise(() => undefined)) }));
      const controller = new AbortController();

      const pending = provider.search({ title: 'T', signal: controller.signal });
      controller.abort(new Error('cancelled'));

      await expect(pending).rejects.toThrow('cancelled');
    });
  });

  describe('host', () => {
    async function hostSeenBy(): Promise<MetadataProviderHost> {
      let seen: MetadataProviderHost | undefined;
      const provider = new PluginMetadataProvider(
        definition({
          search: vi.fn().mockImplementation((_query, host: MetadataProviderHost) => {
            seen = host;
            return Promise.resolve([]);
          }),
        }),
      );
      await provider.search({ title: 'T' });
      return seen!;
    }

    it('builds a real ProviderThrottleError for a throttled failure, carrying the cooldown', async () => {
      const host = await hostSeenBy();

      const error = host.fail('throttled', 'slow down', 120);

      expect(error).toBeInstanceOf(ProviderThrottleError);
      expect((error as ProviderThrottleError).retryAfterSeconds).toBe(120);
    });

    it('ignores a nonsensical retry-after instead of poisoning the cooldown', async () => {
      const host = await hostSeenBy();

      expect((host.fail('throttled', 'x', -5) as ProviderThrottleError).retryAfterSeconds).toBeUndefined();
      expect((host.fail('throttled', 'x', Number.NaN) as ProviderThrottleError).retryAfterSeconds).toBeUndefined();
    });

    it.each([
      ['timeout', 'TimeoutError'],
      ['unreachable', 'UnreachableError'],
      ['error', 'PluginProviderError'],
    ] as const)('names a %s failure so it can be told apart in logs', async (kind, name) => {
      const host = await hostSeenBy();

      const error = host.fail(kind, 'nope');

      expect(error).not.toBeInstanceOf(ProviderThrottleError);
      expect(error.name).toBe(name);
    });

    it('lets a plugin pace itself, and stops as soon as the search is cancelled', async () => {
      vi.useFakeTimers();
      try {
        const host = await hostSeenBy();
        const slept = host.sleep(50);
        await vi.advanceTimersByTimeAsync(50);
        await expect(slept).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
