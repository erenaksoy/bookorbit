import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import { AuditAction, AuditResource, Permission } from '@bookorbit/types';
import type { MetadataProviderPluginInspection, MetadataProviderPluginInstallResult, MetadataProviderPluginListResult } from '@bookorbit/types';

import { Auditable } from '../../common/decorators/auditable.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { MultipartRequest } from '../../common/types/multipart-request';
import type { RequestUser } from '../../common/types/request-user';
import { SetMetadataProviderPluginEnabledDto } from './dto/set-plugin-enabled.dto';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { MAX_UPLOAD_BYTES, readPluginUpload, type PluginFiles } from './plugin-archive';
import { PluginInstallService } from './plugin-install.service';
import { PluginLoaderService } from './plugin-loader.service';

/**
 * A plugin is code that runs with the server's own reach, so every route here is superuser-only
 * and enforced on the server. `ManageAppSettings` alone is not enough: a role that may edit
 * settings must not be able to introduce code.
 */
@Controller('admin/metadata-provider-plugins')
@RequirePermission(Permission.ManageAppSettings)
export class MetadataProviderPluginController {
  constructor(
    private readonly registry: MetadataProviderPluginRegistry,
    private readonly loader: PluginLoaderService,
    private readonly installer: PluginInstallService,
  ) {}

  /** What is installed, and what failed to load: a plugin that just did not appear is the worst way to learn of a typo. */
  @Get()
  list(@CurrentUser() user: RequestUser): MetadataProviderPluginListResult {
    assertSuperuser(user);
    return { plugins: this.registry.describe(), failures: [...this.loader.loadFailures()] };
  }

  /**
   * Reads an upload without keeping it. Audited even though nothing is kept: reading the plugin
   * means executing it, so this is the point uploaded code first runs on the server.
   */
  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @Auditable({
    action: AuditAction.MetadataProviderPluginInspect,
    resource: AuditResource.MetadataProviderPlugin,
    description: (_req, res: unknown) => `Inspected metadata provider plugin '${(res as MetadataProviderPluginInspection)?.type ?? 'unknown'}'`,
  })
  async inspect(@CurrentUser() user: RequestUser, @Req() req: MultipartRequest): Promise<MetadataProviderPluginInspection> {
    return this.installer.inspect(await readUpload(user, req));
  }

  /** The same file again rather than a token for the one just inspected, so what was checked is what lands. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({
    action: AuditAction.MetadataProviderPluginInstall,
    resource: AuditResource.MetadataProviderPlugin,
    description: (_req, res: unknown) =>
      `${(res as MetadataProviderPluginInspection)?.replaces ? 'Replaced' : 'Installed'} metadata provider plugin '${(res as MetadataProviderPluginInspection)?.type ?? 'unknown'}'`,
  })
  async install(@CurrentUser() user: RequestUser, @Req() req: MultipartRequest): Promise<MetadataProviderPluginInstallResult> {
    return this.installer.install(await readUpload(user, req), user.email ?? `user:${user.id}`);
  }

  @Put(':type/enabled')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({
    action: AuditAction.MetadataProviderPluginEnable,
    resource: AuditResource.MetadataProviderPlugin,
    description: (req: unknown) => {
      const { params, body } = req as { params?: { type?: string }; body?: { enabled?: boolean } };
      return `${body?.enabled ? 'Enabled' : 'Disabled'} metadata provider plugin '${params?.type ?? 'unknown'}'`;
    },
  })
  async setEnabled(@CurrentUser() user: RequestUser, @Param('type') type: string, @Body() dto: SetMetadataProviderPluginEnabledDto): Promise<void> {
    assertSuperuser(user);
    await this.installer.setEnabled(type, dto.enabled);
  }

  @Delete(':type')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({
    action: AuditAction.MetadataProviderPluginRemove,
    resource: AuditResource.MetadataProviderPlugin,
    description: (req: unknown) => `Removed metadata provider plugin '${(req as { params?: { type?: string } })?.params?.type ?? 'unknown'}'`,
  })
  async remove(@CurrentUser() user: RequestUser, @Param('type') type: string): Promise<void> {
    assertSuperuser(user);
    await this.installer.remove(type, user.email ?? `user:${user.id}`);
  }
}

function assertSuperuser(user: RequestUser): void {
  if (!user.isSuperuser) throw new ForbiddenException('Only a superuser can manage metadata provider plugins');
}

async function readUpload(user: RequestUser, req: MultipartRequest): Promise<PluginFiles> {
  assertSuperuser(user);

  const upload = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (!upload) throw new BadRequestException('No file provided');

  const bytes = await upload.toBuffer();
  // Fastify truncates rather than throwing once the limit is passed, so a file that hit the cap
  // would otherwise arrive as a plausible-looking prefix and fail later as a corrupt archive.
  if (upload.file.truncated) throw new BadRequestException(`A plugin upload must be smaller than ${MAX_UPLOAD_BYTES} bytes`);
  return readPluginUpload(upload.filename, bytes);
}
