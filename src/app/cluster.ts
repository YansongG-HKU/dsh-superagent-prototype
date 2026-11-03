/**
 * Multi-repository cluster administration for the management panel.
 *
 * The prototype serves one repository per instance, so several repositories are several isolated
 * deployments. The cluster tool (`tools/cluster.mjs`) owns their declarative configuration; this module
 * reads that configuration, probes each instance's management API for the panel, and runs the same tool
 * (add/setup/start/configure, start, stop) as background operations so a page can show their progress.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Milliseconds one instance's management API may take to answer a panel probe. */
const PROBE_TIMEOUT_MS = 2500
/** Kept output lines per operation, and operations kept in the view. */
const MAX_OUTPUT_LINES = 160
const MAX_OPERATIONS = 20
/** GitHub repository and instance names the cluster tool accepts. */
export const CLUSTER_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]*$/

/** The subset of `tools/cluster.mjs`'s configuration the panel reads. */
export interface ClusterConfig {
  version?: number
  bundle?: string
  runtime?: { node?: string; dshBin?: string; pnpm?: string; profileTemplate?: string }
  defaults?: Record<string, unknown>
  instances?: ClusterInstanceConfig[]
  external?: { name: string; url: string; repository?: string }[]
}
export interface ClusterInstanceConfig {
  name: string
  profile: string
  port: number
  repository: string
  stateDir: string
  clone?: string
  agentLogin?: string
  agentCli?: string
  enabled?: boolean
  prepare?: string
}
export interface ClusterLoad { running: number; queued: number; maxWorkers: number }
/** One repository instance as the panel shows it. */
export interface ClusterInstanceView extends ClusterInstanceConfig {
  running: boolean
  /** The instance's panel URL, including its access token, when it is running. */
  panelUrl?: string
  /** The setup problem the instance reports, if any. */
  setupProblem?: string
  /** Health entries the instance reports in error. */
  healthErrors?: string[]
  load?: ClusterLoad
  /** Tickets waiting for a person, from the instance's overview. */
  waitingTickets?: number
  /** Why the instance's management API did not answer. */
  unreachable?: string
}
/** A hosted instance the panel only reads (for example the DSH Desktop app). */
export interface ClusterExternalView {
  name: string
  url: string
  repository?: string
  setupProblem?: string
  healthErrors?: string[]
  load?: ClusterLoad
  unreachable?: string
}
/** One cluster tool run started from the panel. */
export interface ClusterOperationView {
  id: string
  action: 'add' | 'start' | 'stop' | 'repair'
  name?: string
  repository?: string
  startedAt: string
  finishedAt?: string
  ok?: boolean
  /** The operation's output, oldest first, bounded. */
  output: string[]
  error?: string
}
/** Everything the cluster page shows for one poll. */
export interface ClusterView {
  available: boolean
  reason?: string
  tool: string
  configPath: string
  bundle?: string
  instances: ClusterInstanceView[]
  external: ClusterExternalView[]
  operations: ClusterOperationView[]
  updatedAt: string
}
interface Operation extends ClusterOperationView { child?: ChildProcess }

interface Probe { setupProblem?: string; healthErrors?: string[]; load?: ClusterLoad; waitingTickets?: number; unreachable?: string }
const timeout = (): AbortSignal => AbortSignal.timeout(PROBE_TIMEOUT_MS)
const headers = { 'x-orchestrator-request': '1' }

/**
 * Reads the cluster configuration and runtime state, probes each instance for the panel, and runs the
 * cluster tool for add/start/stop requests. Operations are bounded in number and output, and one pending
 * operation per action and target is allowed so a double click cannot start two tools.
 */
export class ClusterAdmin {
  private readonly operations = new Map<string, Operation>()
  private readonly order: string[] = []
  private sequence = 0
  constructor(private readonly options: { toolPath: string; configPath: string; fetch?: typeof fetch
    /** Spawn seam for tests; defaults to `node:child_process`'s `spawn`. */
    spawnProcess?: typeof spawn }) {}

