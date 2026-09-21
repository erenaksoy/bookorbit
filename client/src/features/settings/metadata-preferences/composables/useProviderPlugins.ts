import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type {
  MetadataProviderPluginFailure,
  MetadataProviderPluginInfo,
  MetadataProviderPluginInspection,
  MetadataProviderPluginInstallResult,
  MetadataProviderPluginListResult,
} from '@bookorbit/types'
import { api } from '@/lib/api'

const BASE_PATH = '/api/v1/admin/metadata-provider-plugins'

async function failureMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: string | string[] }
    return Array.isArray(body.message) ? (body.message[0] ?? null) : (body.message ?? null)
  } catch {
    return null
  }
}

/**
 * Installing, switching and removing metadata provider plugins.
 *
 * Installing runs the plugin's code in the server process, so it goes in two steps that both send the
 * file: the first only inspects it so the person can read what they are about to run, the second
 * installs. Sending the file twice, rather than a token for the first, is what guarantees the bytes
 * that were reviewed are the bytes that land.
 *
 * `onChanged` runs after anything that changes which providers exist or are on, because the provider
 * lists elsewhere on the page are built from the same server state.
 */
export function useProviderPlugins(options: { onChanged?: () => Promise<void> | void } = {}) {
  const { t } = useI18n()

  const plugins = ref<MetadataProviderPluginInfo[]>([])
  const failures = ref<MetadataProviderPluginFailure[]>([])
  const loading = ref(false)
  const loadFailed = ref(false)
  const busy = ref(false)
  const review = ref<MetadataProviderPluginInspection | null>(null)
  const pendingRemoval = ref<MetadataProviderPluginInfo | null>(null)
  const togglingType = ref<string | null>(null)
  const removingType = ref<string | null>(null)
  let pendingFile: File | null = null

  async function fetchPlugins(silent = false) {
    if (!silent) loading.value = true
    try {
      const res = await api(BASE_PATH)
      if (!res.ok) {
        loadFailed.value = true
        return
      }
      const result = (await res.json()) as Partial<MetadataProviderPluginListResult>
      plugins.value = result.plugins ?? []
      failures.value = result.failures ?? []
      loadFailed.value = false
    } catch {
      loadFailed.value = true
    } finally {
      loading.value = false
    }
  }

  async function sendFile<T>(path: string, file: File): Promise<{ result: T | null; error: string | null }> {
    const body = new FormData()
    body.append('file', file)
    try {
      const res = await api(path, { method: 'POST', body })
      if (!res.ok) return { result: null, error: await failureMessage(res) }
      return { result: (await res.json()) as T, error: null }
    } catch {
      return { result: null, error: null }
    }
  }

  async function inspectFile(file: File) {
    busy.value = true
    try {
      const { result, error } = await sendFile<MetadataProviderPluginInspection>(`${BASE_PATH}/inspect`, file)
      if (!result) {
        toast.error(error ?? t('settings.metadata.plugins.inspectFailed'))
        return
      }
      pendingFile = file
      review.value = result
    } finally {
      busy.value = false
    }
  }

  function handleFileChosen(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0] ?? null
    // Cleared so choosing the same file twice still fires a change event.
    input.value = ''
    if (file) void inspectFile(file)
  }

  function cancelReview() {
    if (busy.value) return
    review.value = null
    pendingFile = null
  }

  async function confirmInstall() {
    const file = pendingFile
    if (!file) return
    busy.value = true
    try {
      const { result, error } = await sendFile<MetadataProviderPluginInstallResult>(BASE_PATH, file)
      if (!result) {
        toast.error(error ?? t('settings.metadata.plugins.installFailed'))
        return
      }
      toast.success(t('settings.metadata.plugins.installed', { label: result.label }))
      review.value = null
      pendingFile = null
      await fetchPlugins(true)
      await options.onChanged?.()
    } finally {
      busy.value = false
    }
  }

  async function setEnabled(plugin: MetadataProviderPluginInfo, enabled: boolean) {
    togglingType.value = plugin.type
    try {
      const res = await api(`${BASE_PATH}/${encodeURIComponent(plugin.type)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) {
        toast.error((await failureMessage(res)) ?? t('settings.metadata.plugins.toggleFailed'))
        return
      }
      await fetchPlugins(true)
      await options.onChanged?.()
    } finally {
      togglingType.value = null
    }
  }

  function askRemove(plugin: MetadataProviderPluginInfo) {
    pendingRemoval.value = plugin
  }

  function cancelRemove() {
    if (removingType.value === null) pendingRemoval.value = null
  }

  async function confirmRemove() {
    const plugin = pendingRemoval.value
    if (!plugin) return
    removingType.value = plugin.type
    try {
      const res = await api(`${BASE_PATH}/${encodeURIComponent(plugin.type)}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error((await failureMessage(res)) ?? t('settings.metadata.plugins.removeFailed'))
        return
      }
      toast.success(t('settings.metadata.plugins.removed', { label: plugin.label }))
      pendingRemoval.value = null
      await fetchPlugins(true)
      await options.onChanged?.()
    } finally {
      removingType.value = null
    }
  }

  return {
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
  }
}
