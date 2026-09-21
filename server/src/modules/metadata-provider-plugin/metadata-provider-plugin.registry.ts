import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MetadataProviderPluginInfo, PluginProviderKey, SimpleProviderConfig } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { PluginMetadataProvider } from './plugin-metadata-provider';

type Db = NodePgDatabase<typeof schema>;

const STATE_KEY = 'metadata_provider_plugins';

/**
 * The metadata providers that came from installed plugins, and which of them are switched on.
 *
 * Kept apart from `metadata_provider_config` on purpose: that document has one fixed slot per
 * built-in provider, while plugins come and go at runtime. A plugin arrives switched off, like a
 * built-in scraper, so installing code never starts sending requests until somebody opts in.
 */
@Injectable()
export class MetadataProviderPluginRegistry {
  private readonly logger = new Logger(MetadataProviderPluginRegistry.name);
  private readonly providersByKey = new Map<PluginProviderKey, PluginMetadataProvider>();
  private enabledTypes = new Set<string>();

  constructor(@Inject(DB) private readonly db: Db) {}

  providers(): PluginMetadataProvider[] {
    return [...this.providersByKey.values()];
  }

  find(key: string): PluginMetadataProvider | undefined {
    return this.providersByKey.get(key as PluginProviderKey);
  }

  register(provider: PluginMetadataProvider): void {
    this.providersByKey.set(provider.key, provider);
  }

  unregister(key: PluginProviderKey): void {
    this.providersByKey.delete(key);
  }

  isEnabled(key: string): boolean {
    return this.enabledTypes.has(typeOf(key));
  }

  /** One on/off entry per installed plugin, in the shape provider config lookups already use. */
  enabledConfig(): Record<PluginProviderKey, SimpleProviderConfig> {
    const config = {} as Record<PluginProviderKey, SimpleProviderConfig>;
    for (const provider of this.providersByKey.values()) config[provider.key] = { enabled: this.isEnabled(provider.key) };
    return config;
  }

  describe(): MetadataProviderPluginInfo[] {
    return this.providers()
      .map((provider) => ({
        type: typeOf(provider.key),
        key: provider.key,
        label: provider.label,
        ...(provider.description ? { description: provider.description } : {}),
        ...(provider.version ? { version: provider.version } : {}),
        mediaKinds: [...(provider.mediaKinds ?? ['ebook', 'audiobook', 'comic'])],
        enabled: this.isEnabled(provider.key),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async loadState(): Promise<void> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, STATE_KEY) });
    this.enabledTypes = parseEnabledTypes(row?.value);
  }

  async setEnabled(type: string, enabled: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${STATE_KEY})::bigint)`);
      const row = await tx.query.appSettings.findFirst({ where: eq(schema.appSettings.key, STATE_KEY) });
      const next = parseEnabledTypes(row?.value);
      if (enabled) next.add(type);
      else next.delete(type);
      const value = JSON.stringify({ enabled: [...next].sort() });
      await tx.insert(schema.appSettings).values({ key: STATE_KEY, value }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
      this.enabledTypes = next;
    });
    this.logger.log(`[metadata_provider_plugin.state] [end] type=${sanitizeLogValue(type)} enabled=${enabled} - plugin provider switched`);
  }

  /** Drops a removed plugin's switch, so reinstalling it later starts from off again. */
  async forget(type: string): Promise<void> {
    if (!this.enabledTypes.has(type)) return;
    await this.setEnabled(type, false);
  }
}

function typeOf(key: string): string {
  return key.slice('plugin:'.length);
}

function parseEnabledTypes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return new Set(Array.isArray(parsed.enabled) ? parsed.enabled.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}
