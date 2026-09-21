<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Plug, Trash2, TriangleAlert, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import SettingsEditorSheet from '@/features/settings/components/SettingsEditorSheet.vue'
import SettingsSection from '@/features/settings/components/SettingsSection.vue'
import { useProviderPlugins } from '../composables/useProviderPlugins'

const props = defineProps<{
  /** Refetches the provider list that sits above this panel, which is built from the same server state. */
  onChanged?: () => Promise<void> | void
}>()

const { t } = useI18n()

const {
  plugins,
  failures,
  loading,
  loadFailed,
  busy,
  review,
  pendingRemoval,
  togglingType,
  removingType,
  fetchPlugins,
  handleFileChosen,
  cancelReview,
  confirmInstall,
  setEnabled,
  askRemove,
  cancelRemove,
  confirmRemove,
} = useProviderPlugins({ onChanged: () => props.onChanged?.() })

const fileInput = ref<HTMLInputElement | null>(null)

function openPicker() {
  fileInput.value?.click()
}

onMounted(() => {
  void fetchPlugins()
})
</script>

<template>
  <section class="mt-8 space-y-3" aria-labelledby="provider-plugins-heading">
    <div class="flex min-h-8 items-center justify-between gap-2">
      <h2 id="provider-plugins-heading" class="settings-group-label mb-0">{{ t('settings.metadata.plugins.title') }}</h2>
      <Button size="sm" variant="outline" :disabled="busy" @click="openPicker">
        <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
        <Upload v-else :size="14" aria-hidden="true" />
        {{ t('settings.metadata.plugins.install') }}
      </Button>
      <input
        ref="fileInput"
        type="file"
        accept=".zip,.mjs"
        class="hidden"
        :aria-label="t('settings.metadata.plugins.install')"
        @change="handleFileChosen"
      />
    </div>

    <p class="settings-hint settings-prose">{{ t('settings.metadata.plugins.hint') }}</p>

    <div v-if="loading" class="settings-loading-state">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('settings.metadata.plugins.loading') }}</span>
    </div>

    <template v-else>
      <p v-if="loadFailed" role="alert" class="text-sm text-destructive">{{ t('settings.metadata.plugins.loadFailed') }}</p>

      <ul v-if="failures.length" class="space-y-2" :aria-label="t('settings.metadata.plugins.failuresLabel')">
        <li
          v-for="failure in failures"
          :key="failure.directory"
          class="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm"
        >
          <TriangleAlert :size="15" class="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <p class="min-w-0 flex-1 break-words">
            <span class="font-mono text-xs font-semibold">{{ failure.directory }}</span>
            <span class="text-muted-foreground"> · {{ t('settings.metadata.plugins.failedToLoad', { reason: failure.reason }) }}</span>
          </p>
        </li>
      </ul>

      <div
        v-if="!plugins.length && !failures.length"
        class="settings-empty-state flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 text-start md:px-5"
      >
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
          <Plug :size="17" />
        </span>
        <p role="status" class="min-w-56 flex-1 text-sm text-muted-foreground">{{ t('settings.metadata.plugins.none') }}</p>
      </div>

      <ul v-else-if="plugins.length" class="space-y-2">
        <li v-for="plugin in plugins" :key="plugin.type" class="settings-card flex items-start gap-3 px-4 py-3">
          <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
            <Plug :size="16" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
              <span>{{ plugin.label }}</span>
              <span v-if="plugin.version" class="text-xs font-normal text-muted-foreground">v{{ plugin.version }}</span>
              <span class="font-mono text-[11px] font-normal text-muted-foreground">{{ plugin.key }}</span>
            </p>
            <p v-if="plugin.description" class="settings-hint mt-0.5">{{ plugin.description }}</p>
            <p class="settings-hint mt-0.5">
              {{ t('settings.metadata.plugins.media', { kinds: plugin.mediaKinds.join(', ') }) }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <ToggleSwitch
              :model-value="plugin.enabled"
              :disabled="togglingType === plugin.type"
              :aria-label="t('settings.metadata.plugins.toggle', { label: plugin.label })"
              @update:model-value="setEnabled(plugin, $event)"
            />
            <Button
              size="icon"
              variant="ghost"
              class="size-8"
              :disabled="removingType !== null"
              :aria-label="t('settings.metadata.plugins.remove', { label: plugin.label })"
              @click="askRemove(plugin)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </Button>
          </div>
        </li>
      </ul>

      <p v-if="plugins.length" class="settings-hint">{{ t('settings.metadata.plugins.enableHint') }}</p>
    </template>

    <ConfirmDialog
      :open="pendingRemoval !== null"
      :title="t('settings.metadata.plugins.confirmRemove', { label: pendingRemoval?.label ?? '' })"
      :description="t('settings.metadata.plugins.removeWarning')"
      :confirm-label="t('settings.metadata.plugins.removeAction')"
      :busy="removingType !== null"
      @confirm="confirmRemove"
      @cancel="cancelRemove"
    />

    <!--
      The source is shown rather than summarised. Installing a plugin runs its code in the server
      process, so reading it first is what the person is being asked to do.
    -->
    <SettingsEditorSheet
      :open="review !== null"
      :title="review?.replaces ? t('settings.metadata.plugins.replaceTitle') : t('settings.metadata.plugins.reviewTitle')"
      :description="t('settings.metadata.plugins.reviewDescription')"
      :busy="busy"
      @save="confirmInstall"
      @cancel="cancelReview"
    >
      <template v-if="review" #default>
        <SettingsSection :title="t('settings.metadata.plugins.declares')">
          <dl class="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="settings-hint">{{ t('settings.metadata.plugins.name') }}</dt>
              <dd class="text-foreground">{{ review.label }}</dd>
            </div>
            <div>
              <dt class="settings-hint">{{ t('settings.metadata.plugins.key') }}</dt>
              <dd class="font-mono text-xs text-foreground">{{ review.key }}</dd>
            </div>
            <div>
              <dt class="settings-hint">{{ t('settings.metadata.plugins.version') }}</dt>
              <dd class="text-foreground">{{ review.version ?? t('settings.metadata.plugins.versionUnknown') }}</dd>
            </div>
            <div>
              <dt class="settings-hint">{{ t('settings.metadata.plugins.mediaLabel') }}</dt>
              <dd class="text-foreground">{{ review.mediaKinds.join(', ') }}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="settings-hint">{{ t('settings.metadata.plugins.files') }}</dt>
              <dd class="font-mono text-xs break-all text-foreground">{{ review.files.join(', ') }}</dd>
            </div>
          </dl>

          <p role="alert" class="settings-hint text-destructive">{{ t('settings.metadata.plugins.trustWarning') }}</p>
          <p v-if="review.replaces" role="status" class="settings-hint text-primary">
            {{ t('settings.metadata.plugins.replaces', { type: review.type }) }}
          </p>
        </SettingsSection>

        <SettingsSection :title="t('settings.metadata.plugins.source')">
          <pre
            class="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs text-foreground"
          ><code>{{ review.source }}</code></pre>
        </SettingsSection>
      </template>

      <!-- This step runs code rather than saving a form, so the action says which of the two it is. -->
      <template #footer="{ requestClose }">
        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="busy" @click="confirmInstall">
            <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
            {{ review?.replaces ? t('settings.metadata.plugins.replace') : t('settings.metadata.plugins.confirmInstall') }}
          </Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="requestClose">{{ t('common.cancel') }}</Button>
        </div>
      </template>
    </SettingsEditorSheet>
  </section>
</template>
