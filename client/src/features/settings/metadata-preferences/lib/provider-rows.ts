import type { PluginProviderKey, ProviderConfigurations } from '@bookorbit/types'
export { AMAZON_DOMAINS } from '@/lib/amazon-domain'

/**
 * The medium a source supplies metadata for. Sources are picked by medium ("I want
 * audiobook narrators"), not alphabetically, so the list is sectioned the same way.
 */
export type ProviderGroupId = 'books' | 'audiobooks' | 'comics' | 'regional'

export const PROVIDER_GROUP_ORDER: ProviderGroupId[] = ['books', 'audiobooks', 'comics', 'regional']

export interface ProviderFieldDef {
  key: string
  label: string
  type: 'text' | 'password' | 'select'
  options?: readonly string[]
  placeholder?: string
  helper?: string
  /** Editable while the provider is still off, because enabling it depends on this value. */
  alwaysEditable?: boolean
  widthClass?: string
}

export interface ProviderEnableRequirement {
  isConfigured: (config: ProviderConfigurations) => boolean
  blockedMessage: string
  requiresPassingTest?: boolean
  missingTestMessage?: string
}

/** The providers that have a slot in the config document. A plugin's switch is kept elsewhere. */
export type BuiltInProviderKey = Exclude<keyof ProviderConfigurations, PluginProviderKey>

export interface ProviderRowDef {
  key: BuiltInProviderKey
  label: string
  group: ProviderGroupId
  hint?: string
  fields: ProviderFieldDef[]
  enableRequirement?: ProviderEnableRequirement
}

/** A provider slice of the draft, addressed by field key rather than by concrete shape. */
export type ProviderDraftEntry = { enabled: boolean } & Record<string, unknown>

export const AUDIBLE_DOMAINS = [
  'audible.com',
  'audible.co.uk',
  'audible.de',
  'audible.fr',
  'audible.it',
  'audible.es',
  'audible.ca',
  'audible.com.au',
  'audible.co.jp',
  'audible.in',
]

export const KOBO_COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'de', 'fr', 'it', 'es', 'nl', 'pt', 'br', 'jp']
export const KOBO_LANGUAGES = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'ja', 'all']

const SELECT_WIDTH = 'sm:w-44'
const WIDE_SELECT_WIDTH = 'sm:w-52'
const SECRET_WIDTH = 'sm:w-[26rem]'

export const PROVIDER_FIELD_WIDTHS = { SELECT_WIDTH, WIDE_SELECT_WIDTH, SECRET_WIDTH } as const

/** How a source is doing right now, shown as one chip per row. */
export type ProviderChipKind = 'active' | 'ready' | 'setup' | 'throttled'

export interface ProviderChipView {
  kind: ProviderChipKind
  label: string
  /** Spelled-out state for the tooltip and assistive tech when the label is a bare duration. */
  title?: string
}

/**
 * The provider config document keeps one slot per built-in provider. A plugin's on/off switch lives
 * with the plugin manager, so it must not travel back in a save: the server refuses unknown keys.
 */
export function withoutPluginProviders(config: ProviderConfigurations): Partial<ProviderConfigurations> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('plugin:'))) as Partial<ProviderConfigurations>
}
