import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { buildZip, samplePluginSource } from '../../common/test-utils/metadata-provider-plugin-fixtures';
import type { RequestUser } from '../../common/types/request-user';
import { MetadataProviderPluginController } from './metadata-provider-plugin.controller';

const superuser = { id: 1, email: 'root@acme.test', isSuperuser: true } as RequestUser;
const admin = { id: 2, email: 'admin@acme.test', isSuperuser: false } as RequestUser;

function setup() {
  const registry = { describe: vi.fn().mockReturnValue([{ type: 'acme-books' }]) };
  const loader = { loadFailures: vi.fn().mockReturnValue([{ directory: 'bad', reason: 'oops' }]) };
  const installer = {
    inspect: vi.fn().mockResolvedValue({ type: 'acme-books' }),
    install: vi.fn().mockResolvedValue({ type: 'acme-books', active: true }),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new MetadataProviderPluginController(registry as never, loader as never, installer as never);
  return { controller, registry, loader, installer };
}

function upload(filename: string, bytes: Buffer, truncated = false) {
  return {
    file: vi.fn().mockResolvedValue({ filename, toBuffer: () => Promise.resolve(bytes), file: { truncated } }),
  } as never;
}

describe('MetadataProviderPluginController', () => {
  it('lists installed plugins and load failures for a superuser', () => {
    const { controller } = setup();

    expect(controller.list(superuser)).toEqual({ plugins: [{ type: 'acme-books' }], failures: [{ directory: 'bad', reason: 'oops' }] });
  });

  it('refuses every route to a user who is not a superuser, whatever permission they hold', async () => {
    const { controller, installer } = setup();
    const req = upload('p.mjs', Buffer.from(samplePluginSource()));

    expect(() => controller.list(admin)).toThrow(ForbiddenException);
    await expect(controller.inspect(admin, req)).rejects.toThrow(ForbiddenException);
    await expect(controller.install(admin, req)).rejects.toThrow(ForbiddenException);
    await expect(controller.setEnabled(admin, 'acme-books', { enabled: true })).rejects.toThrow(ForbiddenException);
    await expect(controller.remove(admin, 'acme-books')).rejects.toThrow(ForbiddenException);
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.inspect).not.toHaveBeenCalled();
    expect(installer.remove).not.toHaveBeenCalled();
  });

  it('installs the files of an uploaded zip, attributed to the person who uploaded it', async () => {
    const { controller, installer } = setup();
    const zip = await buildZip({ 'index.mjs': samplePluginSource() });

    await controller.install(superuser, upload('acme-books.zip', zip));

    const [files, by] = installer.install.mock.calls[0]!;
    expect([...(files as Map<string, Buffer>).keys()]).toEqual(['index.mjs']);
    expect(by).toBe('root@acme.test');
  });

  it('inspects without installing', async () => {
    const { controller, installer } = setup();

    await controller.inspect(superuser, upload('p.mjs', Buffer.from(samplePluginSource())));

    expect(installer.inspect).toHaveBeenCalledTimes(1);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('rejects a missing upload and one Fastify truncated at the limit', async () => {
    const { controller } = setup();

    await expect(controller.install(superuser, { file: vi.fn().mockResolvedValue(undefined) } as never)).rejects.toThrow(/No file/);
    await expect(controller.install(superuser, upload('p.zip', Buffer.from('x'), true))).rejects.toThrow(/smaller than/);
  });

  it('switches and removes a plugin', async () => {
    const { controller, installer } = setup();

    await controller.setEnabled(superuser, 'acme-books', { enabled: true });
    await controller.remove(superuser, 'acme-books');

    expect(installer.setEnabled).toHaveBeenCalledWith('acme-books', true);
    expect(installer.remove).toHaveBeenCalledWith('acme-books', 'root@acme.test');
  });
});
