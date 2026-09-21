import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { IsMetadataProviderKey, isMetadataProviderKey } from './metadata-provider-key.utils';

describe('isMetadataProviderKey', () => {
  it.each(['google', 'openLibrary', 'aladin', 'plugin:acme-books', 'plugin:a-1'])('accepts %s', (key) => {
    expect(isMetadataProviderKey(key)).toBe(true);
  });

  it.each(['', 'plugin:', 'plugin:UPPER', 'plugin:has space', 'plugin:a/b', 'plugin:' + 'a'.repeat(31), 'acme-books', 'nope', 5, null, undefined])(
    'rejects %s',
    (key) => {
      expect(isMetadataProviderKey(key)).toBe(false);
    },
  );
});

describe('IsMetadataProviderKey', () => {
  class Subject {
    @IsMetadataProviderKey() key!: string;
    @IsMetadataProviderKey({ each: true }) keys!: string[];
  }

  it('passes valid values and reports each invalid property', async () => {
    expect(await validate(Object.assign(new Subject(), { key: 'plugin:x', keys: ['google', 'plugin:y'] }))).toEqual([]);

    const errors = await validate(Object.assign(new Subject(), { key: 'bogus', keys: ['google', 'bogus'] }));

    expect(errors.map((error) => error.property).sort()).toEqual(['key', 'keys']);
  });
});
