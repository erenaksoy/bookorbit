import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import type { MetadataProviderKey } from '@bookorbit/types';
import { IsMetadataProviderKey } from '../../../common/utils/metadata-provider-key.utils';

export class LookupMetadataDto {
  @IsMetadataProviderKey()
  provider: MetadataProviderKey;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  id: string;
}
