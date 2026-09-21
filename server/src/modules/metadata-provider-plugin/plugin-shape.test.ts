import { describe, expect, it } from 'vitest';

import { assertProviderPluginShape, isPluginTypeSlug, type DeclaredProviderPluginShape } from './plugin-shape';

function valid(overrides: Partial<DeclaredProviderPluginShape> = {}): DeclaredProviderPluginShape {
  return { apiVersion: 1, type: 'acme-books', label: 'Acme Books', hasSearch: true, ...overrides };
}

describe('assertProviderPluginShape', () => {
  it('accepts the smallest valid plugin', () => {
    expect(() => assertProviderPluginShape(valid())).not.toThrow();
  });

  it('accepts every optional field when well formed', () => {
    expect(() =>
      assertProviderPluginShape(
        valid({
          version: '1.2.3-beta.1',
          description: 'Text',
          mediaKinds: ['ebook', 'comic'],
          timeoutMs: 20_000,
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['a different API version', { apiVersion: 2 }, /API version 2/],
    ['no API version', { apiVersion: undefined }, /API version undefined/],
    ['an uppercase type', { type: 'Acme Books' }, /lowercase slug/],
    ['a type with a path separator', { type: '../evil' }, /lowercase slug/],
    ['an over-long type', { type: 'a'.repeat(31) }, /lowercase slug/],
    ['a blank label', { label: '  ' }, /label/],
    ['a leading v in the version', { version: 'v1.0.0' }, /semantic version/],
    ['a non-string description', { description: 5 }, /description/],
    ['no search function', { hasSearch: false }, /no search function/],
    ['an empty media kind list', { mediaKinds: [] }, /media kinds/],
    ['an unknown media kind', { mediaKinds: ['podcast'] }, /not a media kind/],
    ['a timeout below the floor', { timeoutMs: 10 }, /timeout/],
    ['a fractional timeout', { timeoutMs: 1500.5 }, /timeout/],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => assertProviderPluginShape(valid(overrides as Partial<DeclaredProviderPluginShape>))).toThrow(message);
  });
});

describe('isPluginTypeSlug', () => {
  it('matches only lowercase slugs that are safe as a directory name', () => {
    expect(isPluginTypeSlug('acme-books')).toBe(true);
    expect(isPluginTypeSlug('acme-books')).toBe(true);
    expect(isPluginTypeSlug('.hidden')).toBe(false);
    expect(isPluginTypeSlug('a/b')).toBe(false);
    expect(isPluginTypeSlug('')).toBe(false);
  });
});
