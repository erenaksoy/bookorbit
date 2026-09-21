import { posix } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import * as unzipper from 'unzipper';

/** The largest plugin in existence is a few tens of KB once bundled. This is room to grow, not a target. */
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_COUNT = 64;
export const ENTRYPOINT = 'index.mjs';

const MAX_PATH_LENGTH = 200;
const IGNORED_PATHS = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

/** Files of one plugin, keyed by a normalised path relative to its root. */
export type PluginFiles = Map<string, Buffer>;

/**
 * Turns an upload into the files of a plugin, without touching the disk.
 *
 * A plugin is a `.zip` holding `index.mjs` at its root, or a bare `.mjs` for the smallest case. The
 * archive is treated as hostile: sizes are counted as bytes are inflated rather than trusted from
 * the header, so a small upload cannot expand into a large one, and every path is rejected unless it
 * stays inside the plugin's own directory.
 */
export async function readPluginUpload(filename: string, bytes: Buffer): Promise<PluginFiles> {
  if (bytes.byteLength === 0) throw new BadRequestException('That file is empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new BadRequestException(`A plugin upload must be smaller than ${MAX_UPLOAD_BYTES} bytes`);

  const name = filename.toLowerCase();
  if (name.endsWith('.mjs')) return new Map([[ENTRYPOINT, bytes]]);
  if (name.endsWith('.zip')) return readArchive(bytes);
  throw new BadRequestException('A plugin is a .zip archive containing index.mjs, or a single .mjs file');
}

async function readArchive(bytes: Buffer): Promise<PluginFiles> {
  let directory: unzipper.CentralDirectory;
  try {
    directory = await unzipper.Open.buffer(bytes);
  } catch {
    throw new BadRequestException('That file is not a readable zip archive');
  }

  const entries = directory.files.filter((entry) => entry.type === 'File' && !IGNORED_PATHS.test(entry.path));
  if (entries.length === 0) throw new BadRequestException('That archive contains no files');
  if (entries.length > MAX_FILE_COUNT) throw new BadRequestException(`That archive contains more than ${MAX_FILE_COUNT} files`);

  const prefix = commonRootDirectory(entries.map((entry) => entry.path));
  const files: PluginFiles = new Map();
  let total = 0;

  for (const entry of entries) {
    const path = normalisePath(prefix ? entry.path.slice(prefix.length) : entry.path);
    if (files.has(path)) throw new BadRequestException(`That archive contains "${path}" more than once`);

    const content = await readBounded(entry, MAX_FILE_BYTES, path);
    total += content.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new BadRequestException(`That archive expands to more than ${MAX_TOTAL_BYTES} bytes`);
    files.set(path, content);
  }

  if (!files.has(ENTRYPOINT)) throw new BadRequestException(`That archive has no ${ENTRYPOINT} at its root`);
  return files;
}

/** Folders are what people zip, so a single wrapping directory is looked through rather than refused. */
function commonRootDirectory(paths: string[]): string {
  if (paths.includes(ENTRYPOINT)) return '';
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  const [root] = [...roots];
  return roots.size === 1 && paths.every((path) => path.startsWith(`${root}/`)) ? `${root}/` : '';
}

function normalisePath(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/')) {
    throw new BadRequestException(`"${raw.slice(0, 60)}" is not a usable file path`);
  }
  const path = posix.normalize(raw);
  if (path === '.' || path.startsWith('../') || path === '..' || path.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new BadRequestException(`"${raw.slice(0, 60)}" is not a usable file path`);
  }
  return path;
}

async function readBounded(entry: unzipper.File, limit: number, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = entry.stream();
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > limit) throw new BadRequestException(`"${path}" is larger than ${limit} bytes`);
      chunks.push(buffer);
    }
  } catch (error) {
    stream.destroy();
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(`"${path}" could not be read from the archive`);
  }
  return Buffer.concat(chunks);
}
