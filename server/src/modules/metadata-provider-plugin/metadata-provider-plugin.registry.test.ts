import { describe, expect, it, vi } from 'vitest';

import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { PluginMetadataProvider } from './plugin-metadata-provider';

function fakeDb(initial?: string) {
  let stored = initial;
  const query = {
    appSettings: { findFirst: vi.fn().mockImplementation(() => Promise.resolve(stored === undefined ? undefined : { value: stored })) },
  };
  const tx = {
    query,
    execute: vi.fn().mockResolvedValue(undefined),
    insert: () => ({
      values: (row: { value: string }) => ({
        onConflictDoUpdate: () => {
          stored = row.value;
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: { query, transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx) }, stored: () => stored };
}

function provider(type: string, extra: Record<string, unknown> = {}): PluginMetadataProvider {
  return new PluginMetadataProvider({ apiVersion: 1, type, label: type.toUpperCase(), search: vi.fn(), ...extra });
}

describe('MetadataProviderPluginRegistry', () => {
  it('starts every plugin switched off', () => {
    const { db } = fakeDb();
    const registry = new MetadataProviderPluginRegistry(db as never);
    registry.register(provider('alpha'));

    expect(registry.enabledConfig()).toEqual({ 'plugin:alpha': { enabled: false } });
  });

  it('persists the switch and reads it back on the next boot', async () => {
    const first = fakeDb();
    const registry = new MetadataProviderPluginRegistry(first.db as never);
    await registry.setEnabled('alpha', true);
    await registry.setEnabled('beta', true);
    await registry.setEnabled('alpha', false);

    const next = new MetadataProviderPluginRegistry(fakeDb(first.stored()).db as never);
    await next.loadState();

    expect(first.stored()).toBe('{"enabled":["beta"]}');
    expect(next.isEnabled('plugin:beta')).toBe(true);
    expect(next.isEnabled('plugin:alpha')).toBe(false);
  });

  it('treats a corrupt stored state as everything off instead of failing boot', async () => {
    const registry = new MetadataProviderPluginRegistry(fakeDb('{not json').db as never);

    await registry.loadState();

    expect(registry.isEnabled('plugin:alpha')).toBe(false);
  });

  it('describes plugins sorted by label, defaulting to every media kind', () => {
    const registry = new MetadataProviderPluginRegistry(fakeDb().db as never);
    registry.register(provider('zeta', { mediaKinds: ['comic'], version: '2.0.0' }));
    registry.register(provider('alpha'));

    expect(registry.describe()).toEqual([
      {
        type: 'alpha',
        key: 'plugin:alpha',
        label: 'ALPHA',
        mediaKinds: ['ebook', 'audiobook', 'comic'],
        enabled: false,
      },
      { type: 'zeta', key: 'plugin:zeta', label: 'ZETA', version: '2.0.0', mediaKinds: ['comic'], enabled: false },
    ]);
  });

  it('unregisters a provider without touching the others', () => {
    const registry = new MetadataProviderPluginRegistry(fakeDb().db as never);
    registry.register(provider('alpha'));
    registry.register(provider('beta'));

    registry.unregister('plugin:alpha');

    expect(registry.providers().map((entry) => entry.key)).toEqual(['plugin:beta']);
  });
});
