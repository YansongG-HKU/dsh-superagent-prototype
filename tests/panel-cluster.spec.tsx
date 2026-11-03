// @vitest-environment jsdom
// The cluster page: the repository instances, their panel links and controls, and the add form.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, field, tab, click, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const anchors = (): HTMLAnchorElement[] => [...document.querySelectorAll<HTMLAnchorElement>('a')]
it('lists the repository instances with their status and opens a running instance panel', async () => {
  await mount()
  await click(tab(zh['tab.cluster']))
  expect(all('.dt-section-title').map(title => title.textContent)).toContain('仓库实例2')
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain('acme/gadgets')
  // A running instance offers its panel (with the token) and a Stop action; a stopped one offers Start.
  expect(anchors().some(anchor => anchor.href.includes('3082/?token=panel-token'))).toBe(true)
  expect(text()).toContain(zh.clusterStop)
  expect(text()).toContain(zh.clusterStart)
  expect(text()).toContain(zh['clusterStateStopped'])
})

it('starts a stopped instance from its row', async () => {
  await mount()
  await click(tab(zh['tab.cluster']))
  await click(zh.clusterStart)
  await settle()
  expect(server.requests.some(request => request.path === 'cluster/instances/gadgets/start' && request.method === 'POST')).toBe(true)
  expect(server.cluster.instances.find(instance => instance.name === 'gadgets')?.running).toBe(true)
})

it('adds a repository through the form', async () => {
  await mount()
  await click(tab(zh['tab.cluster']))
  await type(field<HTMLInputElement>(zh.clusterRepository), 'acme/new-repo')
  await click(zh.clusterAddAction)
  await settle()
  expect(server.requests.some(request => request.path === 'cluster/instances' && request.method === 'POST'
    && JSON.stringify(request.body) === JSON.stringify({ repository: 'acme/new-repo' }))).toBe(true)
  expect(all('.dt-section-title').map(title => title.textContent)).toContain('最近操作1')
})

it('explains an unavailable cluster instead of showing controls', async () => {
  server.cluster = { ...server.cluster, available: false, reason: 'clusterConfigMissing' }
  await mount()
  await click(tab(zh['tab.cluster']))
  expect(text()).toContain(zh['clusterReason.clusterConfigMissing'])
  expect(text()).toContain(server.cluster.configPath)
  expect(all('.dt-section-title').map(title => title.textContent)).not.toContain('仓库实例0')
})
