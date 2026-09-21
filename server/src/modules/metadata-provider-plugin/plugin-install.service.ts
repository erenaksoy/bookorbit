import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  pluginProviderKey,
  type BookRequestMediaKind,
  type MetadataProviderPluginInspection,
  type MetadataProviderPluginInstallResult,
} from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { storageConfig } from '../../config/config';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { ENTRYPOINT, type PluginFiles } from './plugin-archive';
import { PLUGIN_SUBDIRECTORY, PluginLoaderService } from './plugin-loader.service';
import { assertProviderPluginShape, isPluginTypeSlug, type DeclaredProviderPluginShape } from './plugin-shape';

const execFileAsync = promisify(execFile);

/** Long enough for a module to evaluate, short enough that a hang is not a hang. */
const INSPECT_TIMEOUT_MS = 5_000;
/** A plugin that answers with a novel is not answering with a descriptor. */
const MAX_INSPECT_OUTPUT_BYTES = 64 * 1024;

/**
 * Imports the entry and reports only what it declares about itself. Runs as its own process, so the
 * code inside never touches this one.
 */
const INSPECT_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const module = await import(pathToFileURL(process.argv[1]).href);
const plugin = module.default ?? {};
process.stdout.write(
  JSON.stringify({
    apiVersion: plugin.apiVersion,
    version: plugin.version,
    type: plugin.type,
    label: plugin.label,
    description: plugin.description,
    mediaKinds: plugin.mediaKinds,
    timeoutMs: plugin.timeoutMs,
    hasSearch: typeof plugin.search === 'function',
  }),
);
`;

/**
 * Installing a metadata provider plugin from the browser instead of from a shell.
 *
 * **This is remote code execution behind a permission check, and it is that by design.** A plugin
 * runs in the BookOrbit process with that process's reach, so anyone who can install one can reach
 * the database, the library and the encryption keys. Before this existed, doing that required
 * filesystem access to the host; now it requires a superuser session, which is why the controller
 * enforces superuser server-side rather than hiding a button.
 *
 * What can be done about it is done. A plugin is read in a child process before it is written
 * anywhere, so an upload that hangs, crashes or throws on import does none of that here. That is
 * not a sandbox: evaluating a module runs its top-level code. It buys a handle-free, deadline-bound
 * look at what the plugin declares, so the operator sees its shape and its source before confirming.
 */
@Injectable()
export class PluginInstallService {
  private readonly logger = new Logger(PluginInstallService.name);

  constructor(
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    private readonly registry: MetadataProviderPluginRegistry,
    private readonly loader: PluginLoaderService,
  ) {}

  private get root(): string {
    return join(this.storage.appDataPath, PLUGIN_SUBDIRECTORY);
  }

  /** What the upload says it is, without keeping it. The entry source comes back so it can be read first. */
  async inspect(files: PluginFiles): Promise<MetadataProviderPluginInspection> {
    const declared = await this.declare(files);

    try {
      assertProviderPluginShape(declared);
    } catch (error) {
      throw new BadRequestException(`That upload is not a usable plugin: ${error instanceof Error ? error.message : String(error)}`);
    }

    const type = declared.type as string;
    return {
      type,
      key: pluginProviderKey(type),
      label: declared.label as string,
      ...(typeof declared.description === 'string' ? { description: declared.description } : {}),
      ...(typeof declared.version === 'string' ? { version: declared.version } : {}),
      mediaKinds: (declared.mediaKinds as BookRequestMediaKind[] | undefined) ?? ['ebook', 'audiobook', 'comic'],
      files: [...files.keys()].sort(),
      source: files.get(ENTRYPOINT)!.toString('utf8'),
      replaces: await this.directoryExists(type),
    };
  }

  /**
   * Inspected again rather than trusting what the browser was shown. The client sends the file a
   * second time to confirm, so nothing is staged between the two calls and there is no window in
   * which a checked file and an installed file could differ.
   */
  async install(files: PluginFiles, installedBy: string): Promise<MetadataProviderPluginInstallResult> {
    const startedAt = Date.now();
    const inspection = await this.inspect(files);
    const directory = this.directoryFor(inspection.type);
    const incoming = this.directoryFor(`.incoming-${randomUUID()}`);
    const previous = inspection.replaces ? this.directoryFor(`.previous-${randomUUID()}`) : null;

    try {
      await this.writeFiles(incoming, files);
      if (previous) await rename(directory, previous);
      try {
        await rename(incoming, directory);
      } catch (error) {
        if (previous) await rename(previous, directory).catch(() => undefined);
        throw error;
      }

      try {
        this.registry.register(await this.loader.loadDirectory(inspection.type));
      } catch (error) {
        await this.rollback(directory, previous, inspection.type);
        throw new BadRequestException(
          `The plugin was inspected but would not load: ${error instanceof Error ? error.message : String(error)}` +
            (previous ? '. The previous version was restored.' : ''),
        );
      }

      if (previous) await rm(previous, { recursive: true, force: true });
      this.loader.forgetFailure(inspection.type);
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }

    this.logger.log(
      `[metadata_provider_plugin.install] [end] type=${inspection.type} files=${files.size} replaced=${inspection.replaces} ` +
        `durationMs=${Date.now() - startedAt} user="${sanitizeLogValue(installedBy)}" - plugin installed`,
    );
    return { ...inspection, active: true };
  }

  async setEnabled(type: string, enabled: boolean): Promise<void> {
    if (!this.registry.find(pluginProviderKey(type))) throw new NotFoundException(`No plugin called "${type}" is loaded`);
    await this.registry.setEnabled(type, enabled);
  }

  /** Uninstalls a plugin. Ids it stored on books stay, so reinstalling it picks them up again. */
  async remove(type: string, removedBy: string): Promise<void> {
    if (!isPluginTypeSlug(type)) throw new BadRequestException(`"${type}" is not a plugin name`);
    const installed = await this.directoryExists(type);
    if (!installed && !this.registry.find(pluginProviderKey(type))) throw new NotFoundException(`No plugin called "${type}" exists`);

    await rm(this.directoryFor(type), { recursive: true, force: true });
    this.registry.unregister(pluginProviderKey(type));
    this.loader.forgetFailure(type);
    await this.registry.forget(type);
    this.logger.log(`[metadata_provider_plugin.remove] [end] type=${type} user="${sanitizeLogValue(removedBy)}" - plugin removed`);
  }

  private async rollback(directory: string, previous: string | null, type: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
    if (!previous) return;
    await rename(previous, directory);
    try {
      this.registry.register(await this.loader.loadDirectory(type));
    } catch {
      // The previous version is back on disk; a restart will retry it.
    }
  }

  /** Contained to the plugin root: a name is a single slug or a dot-prefixed staging name, never a path. */
  private directoryFor(name: string): string {
    if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
      throw new BadRequestException('That plugin name is not usable as a directory');
    }
    const directory = resolve(this.root, name);
    if (dirname(directory) !== resolve(this.root)) throw new BadRequestException('That plugin name is not usable as a directory');
    return directory;
  }

  private async directoryExists(type: string): Promise<boolean> {
    try {
      return (await stat(this.directoryFor(type))).isDirectory();
    } catch {
      return false;
    }
  }

  private async writeFiles(directory: string, files: PluginFiles): Promise<void> {
    await mkdir(directory, { recursive: true });
    for (const [path, content] of files) {
      const target = resolve(directory, path);
      // Names were normalised on the way in; this is the check that does not rely on that.
      if (!target.startsWith(directory + '/')) throw new BadRequestException(`"${path}" escapes the plugin directory`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o600 });
    }
  }

  /** Runs the upload in a process of its own and reads back only what it declares. */
  private async declare(files: PluginFiles): Promise<DeclaredProviderPluginShape> {
    const staging = await mkdtemp(join(tmpdir(), 'bookorbit-plugin-'));

    try {
      await this.writeFiles(staging, files);
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', INSPECT_SCRIPT, join(staging, ENTRYPOINT)], {
        timeout: INSPECT_TIMEOUT_MS,
        maxBuffer: MAX_INSPECT_OUTPUT_BYTES,
        // Nothing of this process's environment, so a plugin cannot read a secret out of it while
        // being inspected.
        env: { PATH: process.env.PATH ?? '' },
      });
      return JSON.parse(stdout) as DeclaredProviderPluginShape;
    } catch (error) {
      throw new BadRequestException(`That upload could not be read as a plugin: ${describe(error)}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Node's exit code 13 is an unsettled top-level await: the module simply never finished. A module
 * that blocks the event loop instead runs out the deadline and is killed. Both mean the same thing
 * to an operator.
 */
const UNFINISHED_TOP_LEVEL_AWAIT = 13;

/** Read out of the middle of stderr: Node prints the source line, then the error, then a stack. */
const NODE_ERROR_LINE = /^[A-Za-z]*Error(?: \[[^\]]+\])?:\s*(.+)$/m;

function describe(error: unknown): string {
  const failure = error as { killed?: boolean; code?: number | string; stderr?: string } | null;

  if (failure?.killed || failure?.code === UNFINISHED_TOP_LEVEL_AWAIT) {
    return `it did not finish loading within ${INSPECT_TIMEOUT_MS}ms`;
  }

  const stderr = String(failure?.stderr ?? '');
  const stated = NODE_ERROR_LINE.exec(stderr)?.[1]?.trim();
  if (stated) return stated.slice(0, 200);

  const fallback = stderr.trim().split('\n').filter(Boolean)[0];
  return fallback ? fallback.slice(0, 200) : error instanceof Error ? error.message : String(error);
}
