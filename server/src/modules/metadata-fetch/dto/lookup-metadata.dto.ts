import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { METADATA_CACHE_REQUEST_POLICIES } from '@bookorbit/types';
import type { MetadataCacheRequestPolicy, MetadataProviderKey } from '@bookorbit/types';
import { IsMetadataProviderKey } from '../../../common/utils/metadata-provider-key.utils';

export class LookupMetadataDto {
  @IsMetadataProviderKey()
  provider: MetadataProviderKey;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  id: string;

  /** `refresh` asks the provider live instead of answering from the metadata cache. */
  @IsOptional()
  @IsIn(METADATA_CACHE_REQUEST_POLICIES)
  cache?: MetadataCacheRequestPolicy;
}
