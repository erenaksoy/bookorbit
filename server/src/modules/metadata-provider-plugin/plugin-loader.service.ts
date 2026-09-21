import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { MetadataProviderPlugin } from '@bookorbit/plugin-api';
import type { MetadataProviderPluginFailure } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { storageConfig } from '../../config/config';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { ENTRYPOINT } from './plugin-archive';
import { PluginMetadataProvider } from './plugin-metadata-provider';
import { assertProviderPluginShape, isPluginTypeSlug } from './plugin-shape';

/** Where an operator drops a plugin. Writable in the container, and survives an upgrade. */
export const PLUGIN_SUBDIRECTORY = join('plugins', 'metadata-providers');

/**
 * Imports an ES module from an absolute `file://` URL, in both of the environments this runs in.
 *
 * The server is built as CommonJS by swc, which rewrites a plain `import()` into `require()`, and
 * `require()` cannot load an ES module. Vitest runs the source as ESM, where the plain import is
 * exactly right and the `Function` form fails instead. So try the real thing first and keep the
 * indirection as the fallback. The indexer plugin loader carries the same workaround.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- needed to preserve runtime dynamic import in CJS output
const importViaFunction = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

async function importModule(specifier: string): Promise<unknown> {
  try {
    return await (import(specifier) as Promise<unknown>);
  } catch (first) {
    try {
      return await importViaFunction(specifier);
    } catch (second) {
      // Two failures, and only one of them is the plugin's. In a CommonJS build the plain import
      // fails because `require()` cannot load the URL at all; in ESM the fallback fails because it
      // has no import callback. Whichever one is the environment's, the other is what the plugin
      // author needs to see.
      throw isEnvironmentImportFailure(first) ? second : first;
    }
  }
}

function isEnvironmentImportFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_REQUIRE_ESM' || code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME';
}

/**
 * Loads metadata provider plugins from disk at boot.
 *
 * BookOrbit ships no plugins. This is the seam that lets a source for one catalogue, region or
 * language live in somebody else's repository instead of this one.
 *
 * A plugin runs in this process with this process's reach. That is the accepted trade for a
 * self-hosted application, and it is stated in the install documentation rather than left to be
 * discovered. What the loader can do it does: it refuses a plugin built against a different
 * contract version, and it records a failure instead of letting a broken plugin vanish silently.
 */
@Injectable()
export class PluginLoaderService implements OnModuleInit {
  private readonly logger = new Logger(PluginLoaderService.name);
  private readonly failures: MetadataProviderPluginFailure[] = [];

  constructor(
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    private readonly registry: MetadataProviderPluginRegistry,
  ) {}

  get root(): string {
    return join(this.storage.appDataPath, PLUGIN_SUBDIRECTORY);
  }

  async onModuleInit(): Promise<void> {
    await this.registry.loadState();
    await this.loadAll();
  }

  /** Everything that failed to load, so the settings page can explain a plugin that is missing. */
  loadFailures(): readonly MetadataProviderPluginFailure[] {
    return this.failures;
  }

  /** Dropped when a directory is removed or reinstalled, so a fixed plugin stops being reported. */
  forgetFailure(directory: string): void {
    const at = this.failures.findIndex((failure) => failure.directory === directory);
    if (at !== -1) this.failures.splice(at, 1);
  }

  async loadAll(): Promise<void> {
    this.failures.length = 0;

    let directories: string[];
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
    } catch {
      // No plugin directory at all is the normal case, not a problem worth logging.
      return;
    }

    const startedAt = Date.now();
    let loaded = 0;
    for (const directory of directories.sort()) {
      try {
        this.registry.register(await this.loadDirectory(directory));
        loaded += 1;
      } catch (error) {
        this.recordFailure(directory, error);
      }
    }

    this.logger.log(
      `[metadata_provider_plugin.load] [end] loaded=${loaded} failed=${this.failures.length} durationMs=${Date.now() - startedAt} - scanned the plugin directory`,
    );
  }

  /**
   * Loads one directory, so installing a plugin can put it to work without a restart rather than
   * only writing it to disk and asking the operator to come back later.
   */
  async loadDirectory(directory: string): Promise<PluginMetadataProvider> {
    const plugin = await this.importPlugin(directory);
    if (plugin.type !== directory) throw new Error(`its type "${plugin.type}" does not match its directory "${directory}"`);
    return new PluginMetadataProvider(plugin);
  }

  private recordFailure(directory: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.failures.push({ directory, reason });
    this.logger.warn(
      `[metadata_provider_plugin.load] [fail] directory="${sanitizeLogValue(directory)}" error="${sanitizeLogValue(reason)}" - plugin not loaded`,
    );
  }

  private async importPlugin(directory: string): Promise<MetadataProviderPlugin> {
    if (!isPluginTypeSlug(directory)) throw new Error('that directory name is not a plugin slug');
    const base = resolve(this.root, directory);
    // A plugin directory is named, never traversed into from outside its own root.
    if (!base.startsWith(resolve(this.root) + '/')) throw new Error('that plugin path escapes the plugin directory');

    const entry = join(base, ENTRYPOINT);
    try {
      if (!(await stat(entry)).isFile()) throw new Error();
    } catch {
      throw new Error(`no ${ENTRYPOINT} in that directory`);
    }

    // Node caches a module by URL for the life of the process, so a plugin reinstalled over its own
    // path would keep serving the code that was just replaced. The query makes each load a new URL.
    // Modules the entry itself imports are still cached until a restart, which is why a plugin
    // should ship as one bundled file.
    const url = `${pathToFileURL(entry).href}?loaded=${Date.now()}`;
    const module = (await importModule(url)) as { default?: unknown };
    const plugin = module.default as Partial<MetadataProviderPlugin> | undefined;
    if (!plugin || typeof plugin !== 'object') throw new Error('the module has no default export');

    assertProviderPluginShape({
      ...plugin,
      hasSearch: typeof plugin.search === 'function',
    });
    return plugin as MetadataProviderPlugin;
  }
}
