import { Module } from '@nestjs/common';

import { MetadataProviderPluginModule } from '../metadata-provider-plugin/metadata-provider-plugin.module';
import { MetadataPreferenceResolver } from './metadata-preference-resolver';
import { MetadataPreferencesController } from './metadata-preferences.controller';
import { MetadataPreferencesService } from './metadata-preferences.service';
import { ProviderConfigController } from './provider-config.controller';
import { ProviderConfigService } from './provider-config.service';
import { ProviderLinkSettingsController } from './provider-link-settings.controller';

@Module({
  imports: [MetadataProviderPluginModule],
  controllers: [MetadataPreferencesController, ProviderConfigController, ProviderLinkSettingsController],
  providers: [MetadataPreferencesService, MetadataPreferenceResolver, ProviderConfigService],
  exports: [MetadataPreferencesService, MetadataPreferenceResolver, ProviderConfigService],
})
export class MetadataPreferencesModule {}
