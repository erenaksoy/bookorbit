import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetadataProviderPluginInfo } from '@bookorbit/types'

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  toastMock: { success: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() },
}))

vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('vue-sonner', () => ({ toast: toastMock }))

import ProviderPluginsPanel from './ProviderPluginsPanel.vue'

const PATH = '/api/v1/admin/metadata-provider-plugins'
let mounted: VueWrapper | null = null

const SAMPLE: MetadataProviderPluginInfo = {
  type: 'acme-books',
  key: 'plugin:acme-books',
  label: 'Acme Books',
  description: 'Books from the Acme catalogue',
  version: '1.2.0',
  mediaKinds: ['ebook'],
  enabled: false,
}

const INSPECTION = {
  type: 'acme-books',
  key: 'plugin:acme-books',
  label: 'Acme Books',
  version: '1.2.0',
  mediaKinds: ['ebook'],
  files: ['index.mjs', 'README.md'],
  source: 'export default { type: "acme-books" };\n',
  replaces: false,
}

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

/** Serves the list, and whatever else a test wants, keyed by "METHOD path". */
function serve(
  list: { plugins: MetadataProviderPluginInfo[]; failures?: Array<{ directory: string; reason: string }> },
  routes: Record<string, Response> = {},
) {
  apiMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    if (routes[key]) return Promise.resolve(routes[key])
    if (key === `GET ${PATH}`) return Promise.resolve(response({ plugins: list.plugins, failures: list.failures ?? [] }))
    return Promise.resolve(response({}, false))
  })
}

