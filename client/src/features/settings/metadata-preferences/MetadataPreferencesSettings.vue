<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import type { ProviderConfigurations } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import ProviderConfigPanel from './components/ProviderConfigPanel.vue'
import ProviderPluginsPanel from './components/ProviderPluginsPanel.vue'
import { useProviderConfig } from './composables/useProviderConfig'
import { useProviderThrottleRuntime } from './composables/useProviderThrottleRuntime'

const { config, statuses, saving, testingByKey, testResultsByKey, passingTestSignatureByKey, fetchConfig, saveConfig, testProvider } =
  useProviderConfig()
const { runtimeByKey, startPolling, stopPolling } = useProviderThrottleRuntime()
/** Installing a plugin runs its code in the server process, so only an administrator is offered it. */
const { isSuperuser } = usePermissions()

async function refreshProviders() {
  await fetchConfig().catch(() => undefined)
}

onMounted(() => {
  startPolling()
  void fetchConfig().catch(() => undefined)
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <ProviderConfigPanel
    :config="config"
    :statuses="statuses"
    :runtime-by-key="runtimeByKey"
    :saving="saving"
    :testing-by-key="testingByKey"
    :test-results-by-key="testResultsByKey"
    :passing-test-signature-by-key="passingTestSignatureByKey"
    @save="saveConfig($event as Partial<ProviderConfigurations>)"
    @test="testProvider"
  />
  <ProviderPluginsPanel v-if="isSuperuser" :on-changed="refreshProviders" />
</template>
