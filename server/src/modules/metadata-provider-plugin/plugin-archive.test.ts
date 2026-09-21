import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { buildRawZip, buildZip, samplePluginSource } from '../../common/test-utils/metadata-provider-plugin-fixtures';
import { MAX_FILE_BYTES, MAX_FILE_COUNT, MAX_UPLOAD_BYTES, readPluginUpload } from './plugin-archive';

describe('readPluginUpload', () => {
  it('treats a bare .mjs as a single-file plugin', async () => {
    const files = await readPluginUpload('plugin.mjs', Buffer.from(samplePluginSource()));

    expect([...files.keys()]).toEqual(['index.mjs']);
  });

  it('reads a zip with index.mjs at its root', async () => {
    const zip = await buildZip({ 'index.mjs': samplePluginSource(), 'README.md': '# readme' });

    const files = await readPluginUpload('plugin.zip', zip);

    expect([...files.keys()].sort()).toEqual(['README.md', 'index.mjs']);
    expect(files.get('README.md')?.toString()).toBe('# readme');
  });

  it('looks through a single wrapping directory, since folders are what people zip', async () => {
    const zip = await buildZip({ 'my-plugin/index.mjs': samplePluginSource(), 'my-plugin/lib/data.json': '{}' });

    const files = await readPluginUpload('my-plugin.zip', zip);

    expect([...files.keys()].sort()).toEqual(['index.mjs', 'lib/data.json']);
  });

  it('ignores macOS metadata that a Finder zip carries', async () => {
    const zip = await buildZip({ 'index.mjs': samplePluginSource(), '__MACOSX/._index.mjs': 'x', '.DS_Store': 'x' });

    const files = await readPluginUpload('plugin.zip', zip);

    expect([...files.keys()]).toEqual(['index.mjs']);
  });

  it('rejects an archive with no index.mjs', async () => {
    const zip = await buildZip({ 'main.mjs': 'export default {}' });

    await expect(readPluginUpload('plugin.zip', zip)).rejects.toThrow(/no index\.mjs/);
  });

  it.each(['../escape.mjs', 'a/../../escape.mjs', 'sub\\evil.mjs', '/etc/passwd'])('rejects the path %s', async (path) => {
    const zip = buildRawZip([
      { name: 'index.mjs', data: samplePluginSource() },
      { name: path, data: 'x' },
    ]);

    await expect(readPluginUpload('plugin.zip', zip)).rejects.toThrow(BadRequestException);
  });

  it('rejects a file larger than the per-file limit, counted as it inflates', async () => {
    const zip = await buildZip({ 'index.mjs': samplePluginSource(), 'big.bin': Buffer.alloc(MAX_FILE_BYTES + 1, 1) });

    await expect(readPluginUpload('plugin.zip', zip)).rejects.toThrow(/larger than/);
  });

  it('rejects an archive with too many files', async () => {
    const entries: Record<string, string> = { 'index.mjs': samplePluginSource() };
    for (let i = 0; i < MAX_FILE_COUNT; i++) entries[`f${i}.txt`] = 'x';

    await expect(readPluginUpload('plugin.zip', await buildZip(entries))).rejects.toThrow(/more than/);
  });

  it('rejects an upload past the size limit before reading it', async () => {
    await expect(readPluginUpload('plugin.zip', Buffer.alloc(MAX_UPLOAD_BYTES + 1))).rejects.toThrow(/smaller than/);
  });

  it('rejects something that is not a zip', async () => {
    await expect(readPluginUpload('plugin.zip', Buffer.from('not a zip at all'))).rejects.toThrow(/not a readable zip/);
  });

  it('rejects an empty file and an unsupported extension', async () => {
    await expect(readPluginUpload('plugin.zip', Buffer.alloc(0))).rejects.toThrow(/empty/);
    await expect(readPluginUpload('plugin.exe', Buffer.from('x'))).rejects.toThrow(/\.zip archive/);
  });
});