async function mountPanel(onChanged = vi.fn<() => void>()) {
  const wrapper = mount(ProviderPluginsPanel, { props: { onChanged }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  return { wrapper, onChanged }
}

function sheet(): HTMLElement {
  const el = document.body.querySelector('[role="dialog"]')
  if (el === null) throw new Error('no editor sheet is open')
  return el as HTMLElement
}

function nameOf(button: Element): string {
  return (button.textContent ?? '').trim() || (button.getAttribute('aria-label') ?? '')
}

async function chooseFile(wrapper: VueWrapper, name = 'acme-books.zip') {
  const input = wrapper.find<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [new File(['zip bytes'], name)], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

describe('ProviderPluginsPanel', () => {
  beforeEach(() => {
    apiMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })

  it('lists installed plugins with what each declares', async () => {
    serve({ plugins: [SAMPLE] })

    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('Acme Books')
    expect(wrapper.text()).toContain('v1.2.0')
    expect(wrapper.text()).toContain('plugin:acme-books')
    expect(wrapper.text()).toContain('Books from the Acme catalogue')
  })

  it('says so when nothing is installed', async () => {
    serve({ plugins: [] })

    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('No provider plugins are installed')
  })

  it('shows a plugin that failed to load, with the reason, so a typo is not a silent absence', async () => {
    serve({ plugins: [], failures: [{ directory: 'broken', reason: 'no index.mjs in that directory' }] })

    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('broken')
    expect(wrapper.text()).toContain('no index.mjs in that directory')
    expect(wrapper.text()).not.toContain('No provider plugins are installed')
  })

  it('reports when the list cannot be loaded', async () => {
    apiMock.mockResolvedValue(response({}, false))

    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('Could not load the installed plugins')
  })

  describe('switching', () => {
    it('sends the new state, then refreshes the list and tells the page above', async () => {
      serve({ plugins: [SAMPLE] }, { [`PUT ${PATH}/acme-books/enabled`]: response({}) })
      const { wrapper, onChanged } = await mountPanel()

      await wrapper.find('[role="switch"]').trigger('click')
      await flushPromises()

      const put = apiMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(put?.[0]).toBe(`${PATH}/acme-books/enabled`)
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({ enabled: true })
      expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it('shows the server reason and leaves the page above alone when the switch is refused', async () => {
      serve({ plugins: [SAMPLE] }, { [`PUT ${PATH}/acme-books/enabled`]: response({ message: 'Only a superuser can manage plugins' }, false) })
      const { wrapper, onChanged } = await mountPanel()

      await wrapper.find('[role="switch"]').trigger('click')
      await flushPromises()

      expect(toastMock.error).toHaveBeenCalledWith('Only a superuser can manage plugins')
      expect(onChanged).not.toHaveBeenCalled()
    })
  })

  describe('installing', () => {
    it('reads the file without installing it, and shows the source that would run', async () => {
      serve({ plugins: [] }, { [`POST ${PATH}/inspect`]: response(INSPECTION) })
      const { wrapper } = await mountPanel()

      await chooseFile(wrapper)

      const posted = apiMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)
      expect(posted).toEqual([`${PATH}/inspect`])
      expect(sheet().textContent).toContain('Acme Books')
      expect(sheet().textContent).toContain('index.mjs, README.md')
      expect(sheet().querySelector('code')?.textContent).toBe(INSPECTION.source)
    })

    it('warns what installing one actually means', async () => {
      serve({ plugins: [] }, { [`POST ${PATH}/inspect`]: response(INSPECTION) })
      const { wrapper } = await mountPanel()

      await chooseFile(wrapper)

      expect(sheet().textContent).toContain('full access')
    })

    it('says when the install would replace one already there', async () => {
      serve({ plugins: [SAMPLE] }, { [`POST ${PATH}/inspect`]: response({ ...INSPECTION, replaces: true }) })
      const { wrapper } = await mountPanel()

      await chooseFile(wrapper)

      expect(sheet().textContent).toContain('already installed')
    })

    it('sends the same file again to install, then refreshes and tells the page above', async () => {
      serve({ plugins: [] }, { [`POST ${PATH}/inspect`]: response(INSPECTION), [`POST ${PATH}`]: response({ ...INSPECTION, active: true }) })
      const { wrapper, onChanged } = await mountPanel()
      await chooseFile(wrapper)

      const install = [...sheet().querySelectorAll('button')].find((button) => nameOf(button).includes('Install and run'))
      install?.click()
      await flushPromises()

      const [inspect, installCall] = apiMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect((inspect![1]!.body as FormData).get('file')).toBeInstanceOf(File)
      expect((installCall![1]!.body as FormData).get('file')).toBe((inspect![1]!.body as FormData).get('file'))
      expect(toastMock.success).toHaveBeenCalledWith('Acme Books installed')
      expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it('installs nothing and opens no review when the file is refused', async () => {
      serve(
        { plugins: [] },
        { [`POST ${PATH}/inspect`]: response({ message: 'That upload is not a usable plugin: it exports no search function' }, false) },
      )
      const { wrapper } = await mountPanel()

      await chooseFile(wrapper)

      expect(() => sheet()).toThrow('no editor sheet is open')
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('no search function'))
    })

    it('offers only zip and mjs files', async () => {
      serve({ plugins: [] })
      const { wrapper } = await mountPanel()

      expect(wrapper.find('input[type="file"]').attributes('accept')).toBe('.zip,.mjs')
    })
  })

  describe('removing', () => {
    function removeButton(wrapper: VueWrapper) {
      return wrapper.findAll('button').find((button) => nameOf(button.element).includes('Remove Acme Books'))!
    }

    it('asks first, and deletes nothing until confirmed', async () => {
      serve({ plugins: [SAMPLE] })
      const { wrapper } = await mountPanel()

      await removeButton(wrapper).trigger('click')
      await flushPromises()

      expect(document.body.textContent).toContain('Remove Acme Books?')
      expect(apiMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    })

    it('deletes the plugin once confirmed, then refreshes and tells the page above', async () => {
      serve({ plugins: [SAMPLE] }, { [`DELETE ${PATH}/acme-books`]: response({}) })
      const { wrapper, onChanged } = await mountPanel()
      await removeButton(wrapper).trigger('click')
      await flushPromises()

      const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find((button) => nameOf(button).includes('Remove plugin'))
      ;(confirm as HTMLButtonElement).click()
      await flushPromises()

      expect(apiMock.mock.calls.some(([url, init]) => url === `${PATH}/acme-books` && init?.method === 'DELETE')).toBe(true)
      expect(toastMock.success).toHaveBeenCalledWith('Acme Books removed')
      expect(onChanged).toHaveBeenCalledTimes(1)
    })
  })
})
