// The host-side cluster administration behind the panel's cluster page.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ClusterAdmin } from '../src/app/cluster.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cluster-admin-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const toolPath = (): string => { mkdirSync(join(dir, 'tools'), { recursive: true }); writeFileSync(join(dir, 'tools', 'cluster.mjs'), ''); return join(dir, 'tools', 'cluster.mjs') }
const configPath = (instances: unknown[] = []): string => {
  const path = join(dir, 'superagent-cluster.json')
  writeFileSync(path, JSON.stringify({ version: 1, bundle: join(dir, 'bundle'), runtime: { node: process.execPath, dshBin: '/dsh/bin.js',
    pnpm: '/pnpm.mjs' }, defaults: {}, instances, external: [] }))
  return path
}
const instance = { name: 'widgets', profile: 'superagent-widgets', port: 3082, repository: 'acme/widgets', stateDir: '/srv/state/widgets',
  clone: '/srv/clones/widgets', enabled: true }
/** A child process stand-in that succeeds immediately, so operations never run the real tool. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 1
  setTimeout(() => child.emit('close', 0), 0)
  return child
}

it('says why the cluster is unavailable when the tool or the configuration is missing', async () => {
  const missingTool = new ClusterAdmin({ toolPath: join(dir, 'nope.mjs'), configPath: join(dir, 'none.json') })
  expect(await missingTool.view()).toMatchObject({ available: false, reason: 'clusterToolMissing' })
  const missingConfig = new ClusterAdmin({ toolPath: toolPath(), configPath: join(dir, 'none.json') })
  expect(await missingConfig.view()).toMatchObject({ available: false, reason: 'clusterConfigMissing' })
})

it('lists configured instances with their stored runtime state, and keeps probing failures on the row', async () => {
  const cluster = new ClusterAdmin({ toolPath: toolPath(), configPath: configPath([instance]) })
  mkdirSync(join(dir, 'superagent-cluster', 'instances'), { recursive: true })
  // A live pid (this process) makes the row running; the panel URL points at a closed port so the probe fails.
  writeFileSync(join(dir, 'superagent-cluster', 'instances', 'widgets.json'),
    JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1/?token=panel-token' }))
  const view = await cluster.view()
  expect(view.available).toBe(true)
  expect(view.instances).toHaveLength(1)
  const [row] = view.instances
  expect(row).toMatchObject({ name: 'widgets', repository: 'acme/widgets', running: true,
    panelUrl: 'http://127.0.0.1:1/?token=panel-token' })
  expect(row!.unreachable).toContain('没有响应')
})

it('reports a stopped instance without a panel URL', async () => {
  const cluster = new ClusterAdmin({ toolPath: toolPath(), configPath: configPath([instance]) })
  const view = await cluster.view()
  const [row] = view.instances
  expect(row).toMatchObject({ running: false })
  expect(row!.panelUrl).toBeUndefined()
  expect(view.operations).toEqual([])
})

it('refuses a malformed repository, a malformed instance name and an unknown instance', async () => {
  const cluster = new ClusterAdmin({ toolPath: toolPath(), configPath: configPath([instance]) })
  await expect(cluster.provision({ repository: 'widgets' })).rejects.toThrow(/owner\/name/)
  await expect(cluster.provision({ repository: 'acme/other', name: 'Bad Name' })).rejects.toThrow(/lowercase/)
  await expect(cluster.start('nope')).rejects.toThrow(/没有名为 nope/)
  await expect(cluster.stop('nope')).rejects.toThrow(/没有名为 nope/)
})

it('repairs an already configured repository instead of refusing it, and records the run', async () => {
  const calls: { command: unknown; args: string[] }[] = []
  const spawnProcess = ((command: unknown, args: string[]) => { calls.push({ command, args }); return fakeChild() }) as never
  const cluster = new ClusterAdmin({ toolPath: toolPath(), configPath: configPath([instance]), spawnProcess })
  const operation = await cluster.provision({ repository: 'acme/widgets' })
  expect(operation.action).toBe('repair')
  expect(calls[0]!.args.slice(1)).toEqual(['provision', '--name', 'widgets'])
  await new Promise(resolve => setTimeout(resolve, 10))
  expect((await cluster.view()).operations[0]).toMatchObject({ action: 'repair', ok: true })
})

it('starts and stops a known instance through the tool', async () => {
  const calls: string[][] = []
  const spawnProcess = ((_command: unknown, args: string[]) => { calls.push(args); return fakeChild() }) as never
  const cluster = new ClusterAdmin({ toolPath: toolPath(), configPath: configPath([instance]), spawnProcess })
  expect((await cluster.start('widgets')).action).toBe('start')
  expect((await cluster.stop('widgets')).action).toBe('stop')
  expect(calls.map(args => args.slice(1))).toEqual([['start', '--name', 'widgets'], ['stop', '--name', 'widgets']])
})
