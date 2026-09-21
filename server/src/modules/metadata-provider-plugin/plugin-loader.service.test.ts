import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { samplePluginSource } from '../../common/test-utils/metadata-provider-plugin-fixtures';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { PluginLoaderService } from './plugin-loader.service';

describe('PluginLoaderService', () => {
  let appDataPath: string;
  let registry: MetadataProviderPluginRegistry;
  let loader: PluginLoaderService;

  async function plugin(directory: string, source: string): Promise<void> {
    await mkdir(join(loader.root, directory), { recursive: true });
    await writeFile(join(loader.root, directory, 'index.mjs'), source);
  }

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'bookorbit-provider-loader-'));
    registry = new MetadataProviderPluginRegistry({} as never);
    vi.spyOn(registry, 'loadState').mockResolvedValue();
    loader = new PluginLoaderService({ appDataPath } as never, registry);
  });

  afterEach(async () => {
    await rm(appDataPath, { recursive: true, force: true });
  });

  it('is quiet when there is no plugin directory at all', async () => {
    await loader.onModuleInit();

    expect(registry.providers()).toEqual([]);
    expect(loader.loadFailures()).toEqual([]);
  });

  it('registers every valid plugin found on disk', async () => {
    await plugin('alpha', samplePluginSource({ type: 'alpha' }));
    await plugin('beta', samplePluginSource({ type: 'beta' }));

    await loader.onModuleInit();

    expect(registry.providers().map((provider) => provider.key)).toEqual(['plugin:alpha', 'plugin:beta']);
  });

  it('records why a plugin did not load and keeps loading the others', async () => {
    await plugin('good', samplePluginSource({ type: 'good' }));
    await plugin('broken', "throw new Error('syntax gone');");
    await plugin('wrongapi', samplePluginSource({ type: 'wrongapi' }).replace('apiVersion: 1', 'apiVersion: 7'));

    await loader.loadAll();

    expect(registry.providers().map((provider) => provider.key)).toEqual(['plugin:good']);
    expect(loader.loadFailures()).toEqual([
      { directory: 'broken', reason: 'syntax gone' },
      { directory: 'wrongapi', reason: expect.stringContaining('API version 7') },
    ]);
  });

  it('refuses a plugin whose type does not match its directory, so two folders cannot claim one key', async () => {
    await plugin('alias', samplePluginSource({ type: 'real' }));

    await loader.loadAll();

    expect(registry.providers()).toEqual([]);
    expect(loader.loadFailures()[0]?.reason).toMatch(/does not match its directory/);
  });

  it('ignores staging directories left behind by an interrupted install', async () => {
    await plugin('.incoming-abc', samplePluginSource({ type: 'acme-books' }));

    await loader.loadAll();

    expect(registry.providers()).toEqual([]);
    expect(loader.loadFailures()).toEqual([]);
  });

  it('reports a directory with no entry module', async () => {
    await mkdir(join(loader.root, 'empty'), { recursive: true });

    await loader.loadAll();

    expect(loader.loadFailures()).toEqual([{ directory: 'empty', reason: 'no index.mjs in that directory' }]);
  });

  it('forgets a failure once told the directory was fixed or removed', async () => {
    await plugin('broken', 'throw new Error("x");');
    await loader.loadAll();

    loader.forgetFailure('broken');

    expect(loader.loadFailures()).toEqual([]);
  });
});
