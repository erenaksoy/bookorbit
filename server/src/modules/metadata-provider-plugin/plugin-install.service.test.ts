import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildZip, samplePluginSource } from '../../common/test-utils/metadata-provider-plugin-fixtures';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { readPluginUpload, type PluginFiles } from './plugin-archive';
import { PluginInstallService } from './plugin-install.service';
import { PluginLoaderService } from './plugin-loader.service';

function fakeDb() {
  let stored: string | undefined;
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
  return { query, transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx) };
}

async function files(source: string): Promise<PluginFiles> {
  return readPluginUpload('plugin.mjs', Buffer.from(source));
}

describe('PluginInstallService', () => {
  let appDataPath: string;
  let registry: MetadataProviderPluginRegistry;
  let loader: PluginLoaderService;
  let installer: PluginInstallService;

  const pluginRoot = () => join(appDataPath, 'plugins', 'metadata-providers');

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'bookorbit-provider-plugins-'));
    registry = new MetadataProviderPluginRegistry(fakeDb() as never);
    loader = new PluginLoaderService({ appDataPath } as never, registry);
    installer = new PluginInstallService({ appDataPath } as never, registry, loader);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(appDataPath, { recursive: true, force: true });
  });

  describe('inspect', () => {
    it('reports what the plugin declares, with its source, and keeps nothing', async () => {
      const inspection = await installer.inspect(await files(samplePluginSource()));

      expect(inspection).toMatchObject({
        type: 'acme-books',
        key: 'plugin:acme-books',
        label: 'Acme Books',
        version: '1.0.0',
        description: 'Books from the Acme catalogue',
        mediaKinds: ['ebook'],
        files: ['index.mjs'],
        replaces: false,
      });
      expect(inspection.source).toContain("type: 'acme-books'");
      await expect(access(pluginRoot())).rejects.toThrow();
    });

    it('says when a plugin of the same type is already installed', async () => {
      await installer.install(await files(samplePluginSource()), 'admin');

      expect((await installer.inspect(await files(samplePluginSource()))).replaces).toBe(true);
    });

    it('refuses a plugin built against another API version, with the reason', async () => {
      const source = samplePluginSource().replace('apiVersion: 1', 'apiVersion: 9');

      await expect(installer.inspect(await files(source))).rejects.toThrow(/API version 9/);
    });

    it('refuses a module that throws while loading, quoting the error', async () => {
      await expect(installer.inspect(await files("throw new Error('exploded on import');"))).rejects.toThrow(/exploded on import/);
    });

    it('refuses a module that never finishes loading instead of hanging the request', async () => {
      await expect(installer.inspect(await files('await new Promise(() => {});'))).rejects.toThrow(/did not finish loading/);
    }, 15_000);

    it('gives the inspected module none of this process environment', async () => {
      vi.stubEnv('BOOKORBIT_TEST_SECRET', 'leaked');
      const source = samplePluginSource().replace("label: 'Acme Books'", 'label: `env:${process.env.BOOKORBIT_TEST_SECRET}`');

      expect((await installer.inspect(await files(source))).label).toBe('env:undefined');
      vi.unstubAllEnvs();
    });

    it('refuses a plugin with no search function', async () => {
      const source = "export default { apiVersion: 1, type: 'nosearch', label: 'No search' };";

      await expect(installer.inspect(await files(source))).rejects.toThrow(/no search function/);
    });
  });

  describe('install', () => {
    it('writes the plugin, puts it to work at once, and leaves it switched off', async () => {
      const result = await installer.install(await files(samplePluginSource()), 'admin@acme.test');

      expect(result).toMatchObject({ type: 'acme-books', active: true, replaces: false });
      expect(await readFile(join(pluginRoot(), 'acme-books', 'index.mjs'), 'utf8')).toContain("type: 'acme-books'");
      expect(registry.find('plugin:acme-books')).toBeDefined();
      expect(registry.isEnabled('plugin:acme-books')).toBe(false);
    });

    it('installs a zip with its extra files', async () => {
      const zip = await buildZip({ 'sample/index.mjs': samplePluginSource(), 'sample/README.md': '# hi' });

      const result = await installer.install(await readPluginUpload('acme-books.zip', zip), 'admin');

      expect(result.files).toEqual(['README.md', 'index.mjs']);
      expect(await readFile(join(pluginRoot(), 'acme-books', 'README.md'), 'utf8')).toBe('# hi');
    });

    it('replaces an installed plugin with new code, keeping its on/off switch', async () => {
      await installer.install(await files(samplePluginSource()), 'admin');
      await registry.setEnabled('acme-books', true);

      const result = await installer.install(await files(samplePluginSource().replace("label: 'Acme Books'", "label: 'Acme Books v2'")), 'admin');

      expect(result.replaces).toBe(true);
      expect(registry.find('plugin:acme-books')?.label).toBe('Acme Books v2');
      expect(registry.isEnabled('plugin:acme-books')).toBe(true);
      expect((await readdir(pluginRoot())).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('restores the previous version when the new one inspects fine but will not load', async () => {
      await installer.install(await files(samplePluginSource()), 'admin');
      const load = vi.spyOn(loader, 'loadDirectory');
      load.mockRejectedValueOnce(new Error('second import failed'));

      await expect(installer.install(await files(samplePluginSource().replace("label: 'Acme Books'", "label: 'Broken'")), 'admin')).rejects.toThrow(
        /previous version was restored/,
      );

      expect(await readFile(join(pluginRoot(), 'acme-books', 'index.mjs'), 'utf8')).toContain("label: 'Acme Books'");
      expect((await readdir(pluginRoot())).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('leaves nothing behind when a first install will not load', async () => {
      vi.spyOn(loader, 'loadDirectory').mockRejectedValueOnce(new Error('cannot load'));

      await expect(installer.install(await files(samplePluginSource()), 'admin')).rejects.toThrow(BadRequestException);

      expect(await readdir(pluginRoot())).toEqual([]);
      expect(registry.find('plugin:acme-books')).toBeUndefined();
    });

    it('installs nothing when the upload is not a usable plugin', async () => {
      await expect(installer.install(await files("throw new Error('nope');"), 'admin')).rejects.toThrow(BadRequestException);

      await expect(access(pluginRoot())).rejects.toThrow();
    });
  });

  describe('setEnabled', () => {
    it('switches an installed plugin on and off', async () => {
      await installer.install(await files(samplePluginSource()), 'admin');

      await installer.setEnabled('acme-books', true);
      expect(registry.isEnabled('plugin:acme-books')).toBe(true);
      expect(registry.enabledConfig()).toEqual({ 'plugin:acme-books': { enabled: true } });

      await installer.setEnabled('acme-books', false);
      expect(registry.isEnabled('plugin:acme-books')).toBe(false);
    });

    it('refuses a plugin that is not loaded', async () => {
      await expect(installer.setEnabled('ghost', true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('uninstalls a plugin: files, provider and on/off switch', async () => {
      await installer.install(await files(samplePluginSource()), 'admin');
      await installer.setEnabled('acme-books', true);

      await installer.remove('acme-books', 'admin');

      await expect(access(join(pluginRoot(), 'acme-books'))).rejects.toThrow();
      expect(registry.find('plugin:acme-books')).toBeUndefined();
      expect(registry.isEnabled('plugin:acme-books')).toBe(false);
    });

    it('refuses a plugin that does not exist', async () => {
      await expect(installer.remove('ghost', 'admin')).rejects.toThrow(NotFoundException);
    });

    it.each(['..', '../etc', 'a/b', '.incoming-x', 'UPPER'])('refuses the name %s, which is not a plugin slug', async (name) => {
      await expect(installer.remove(name, 'admin')).rejects.toThrow(BadRequestException);
    });
  });
});
