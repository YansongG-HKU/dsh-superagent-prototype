import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, verifyEnvironment, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { prepareArgv } from '../src/executor/dsh.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

/** True on the Windows host these tests run on: no POSIX shell, tmux, or executable bits. */
const WINDOWS = process.platform === 'win32'
// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
/** Writes a POSIX shell script as a fake CLI, which only POSIX tests run. */
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
/** The file a `git config --show-origin` line names, normalized: Git quotes and escapes a Windows path, and drive letter case varies. */
const configFile = (line: string): string => {
  let path = (line.split('\t')[0] ?? '').replace(/^file:/, '')
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, '$1')
  return WINDOWS ? path.replaceAll('\\', '/').toLowerCase() : path
}
/** The value of a `git config --show-origin` line, after its origin file. */
const configValue = (line: string): string => line.split('\t').slice(1).join('\t')
/** Runs a command as a worker's shell does, resolving it through PATH and PATHEXT; resolves with its output even when it fails. */
const runCommand = async (name: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  try { return { code: 0, ...await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', name], { env, timeout: 10_000 }) } }
  catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(WINDOWS)('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe.skipIf(!WINDOWS)('worker shims on Windows', () => {
  /** A deployment whose gh CLI is an existing `.exe` file, as the Windows deployment's absolute `github.cli` is. */
  const deployment = () => {
    writeFileSync(join(dir, 'real', 'gh.exe'), '')
    return testDeployment({ stateDir: dir, feishu: undefined, github: { ...testDeployment().github, cli: join(dir, 'real', 'gh.exe') } })
  }
  it('shims a blocked command as a .cmd file PATHEXT resolves first, and writes no gh or lark-cli shim', async () => {
    await writeEnvironment(deployment(), ['personal-gh'])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['personal-gh.cmd'])
    expect(readFileSync(join(bin, 'personal-gh.cmd'), 'utf8')).toBe([
      '@echo off',
      'REM # Written by dsh-superagent on every start; edits are lost.',
      'echo personal-gh is blocked in this installation; use gh, which acts as agent-bot. 1>&2',
      'exit /b 1',
      '',
    ].join('\n'))
    // A worker's PATH finds the shim first, and running it fails with the message on stderr.
    const environment = { ...process.env, PATH: [bin, join(dir, 'real'), process.env.PATH ?? ''].join(delimiter) }
    const blocked = await runCommand('personal-gh', environment)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr.trim()).toBe('personal-gh is blocked in this installation; use gh, which acts as agent-bot.')
  })
  it('rewrites its own .cmd shims, removes the POSIX shims an earlier run wrote, and refuses foreign files', async () => {
    await writeEnvironment(deployment(), ['old-cli'])
    const bin = workerBin(dir)
    const marker = '# Written by dsh-superagent on every start; edits are lost.'
    // A run on POSIX wrote these before the state directory came to Windows; Windows does not need them.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${marker}\nexec '/opt/gh' "$@"\n`)
    writeFileSync(join(bin, 'lark-cli'), `#!/bin/sh\n${marker}\nexit 1\n`)
    await writeEnvironment(deployment(), ['new-cli'])
    expect(readdirSync(bin).sort()).toEqual(['new-cli.cmd'])
    // A file that merely contains the marker on a later line is foreign, and is left as it was.
    writeFileSync(join(bin, 'notes'), `notes\nmore\n${marker}\n`)
    await expect(writeEnvironment(deployment(), ['new-cli'])).rejects.toThrow(`${join(bin, 'notes')} was not written by dsh-superagent`)
    expect(readFileSync(join(bin, 'notes'), 'utf8')).toBe(`notes\nmore\n${marker}\n`)
    rmSync(join(bin, 'notes'))
    // So is a .cmd file without the marker in its first two lines.
    writeFileSync(join(bin, 'new-cli.cmd'), '@echo off\n')
    await expect(writeEnvironment(deployment(), ['new-cli'])).rejects.toThrow(`${join(bin, 'new-cli.cmd')} was not written by dsh-superagent`)
    expect(readFileSync(join(bin, 'new-cli.cmd'), 'utf8')).toBe('@echo off\n')
    rmSync(join(bin, 'new-cli.cmd'))
    // A foreign git configuration file is refused too.
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(deployment(), ['new-cli'])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
  })
  it('removes every spelling of the worker shim directory from a Windows PATH', () => {
    const bin = workerBin(dir)
    mkdirSync(bin, { recursive: true })
    const others = [join(dir, 'real'), join(dir, 'node_modules', '.bin')]
    expect(withoutDirectory([`${bin}\\`, bin, ...others].join(delimiter), bin)).toBe(others.join(delimiter))
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    // An agent CLI path with a space, which the credential helper must keep whole.
    const cli = WINDOWS ? join(dir, 'agent tools', 'gh.exe') : '/opt/agent tools/gh'
    if (WINDOWS) { mkdirSync(join(dir, 'agent tools')); writeFileSync(cli, '') }
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    const shown = await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')
    expect(configFile(shown)).toBe(configFile(`file:${workerGitConfig(dir)}`))
    expect(configValue(shown)).toBe(credentialHelper(cli))
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

describe.skipIf(!WINDOWS)('agent git configuration on Windows', () => {
  it('writes the Git-for-Windows credential helper and verifies it against the real git', async () => {
    const cli = join(dir, 'real', 'gh.exe')
    writeFileSync(cli, '')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } })
    await writeEnvironment(deployment, [])
    // The value Git for Windows runs through its bundled sh: `!"C:/.../gh.exe" auth git-credential`, quoted for git's config parser.
    const helper = `!"${cli.replaceAll('\\', '/')}" auth git-credential`
    const written = `"${helper.replace(/[\\"]/g, char => `\\${char}`)}"`
    const config = readFileSync(workerGitConfig(dir), 'utf8')
    expect(config).toContain(`[user]\n\tuseConfigOnly = true\n[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper = ${written}\n`)
    await expect(verifyEnvironment(deployment, subprocess(workerGitConfig(dir)), new AbortController().signal)).resolves.toBeUndefined()
    // The check refuses a helper value other than the one it wrote, as it refuses an old git.
    const other = testDeployment({ stateDir: dir, github: { ...deployment.github, cli: `${cli}.other` } })
    await expect(verifyEnvironment(other, subprocess(workerGitConfig(dir)), new AbortController().signal)).rejects.toMatchObject({ code: 'gitTooOld' })
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it.skipIf(WINDOWS)('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

it('runs a ticket prepare command in the shell of this platform', () => {
  expect(prepareArgv('git worktree add dir')).toEqual(WINDOWS
    ? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', 'git worktree add dir']
    : ['sh', '-c', 'git worktree add dir'])
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = [process.execPath, '-e', 'console.error("nope"); process.exit(3)']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
