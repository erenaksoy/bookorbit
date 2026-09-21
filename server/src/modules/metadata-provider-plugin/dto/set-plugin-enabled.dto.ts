import { IsBoolean } from 'class-validator';

export class SetMetadataProviderPluginEnabledDto {
  @IsBoolean() enabled!: boolean;
}
