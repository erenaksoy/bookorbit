import { BadRequestException } from '@nestjs/common';
import { ConcreteBookMediaKind, MetadataProviderKey } from '@bookorbit/types';

import type { MetadataProviderPluginRegistry } from '../metadata-provider-plugin/metadata-provider-plugin.registry';
import { ProviderRegistry } from './provider-registry';
import { MetadataProvider } from './providers/metadata-provider';

function createProvider(key: MetadataProviderKey, label = key, mediaKinds?: readonly ConcreteBookMediaKind[]): MetadataProvider {
  return {
    key,
    label,
    identifiable: false,
    ...(mediaKinds ? { mediaKinds } : {}),
    search: vi.fn().mockResolvedValue([]),
  };
}

function createRegistry(builtIn: MetadataProvider[], pluginProviders: MetadataProvider[] = []): ProviderRegistry {
  const plugins = {
    providers: () => pluginProviders,
    find: (key: string) => pluginProviders.find((provider) => provider.key === key),
  } as unknown as MetadataProviderPluginRegistry;
  return new ProviderRegistry(builtIn, plugins);
}

describe('ProviderRegistry', () => {
  it('returns all providers when no keys are provided', () => {
    const providers = [createProvider(MetadataProviderKey.GOOGLE), createProvider(MetadataProviderKey.GOODREADS)];
    const registry = createRegistry(providers);

    expect(registry.select()).toEqual(providers);
    expect(registry.all()).toEqual(providers);
  });

  it('returns an empty list when keys is explicitly empty', () => {
    const registry = createRegistry([createProvider(MetadataProviderKey.GOOGLE)]);

    expect(registry.select([])).toEqual([]);
  });

  it('selects only requested providers in registry order', () => {
    const google = createProvider(MetadataProviderKey.GOOGLE);
    const amazon = createProvider(MetadataProviderKey.AMAZON);
    const openLibrary = createProvider(MetadataProviderKey.OPEN_LIBRARY);
    const registry = createRegistry([google, amazon, openLibrary]);

    const selected = registry.select([MetadataProviderKey.OPEN_LIBRARY, MetadataProviderKey.GOOGLE]);

    expect(selected).toEqual([google, openLibrary]);
  });

  it('throws for unknown providers and includes all unknown keys in the message', () => {
    const registry = createRegistry([createProvider(MetadataProviderKey.GOOGLE)]);

    expect(() => registry.select([MetadataProviderKey.GOOGLE, MetadataProviderKey.HARDCOVER, MetadataProviderKey.AMAZON])).toThrow(
      new BadRequestException('Unknown providers: hardcover, amazon'),
    );
  });

  it('keeps providers that declare no media kinds, so a new provider is never scoped out silently', () => {
    const registry = createRegistry([
      createProvider(MetadataProviderKey.GOOGLE),
      createProvider(MetadataProviderKey.COMICVINE, 'ComicVine', ['comic']),
      createProvider(MetadataProviderKey.AUDIBLE, 'Audible', ['audiobook']),
    ]);

    expect(registry.keysForMediaKind([MetadataProviderKey.GOOGLE, MetadataProviderKey.COMICVINE, MetadataProviderKey.AUDIBLE], 'ebook')).toEqual([
      MetadataProviderKey.GOOGLE,
    ]);
  });

  it('keeps a specialist only for the medium it serves', () => {
    const registry = createRegistry([
      createProvider(MetadataProviderKey.GOOGLE),
      createProvider(MetadataProviderKey.COMICVINE, 'ComicVine', ['comic']),
      createProvider(MetadataProviderKey.AUDIBLE, 'Audible', ['audiobook']),
    ]);
    const keys = [MetadataProviderKey.GOOGLE, MetadataProviderKey.COMICVINE, MetadataProviderKey.AUDIBLE];

    expect(registry.keysForMediaKind(keys, 'comic')).toEqual([MetadataProviderKey.GOOGLE, MetadataProviderKey.COMICVINE]);
    expect(registry.keysForMediaKind(keys, 'audiobook')).toEqual([MetadataProviderKey.GOOGLE, MetadataProviderKey.AUDIBLE]);
  });

  it('leaves an unregistered key alone rather than masking it as a scoped-out provider', () => {
    const registry = createRegistry([createProvider(MetadataProviderKey.GOOGLE)]);

    // select() is what rejects an unknown key; swallowing it here would turn that error into an empty search.
    expect(registry.keysForMediaKind([MetadataProviderKey.GOOGLE, MetadataProviderKey.HARDCOVER], 'ebook')).toEqual([
      MetadataProviderKey.GOOGLE,
      MetadataProviderKey.HARDCOVER,
    ]);
  });

  it('finds a provider by key', () => {
    const google = createProvider(MetadataProviderKey.GOOGLE);
    const registry = createRegistry([google]);

    expect(registry.find(MetadataProviderKey.GOOGLE)).toBe(google);
    expect(registry.find(MetadataProviderKey.AMAZON)).toBeUndefined();
  });

  describe('plugin providers', () => {
    const pluginKey = 'plugin:acme-books' as MetadataProviderKey;

    it('lists plugin providers after the built-in ones', () => {
      const google = createProvider(MetadataProviderKey.GOOGLE);
      const plugin = createProvider(pluginKey);
      const registry = createRegistry([google], [plugin]);

      expect(registry.all()).toEqual([google, plugin]);
    });

    it('selects and finds a plugin provider by key', () => {
      const plugin = createProvider(pluginKey);
      const registry = createRegistry([createProvider(MetadataProviderKey.GOOGLE)], [plugin]);

      expect(registry.select([pluginKey])).toEqual([plugin]);
      expect(registry.find(pluginKey)).toBe(plugin);
    });

    it('rejects a plugin key once the plugin is no longer installed', () => {
      const registry = createRegistry([createProvider(MetadataProviderKey.GOOGLE)]);

      expect(() => registry.select([pluginKey])).toThrow(BadRequestException);
      expect(registry.find(pluginKey)).toBeUndefined();
    });

    it('scopes a plugin by the media kinds it declares', () => {
      const plugin = createProvider(pluginKey, 'Acme Books', ['ebook']);
      const registry = createRegistry([], [plugin]);

      expect(registry.keysForMediaKind([pluginKey], 'ebook')).toEqual([pluginKey]);
      expect(registry.keysForMediaKind([pluginKey], 'audiobook')).toEqual([]);
    });
  });
});
