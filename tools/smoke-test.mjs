#!/usr/bin/env node
/**
 * End-to-end smoke test for a running dsh-superagent instance.
 *
 *   node tools/smoke-test.mjs --url http://127.0.0.1:54746 \
 *     --repo owner/name --agent-login agent-account --operator-login operator-account
 *
 * The operator's `gh` session is used to open the issue and read the pull requests. If the
 * operator's gh configuration is not the default one, pass --operator-gh-dir.
 * Flow: open an Issue that mentions the agent, then poll the management API until a ticket
 * reaches a person stage or ends, printing pull requests along the way.
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const url = (opt('url', 'http://127.0.0.1:54746')).replace(/\/$/, '')
const repo = opt('repo', '')
const agentLogin = opt('agent-login', '')
const operatorLogin = opt('operator-login', '')
const operatorGhDir = opt('operator-gh-dir', join(process.env.APPDATA ?? '', 'GitHub CLI'))
const timeoutSeconds = Number(opt('timeout-seconds', '1200'))
if (!repo || !agentLogin || !operatorLogin) {
  console.error('usage: node tools/smoke-test.mjs --url <url> --repo owner/name --agent-login <login> --operator-login <login> [--operator-gh-dir <dir>]')
  process.exit(2)
}

const gh = (ghArgs, input) => execFileSync('gh', ghArgs, {
  encoding: 'utf8', input,
  env: { ...process.env, GH_CONFIG_DIR: operatorGhDir, GH_PROMPT_DISABLED: '1', GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined },
}).trim()
const headers = { 'x-orchestrator-request': '1' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const api = async path => {
  const response = await fetch(`${url}/orchestrator/api/${path}`, { headers })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`GET ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function createIssue() {
  const who = gh(['api', 'user', '--jq', '.login'])
  if (who !== operatorLogin) throw new Error(`gh acts as ${who}, expected the operator ${operatorLogin}; pass --operator-gh-dir.`)
  const body = [
    `@${agentLogin} please add a section to README.md titled "Hello from dsh-superagent" with one short sentence below it, then open a pull request for it.`,
    '',
    'This issue is the end-to-end smoke test of the dsh-superagent prototype. Keep the change to README.md only.',
  ].join('\n')
  const issueUrl = gh(['issue', 'create', '--repo', repo, '--title', 'dsh-superagent smoke test: add a HELLO section to the README', '--body-file', '-'], body)
  console.log(`issue created: ${issueUrl}`)
  return Number(issueUrl.split('/').pop())
}

function pullRequests() {
  try {
    const out = gh(['pr', 'list', '--repo', repo, '--state', 'all', '--json', 'number,title,headRefName,isDraft,state,url', '--limit', '10'])
    return JSON.parse(out || '[]')
  } catch { return [] }
}

async function poll(number) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let last = ''
  while (Date.now() < deadline) {
    let tickets
    try { tickets = await api('tickets?state=open&limit=20') } catch { await sleep(3000); continue }
    const open = tickets.items ?? []
    const match = open.find(ticket => String(ticket.note?.text ?? '').includes(`#${number}`)) ?? open.find(ticket => /HELLO/i.test(ticket.title ?? ''))
    const line = `open tickets: ${open.length}${match ? ` | ticket ${match.id.slice(0, 12)} ${match.stage}/${match.action ?? ''}` : ''}`
    if (line !== last) { console.log(`[${new Date().toLocaleTimeString()}] ${line}`); last = line }
    const prs = pullRequests()
    if (prs.length) console.log(`  PRs: ${prs.map(pr => `#${pr.number} ${pr.state}${pr.isDraft ? ' draft' : ''} ${pr.headRefName}`).join(' | ')}`.slice(0, 800))
    if (match) {
      const detail = await api(`tickets/${match.id}`).catch(() => undefined)
      if (detail) {
        const reports = (detail.assignments ?? []).flatMap(assignment => assignment.report ? [{ ...assignment.report, assignment: assignment.id }] : [])
        const lastReport = reports.at(-1)
        console.log(`  ticket ${match.id} ${detail.stage}/${detail.action ?? ''} assignments=${(detail.assignments ?? []).length} reports=${reports.length}${lastReport ? ` last=${lastReport.state}: ${String(lastReport.summary ?? '').slice(0, 180).replaceAll('\n', ' ')}` : ''}`)
        const settled = detail.state === 'ended' || reports.some(report => ['ready', 'blocked', 'failed', 'dropped'].includes(report.state))
        if (settled) {
          console.log('SETTLED')
          console.log(JSON.stringify({ ticket: match.id, stage: detail.stage, ended: detail.ended, lastReport, prs }, null, 2).slice(0, 4000))
          return
        }
      }
    }
    await sleep(5000)
  }
  throw new Error('timed out waiting for the ticket to settle')
}

const number = await createIssue()
console.log(`watching issue #${number}`)
await poll(number)
