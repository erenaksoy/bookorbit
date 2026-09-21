import type { BookRequestMediaKind } from "./book-request";
import type { PluginProviderKey } from "./metadata-fetch";

/** A metadata provider plugin as installed, for the settings page. */
export interface MetadataProviderPluginInfo {
  type: string;
  key: PluginProviderKey;
  label: string;
  description?: string;
  version?: string;
  mediaKinds: BookRequestMediaKind[];
  enabled: boolean;
}

/** A plugin directory that would not load, so the settings page can say which one and why. */
export interface MetadataProviderPluginFailure {
  directory: string;
  reason: string;
}

export interface MetadataProviderPluginListResult {
  plugins: MetadataProviderPluginInfo[];
  failures: MetadataProviderPluginFailure[];
}

/**
 * What an uploaded plugin says it is, read in a child process before anything is kept.
 *
 * Carries the entry source back on purpose: installing a plugin runs its code in the BookOrbit
 * process, so the operator is shown what they are about to run.
 */
export interface MetadataProviderPluginInspection {
  type: string;
  key: PluginProviderKey;
  label: string;
  description?: string;
  version?: string;
  mediaKinds: BookRequestMediaKind[];
  /** Files the upload contains, relative to the plugin root. */
  files: string[];
  /** The entry module, for the operator to read before confirming. */
  source: string;
  /** Whether a plugin of this type is already installed, so the confirmation can say "replace". */
  replaces: boolean;
}

/** `active` is false only when the files are on disk but would not load, which a restart will retry. */
export interface MetadataProviderPluginInstallResult extends MetadataProviderPluginInspection {
  active: boolean;
}

export interface SetMetadataProviderPluginEnabledRequest {
  enabled: boolean;
}
