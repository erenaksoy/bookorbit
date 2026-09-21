import { Module } from '@nestjs/common';

import { MetadataProviderPluginController } from './metadata-provider-plugin.controller';
import { MetadataProviderPluginRegistry } from './metadata-provider-plugin.registry';
import { PluginInstallService } from './plugin-install.service';
import { PluginLoaderService } from './plugin-loader.service';

@Module({
  controllers: [MetadataProviderPluginController],
  providers: [MetadataProviderPluginRegistry, PluginLoaderService, PluginInstallService],
  exports: [MetadataProviderPluginRegistry],
})
export class MetadataProviderPluginModule {}
