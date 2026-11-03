/**
 * Unit tests for the exported helpers of tools/cluster.mjs.
 * The command surface itself starts real DSH profiles and is exercised by hand against a
 * playground repository; these helpers cover the config/template/path logic deterministically.
 */
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanEnv, deriveInstance, expandPath, findWebUrl, nextPort, normalizeRepository, originOf, prepareCommand,
  renderProfilePatch, renderTemplate } from '../tools/cluster.mjs'

describe('cluster profile template', () => {
  const template = ['- id: webserver', '  config:', '    port: {{port}}', '- id: dsh-superagent', '  config:',
    "    stateDir: '{{stateDir}}'", '- id: deepseek-account', '  config:', '    desktopPlatform: {{desktopPlatform}}'].join('\n')

  it('renders every placeholder and refuses an unknown one', () => {
    const rendered = renderProfilePatch(template, { port: 3082, stateDir: 'C:\\dsh\\state\\one', platform: 'win32' })
    expect(rendered).toContain('port: 3082')
    expect(rendered).toContain("stateDir: 'C:/dsh/state/one'")
    expect(rendered).toContain('desktopPlatform: win32')
    expect(rendered).not.toContain('{{')
    expect(() => renderTemplate('- {{missing}}', {})).toThrow(/missing/)
    expect(() => renderTemplate('- {{unknown}}', { port: 1 })).toThrow(/unknown/)
  })

  it('uses darwin for macOS and win32 elsewhere', () => {
    expect(renderProfilePatch(template, { port: 1, stateDir: '/srv/dsh', platform: 'darwin' })).toContain('desktopPlatform: darwin')
    expect(renderProfilePatch(template, { port: 1, stateDir: '/srv/dsh', platform: 'linux' })).toContain('desktopPlatform: win32')
  })
})

describe('cluster instances', () => {
  it('validates repositories and derives unique names and profiles', () => {
    expect(normalizeRepository('acme/widgets')).toBe('acme/widgets')
    expect(() => normalizeRepository('widgets')).toThrow(/owner\/name/)
    expect(() => normalizeRepository('acme/widgets/extra')).toThrow(/owner\/name/)
    expect(deriveInstance('acme/widgets')).toEqual({ name: 'widgets', profile: 'superagent-widgets' })
    expect(deriveInstance('acme/My_Repo-2')).toEqual({ name: 'my-repo-2', profile: 'superagent-my-repo-2' })
    expect(deriveInstance('acme/widgets', [{ name: 'widgets' }])).toEqual({ name: 'widgets-2', profile: 'superagent-widgets-2' })
  })

  it('picks the next port above the base, skipping declared ports', () => {
    expect(nextPort(3082)).toBe(3082)
    expect(nextPort(3082, [{ port: 3082 }, { port: 3083 }])).toBe(3084)
    expect(nextPort(3082, [{ port: 3090 }])).toBe(3082)
    // A missing or non-positive base falls back to the default port.
    expect(nextPort(0)).toBe(3082)
  })
})

describe('cluster process helpers', () => {
  it('renders a PowerShell prepare command with a quoted clone path', () => {
    const command = prepareCommand("C:\\it's a clone\\repo")
    expect(command).toContain("$repo = 'C:\\it''s a clone\\repo'")
    expect(command).toContain('git -C $repo fetch --no-tags $remote')
    expect(command).toContain('git -C $repo worktree add -b')
    expect(command).toContain('$env:DSH_SUPERAGENT_TICKET')
  })

  it('finds the Web UI URL the DSH Web app prints', () => {
    const log = ['starting', 'dsh web: http://127.0.0.1:3082/?token=abc', 'noise'].join('\n')
    expect(findWebUrl(log)).toBe('http://127.0.0.1:3082/?token=abc')
    expect(findWebUrl('nothing here')).toBeUndefined()
    expect(originOf('http://127.0.0.1:3082/?token=abc')).toBe('http://127.0.0.1:3082')
    expect(originOf('not a url')).toBeUndefined()
  })

  it('expands ~ and resolves relative paths', () => {
    expect(expandPath('~/state')).toMatch(/state$/)
    const base = tmpdir()
    expect(expandPath('state', base)).toBe(resolve(base, 'state'))
    expect(expandPath('~/state')).toBe(join(homedir(), 'state'))
  })

  it('strips the variables a running instance injects into its host process', () => {
    const env = cleanEnv({
      PATH: ['/usr/bin', '/state/superagent/worker-bin', '/bin'].join(process.platform === 'win32' ? ';' : ':'),
      GH_CONFIG_DIR: '/state/superagent/gh-agent',
      GIT_CONFIG_GLOBAL: '/state/superagent/worker-gitconfig',
      GH_TOKEN: 'secret',
      HOME: '/home/user',
    })
    expect(env.GH_CONFIG_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.HOME).toBe('/home/user')
    expect(env.PATH).not.toContain('worker-bin')
    expect(env.PATH).toContain('/usr/bin')
  })
})
