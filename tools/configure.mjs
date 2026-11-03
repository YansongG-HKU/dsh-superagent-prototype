#!/usr/bin/env node
/**
 * Configure a running dsh-superagent instance through its management API.
 *
 *   node tools/configure.mjs --url http://127.0.0.1:54746 \
 *     --repo owner/name --cli "C:\path\to\gh.exe" \
 *     --agent-login agent-account --operator-login operator-account \
 *     --clone "C:\path\to\local-clone"
 *
 * Idempotent: it reads the current settings, then saves the GitHub Source, the Policy, the
 * Executor (PowerShell prepare command) and the Delivery requirements prompt text.
 * The management API requires loopback hostnames and the `x-orchestrator-request` header.
 */
import process from 'node:process'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = (opt('url', 'http://127.0.0.1:54746')).replace(/\/$/, '')
const repo = opt('repo', '')
const cli = opt('cli', '')
const agentLogin = opt('agent-login', '')
const operatorLogin = opt('operator-login', '')
const clone = opt('clone', '')
if (!repo || !cli || !agentLogin || !operatorLogin || !clone) {
  console.error('usage: node tools/configure.mjs --url <url> --repo owner/name --cli <gh.exe> --agent-login <login> --operator-login <login> --clone <path>')
  process.exit(2)
}

const headers = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const say = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

async function call(method, path, body) {
  const response = await fetch(`${base}/orchestrator/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = { raw: text } }
  return { status: response.status, value }
}

/** Retry while the plugin restarts; fail on a real refusal. */
async function callWhileStarting(what, method, path, body) {
  let last = ''
  for (let i = 0; i < 120; i++) {
    try {
      const result = await call(method, path, body)
      if (result.status === 200) return result.value
      last = `HTTP ${result.status} ${JSON.stringify(result.value)}`
      if (result.status === 400 || result.status === 409 || result.status === 403) throw new Error(`${what}: ${last}`)
    } catch (error) {
      if (error instanceof Error && !/fetch failed|ECONNREFUSED|other side closed|socket hang up|terminated/i.test(error.message)) throw error
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(1000)
  }
  throw new Error(`${what}: management API never answered (${last})`)
}

const delivery = [
  'For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.',
  'Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.',
  'After-only evidence is incomplete.',
  'Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.',
  'Refresh the comparison when later UI changes make it stale.',
  'If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.',
  'Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.',
  '',
  'Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.',
  'Never enable auto-merge, never approve a pull request and never merge a pull request, including one you opened yourself: a person merges every pull request, so say in your report that it awaits a person\'s merge.',
  '',
  'If a human is working on the same problem and their branch or pull request contains this ticket\'s code (commits from the ticket branch, or its changes carried over), close this ticket\'s PR with gh immediately without asking anyone, leaving one sentence on it that names the human\'s PR.',
  'Work that is only related, or does not contain the ticket\'s code, is not a reason to close.',
  'Closing the PR ends the ticket; send no other message.',
].join('\n')

const prepare = [
  '$ErrorActionPreference = \'Stop\'',
  `$repo = '${clone.replaceAll("'", "''")}'`,
  '$ref = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { \'HEAD\' }',
  '$remote = "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git"',
  'git -C $repo fetch --no-tags $remote "${ref}:refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"',
  'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  'git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"',
  'exit $LASTEXITCODE',
].join('\n')

async function main() {
  const settings = await callWhileStarting('settings', 'GET', 'settings')
  const source = settings.sources.find(item => item.id === 'github') ?? { value: { enabled: false, config: {} }, revision: 0 }
  const sourceValue = { enabled: true, config: { ...source.value.config, repository: repo, cli, observeIssues: true, observeComments: true } }
  say('source:github saved', await callWhileStarting('save source:github', 'PUT', 'settings/source:github', { value: sourceValue, revision: source.revision }))

  // Setup runs on the next pass; the plugin restarts when the repository or CLI changes.
  const state = await callWhileStarting('state', 'GET', 'state')
  say('setup problem', state.setup?.problem?.detail ?? null)
  say('resolved accounts', state.setup?.accounts ?? null)
  if (state.setup?.accounts?.agent && state.setup.accounts.agent !== agentLogin) {
    throw new Error(`setup resolved agent ${state.setup.accounts.agent}, expected ${agentLogin}; check the agent CLI, GH_CONFIG_DIR and the token scopes.`)
  }

  const policySettings = await callWhileStarting('settings', 'GET', 'settings')
  const policy = policySettings.blocks.policy
  const sources = { ...(policy.value.sources ?? {}) }
  sources.github = { ...(sources.github ?? {}), allowed: [{ id: operatorLogin }] }
  say('policy saved', await callWhileStarting('save policy', 'PUT', 'settings/policy', { value: { ...policy.value, sources }, revision: policy.revision }))

  const executorSettings = await callWhileStarting('settings', 'GET', 'settings')
  const executor = executorSettings.blocks.executor
  say('executor saved', await callWhileStarting('save executor', 'PUT', 'settings/executor', { value: { ...executor.value, prepare }, revision: executor.revision }))

  const prompts = await callWhileStarting('prompts', 'GET', 'prompts')
  say('prompts saved', await callWhileStarting('save prompts', 'PUT', 'prompts', { config: { ...prompts.current.config, delivery }, baseRevision: prompts.current.revision }))

  const final = await callWhileStarting('state', 'GET', 'state')
  say('final setup problem', final.setup?.problem?.detail ?? null)
  say('final accounts', final.setup?.accounts ?? null)
  say('health', Object.fromEntries(Object.entries(final.health).map(([name, entry]) => [name, entry.state])))
}

main().then(() => process.exit(0)).catch(error => { console.error(`FAILED: ${error.message}`); process.exit(1) })