  /** The configuration as stored, or undefined when the file is missing or unreadable. */
  private config(): ClusterConfig | undefined {
    try { return JSON.parse(readFileSync(this.options.configPath, 'utf8')) as ClusterConfig }
    catch { return undefined }
  }
  private get fetchImpl(): typeof fetch { return this.options.fetch ?? fetch }
  /** Where the cluster tool keeps its per-instance runtime state and logs. */
  private workDir(): string { return join(join(this.options.configPath, '..'), 'superagent-cluster') }
  private stateOf(name: string): { pid?: number; url?: string } | undefined {
    try { return JSON.parse(readFileSync(join(this.workDir(), 'instances', `${name}.json`), 'utf8')) as { pid?: number; url?: string } }
    catch { return undefined }
  }
  private alive(pid: number | undefined): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /** Reads one instance's management API; never throws, and says why it could not answer. */
  private async probe(origin: string): Promise<Probe> {
    const get = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const response = await this.fetchImpl(`${origin}/orchestrator/api/${path}`, { headers, signal: timeout() })
        if (!response.ok) return undefined
        return await response.json() as Record<string, unknown>
      } catch { return undefined }
    }
    const state = await get('state')
    if (!state) return { unreachable: `没有响应：${origin}` }
    const setup = state.setup as { problem?: { detail?: string } } | undefined
    const health = (state.health ?? {}) as Record<string, { state?: string }>
    const load = state.load as ClusterLoad | undefined
    const overview = await get('overview').catch(() => undefined)
    const person = overview ? (overview.person as unknown[] | undefined) : undefined
    return {
      ...setup?.problem?.detail ? { setupProblem: setup.problem.detail } : {},
      healthErrors: Object.entries(health).filter(([, entry]) => entry?.state === 'error').map(([name]) => name),
      ...load ? { load } : {},
      ...Array.isArray(person) ? { waitingTickets: person.length } : {},
    }
  }

  /** Everything the cluster page shows: availability, instances, external hosts and recent operations. */
  async view(): Promise<ClusterView> {
    const empty: ClusterView = { available: false, tool: this.options.toolPath, configPath: this.options.configPath,
      instances: [], external: [], operations: this.listOperations(), updatedAt: new Date().toISOString() }
    if (!existsSync(this.options.toolPath)) return { ...empty, reason: 'clusterToolMissing' }
    const config = this.config()
    if (!config) return { ...empty, reason: 'clusterConfigMissing' }
    const instances = await Promise.all((config.instances ?? []).filter(instance => instance.enabled !== false).map(async instance => {
      const state = this.stateOf(instance.name)
      const running = this.alive(state?.pid)
      if (!running) return { ...instance, running } as ClusterInstanceView
      const origin = state?.url ? new URL(state.url).origin : `http://127.0.0.1:${instance.port}`
      return { ...instance, running, ...state?.url ? { panelUrl: state.url } : {}, ...await this.probe(origin) } as ClusterInstanceView
    }))
    const external = await Promise.all((config.external ?? []).map(async entry => {
      const origin = (() => { try { return new URL(entry.url).origin } catch { return entry.url } })()
      return { ...entry, ...await this.probe(origin) } as ClusterExternalView
    }))
    return { available: true, tool: this.options.toolPath, configPath: this.options.configPath, ...config.bundle ? { bundle: config.bundle } : {},
      instances, external, operations: this.listOperations(), updatedAt: new Date().toISOString() }
  }

  /** Adds a repository and brings its instance up; adding a repository that is already configured repairs that instance. */
  async provision(input: { repository: string; name?: string }): Promise<ClusterOperationView> {
    const config = this.requireConfig()
    if (!CLUSTER_REPOSITORY.test(input.repository)) throw new Error('repository must be owner/name')
    if (input.name !== undefined && !CLUSTER_NAME.test(input.name)) throw new Error('name must be lowercase letters, digits and dashes')
    const existing = (config.instances ?? []).find(instance => instance.repository === input.repository)
    if (existing) {
      // A previous add can stop halfway (profile, clone or network); run its idempotent provision again instead of refusing.
      this.requireIdle('repair', existing.name)
      return this.run('repair', ['provision', '--name', existing.name], { name: existing.name, repository: existing.repository })
    }
    if (this.listOperations().some(operation => operation.action === 'add' && operation.finishedAt === undefined)) {
      throw new Error('已有添加仓库的操作在进行')
    }
    const args = ['add', '--repo', input.repository, '--provision', ...input.name ? ['--name', input.name] : []]
    return this.run('add', args, { ...input.name ? { name: input.name } : {}, repository: input.repository })
  }

  /** Starts one stopped instance. */
  async start(name: string): Promise<ClusterOperationView> {
    this.requireInstance(name)
    this.requireIdle('start', name)
    return this.run('start', ['start', '--name', name], { name })
  }

  /** Stops one running instance and clears its state lock (the tool does both). */
  async stop(name: string): Promise<ClusterOperationView> {
    this.requireInstance(name)
    this.requireIdle('stop', name)
    return this.run('stop', ['stop', '--name', name], { name })
  }

  private requireConfig(): ClusterConfig {
    const config = this.config()
    if (!config) throw new Error('集群配置不存在；先运行 tools/cluster.mjs init')
    if (!config.runtime?.node) throw new Error('集群配置缺少 runtime.node')
    return config
  }
  private requireInstance(name: string): ClusterInstanceConfig {
    const config = this.requireConfig()
    const instance = (config.instances ?? []).find(item => item.name === name)
    if (!instance) throw new Error(`没有名为 ${name} 的实例`)
    return instance
  }
  private requireIdle(action: 'start' | 'stop' | 'repair', name: string): void {
    if (this.listOperations().some(operation => operation.action === action && operation.name === name && operation.finishedAt === undefined)) {
      throw new Error('这个实例已有同类操作在进行')
    }
  }

  private async run(action: ClusterOperationView['action'], args: string[],
    info: { name?: string; repository?: string }): Promise<ClusterOperationView> {
    const config = this.requireConfig()
    const operation: Operation = { id: `op-${++this.sequence}-${Date.now().toString(36)}`, action, ...info,
      startedAt: new Date().toISOString(), output: [] }
    const child = (this.options.spawnProcess ?? spawn)(config.runtime!.node!, [this.options.toolPath, ...args], {
      cwd: join(this.options.toolPath, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const append = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        operation.output.push(line.trim())
        if (operation.output.length > MAX_OUTPUT_LINES) operation.output.splice(0, operation.output.length - MAX_OUTPUT_LINES)
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', error => {
      operation.finishedAt ??= new Date().toISOString()
      operation.ok = false
      operation.error = String(error)
    })
    child.on('close', code => {
      operation.finishedAt ??= new Date().toISOString()
      operation.ok ??= code === 0
      if (!operation.ok) operation.error ??= operation.output.at(-1) ?? `工具退出码 ${code}`
      this.reap()
    })
    operation.child = child
    this.operations.set(operation.id, operation)
    this.order.push(operation.id)
    this.reap()
    return this.publicOperation(operation)
  }

  private listOperations(): ClusterOperationView[] {
    return this.order.map(id => this.operations.get(id)).filter((operation): operation is Operation => operation !== undefined)
      .reverse().map(operation => this.publicOperation(operation))
  }
  private publicOperation(operation: Operation): ClusterOperationView {
    const { child: _child, ...view } = operation
    void _child
    return { ...view, output: [...view.output] }
  }
  /** Drops the oldest finished operations once more than MAX_OPERATIONS are kept; running ones stay. */
  private reap(): void {
    while (this.order.length > MAX_OPERATIONS) {
      const id = this.order.find(candidate => this.operations.get(candidate)?.finishedAt !== undefined)
      if (!id) return
      this.order.splice(this.order.indexOf(id), 1)
      this.operations.delete(id)
    }
  }
}
