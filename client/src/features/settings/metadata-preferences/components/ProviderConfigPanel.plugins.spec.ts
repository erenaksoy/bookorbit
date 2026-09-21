import { mount } from '@vue/test-utils'
import type { ProviderConfigurations } from '@bookorbit/types'
import { describe, expect, it } from 'vitest'

import { withoutPluginProviders } from '../lib/provider-rows'
import ProviderConfigPanel from './ProviderConfigPanel.vue'

const CONFIG = {
  google: { enabled: false, apiKey: '' },
  amazon: { enabled: false, domain: 'amazon.com', cookie: '' },
  goodreads: { enabled: false },
  'plugin:acme-books': { enabled: true },
} as unknown as ProviderConfigurations

describe('withoutPluginProviders', () => {
  it('keeps every built-in slot and drops every plugin switch', () => {
    expect(withoutPluginProviders(CONFIG)).toEqual({
      google: { enabled: false, apiKey: '' },
      amazon: { enabled: false, domain: 'amazon.com', cookie: '' },
      goodreads: { enabled: false },
    })
  })
})

describe('ProviderConfigPanel with plugin providers in the config', () => {
  it('does not submit a plugin switch, because the server refuses keys it does not know', async () => {
    const wrapper = mount(ProviderConfigPanel, { props: { config: CONFIG, statuses: [], saving: false } })

    await wrapper.find('form').trigger('submit')

    const saved = wrapper.emitted('save')?.[0]?.[0] as Record<string, unknown>
    expect(saved).toBeDefined()
    expect(Object.keys(saved).some((key) => key.startsWith('plugin:'))).toBe(false)
    wrapper.unmount()
  })

  it('does not list a plugin among the built-in sources', () => {
    const wrapper = mount(ProviderConfigPanel, { props: { config: CONFIG, statuses: [], saving: false } })

    expect(wrapper.text()).not.toContain('plugin:acme-books')
    wrapper.unmount()
  })
})
