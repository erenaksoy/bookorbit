import { BOOK_REQUEST_MEDIA_KINDS, PLUGIN_PROVIDER_TYPE_PATTERN } from '@bookorbit/types';

/** Bumped in step with `METADATA_PROVIDER_PLUGIN_API_VERSION` in `@bookorbit/plugin-api`. */
export const METADATA_PROVIDER_PLUGIN_API_VERSION = 1;

export const MIN_PLUGIN_TIMEOUT_MS = 1_000;
export const MAX_PLUGIN_TIMEOUT_MS = 60_000;
export const DEFAULT_PLUGIN_TIMEOUT_MS = 15_000;

const MAX_LABEL_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 500;

export function isPluginTypeSlug(value: string): boolean {
  return PLUGIN_PROVIDER_TYPE_PATTERN.test(value);
}

/**
 * What a plugin declares about itself, with its functions reduced to whether they are there.
 *
 * Shaped this way so one rule set judges both a plugin the loader imported into this process and a
 * plugin the installer only ever ran in a child process. Two rule sets would drift, and the way they
 * would drift is that something installable stops being loadable.
 */
export interface DeclaredProviderPluginShape {
  apiVersion?: unknown;
  version?: unknown;
  type?: unknown;
  label?: unknown;
  description?: unknown;
  mediaKinds?: unknown;
  timeoutMs?: unknown;
  hasSearch: boolean;
}

/**
 * Checked before a plugin is ever called rather than when a search fails, so a malformed plugin is a
 * message on the settings page and not a provider that silently returns nothing.
 */
export function assertProviderPluginShape(plugin: DeclaredProviderPluginShape): void {
  if (plugin.apiVersion !== METADATA_PROVIDER_PLUGIN_API_VERSION) {
    throw new Error(
      `it targets metadata provider plugin API version ${String(plugin.apiVersion)}, and this build speaks version ${METADATA_PROVIDER_PLUGIN_API_VERSION}`,
    );
  }
  if (typeof plugin.type !== 'string' || !isPluginTypeSlug(plugin.type)) {
    throw new Error('its type must be a lowercase slug of at most 30 characters');
  }
  if (typeof plugin.label !== 'string' || plugin.label.trim() === '' || plugin.label.length > MAX_LABEL_LENGTH) {
    throw new Error(`its label must be between 1 and ${MAX_LABEL_LENGTH} characters`);
  }
  if (plugin.version !== undefined && (typeof plugin.version !== 'string' || !isSemanticVersion(plugin.version))) {
    throw new Error('its version must be a semantic version such as 1.2.3, without a leading "v"');
  }
  if (plugin.description !== undefined && (typeof plugin.description !== 'string' || plugin.description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new Error(`its description must be text of at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (!plugin.hasSearch) throw new Error('it exports no search function');

  if (plugin.mediaKinds !== undefined) {
    if (!Array.isArray(plugin.mediaKinds) || plugin.mediaKinds.length === 0) throw new Error('its media kinds must be a non-empty list, or omitted');
    for (const kind of plugin.mediaKinds) {
      if (!(BOOK_REQUEST_MEDIA_KINDS as readonly string[]).includes(kind as string)) throw new Error(`"${String(kind)}" is not a media kind`);
    }
  }

  if (plugin.timeoutMs !== undefined) {
    const timeout = plugin.timeoutMs;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_PLUGIN_TIMEOUT_MS || timeout > MAX_PLUGIN_TIMEOUT_MS) {
      throw new Error(`its timeout must be a whole number of milliseconds between ${MIN_PLUGIN_TIMEOUT_MS} and ${MAX_PLUGIN_TIMEOUT_MS}`);
    }
  }
}

function isSemanticVersion(version: string): boolean {
  return (
    version.length <= 64 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
  );
}
