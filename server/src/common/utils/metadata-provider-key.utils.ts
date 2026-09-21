import { buildMessage, ValidateBy, type ValidationOptions } from 'class-validator';
import { isPluginProviderKey, MetadataProviderKey } from '@bookorbit/types';

const BUILT_IN_PROVIDER_KEYS: ReadonlySet<string> = new Set(Object.values(MetadataProviderKey));

export function isMetadataProviderKey(value: unknown): value is MetadataProviderKey {
  return typeof value === 'string' && (BUILT_IN_PROVIDER_KEYS.has(value) || isPluginProviderKey(value));
}

/** Accepts a built-in provider key or the key of a plugin provider, installed or not. */
export function IsMetadataProviderKey(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isMetadataProviderKey',
      validator: {
        validate: (value: unknown) => isMetadataProviderKey(value),
        defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property must be a known metadata provider key`, validationOptions),
      },
    },
    validationOptions,
  );
}
