/** Cluster (multi-repository) page: the fleet of repository instances, adding a repository, and starting or stopping one. */
import { useState, type FormEvent } from 'react'
import type { ClusterInstanceView, ClusterOperationView } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Dot, Icon, Input, Tag, type DotState } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import type { T } from './text.ts'
import { ActionLink, Hint, LabelValue, LoadState, PageHead, Section, When } from './widgets.tsx'

/** The dot and state words for one instance: running and healthy, running but needing attention, starting, unavailable or stopped. */
function instanceMark(instance: ClusterInstanceView, t: T): { dot: DotState; label: string } {
  if (!instance.running) return { dot: 'idle', label: t('clusterStateStopped') }
  if (instance.unreachable) return { dot: 'warning', label: t('clusterStateStarting') }
  if (instance.setupProblem) return { dot: 'warning', label: t('clusterStateSetup') }
  if (instance.healthErrors?.length) return { dot: 'error', label: t('clusterStateError') }
  return { dot: 'done', label: t('clusterStateReady') }
}
/** The last lines of an operation, newest last, so the running step of an add is visible in the list. */
function operationTail(operation: ClusterOperationView): string {
  return operation.output.slice(-2).join('\n')
}

function InstanceRow({ instance, busy, onStart, onStop }: { instance: ClusterInstanceView; busy: boolean
  onStart: () => void; onStop: () => void }) {
  const { t } = usePanel()
  const mark = instanceMark(instance, t)
  return <li className="dt-row">
    <Dot state={mark.dot} label={mark.label} />
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-row-name">{instance.name}</span>
        <span className="dt-status-text" data-state={mark.dot}>{mark.label}</span>
      </div>
      <div className="dt-row-meta">
        <span className="dt-mono">{instance.repository}</span>
        <LabelValue label={t('clusterPort')} value={instance.port} />
        {instance.load && <LabelValue label={t('clusterExecutor')} value={`${instance.load.running}/${instance.load.maxWorkers}`} />}
        {instance.waitingTickets !== undefined && instance.waitingTickets > 0
          && <LabelValue label={t('clusterWaiting')} value={instance.waitingTickets} />}
      </div>
      {instance.setupProblem && <p className="dt-error" role="status">{instance.setupProblem}</p>}
      {instance.unreachable && <p className="dt-hint">{instance.unreachable}</p>}
      <div className="dt-actions">
        {instance.panelUrl && <ActionLink href={instance.panelUrl}>{t('clusterOpenPanel')}</ActionLink>}
        {instance.running
          ? <Button variant="outline" size="sm" disabled={busy} onClick={onStop}>{t('clusterStop')}</Button>
          : <Button variant="primary" size="sm" disabled={busy} onClick={onStart}>{t('clusterStart')}</Button>}
        <span className="dt-hint">{instance.profile}</span>
      </div>
    </div>
  </li>
}

function OperationRow({ operation }: { operation: ClusterOperationView }) {
  const { t } = usePanel()
  const running = operation.finishedAt === undefined
  const dot: DotState = running ? 'ongoing' : operation.ok ? 'done' : 'error'
  const label = running ? t('clusterOperationRunning') : operation.ok ? t('clusterOperationDone') : t('clusterOperationFailed')
  const target = operation.repository ?? operation.name ?? ''
  const tail = operationTail(operation)
  return <li className="dt-row">
    <Dot state={dot} label={label} />
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-row-name">{t(`clusterAction.${operation.action}` as 'clusterAction.add')} {target}</span>
        <span className="dt-status-text" data-state={dot}>{label}</span>
      </div>
      <div className="dt-row-meta"><When at={operation.finishedAt ?? operation.startedAt} />
        {operation.error && <span className="dt-error-text">{operation.error}</span>}</div>
      {tail && <pre className="dt-pre">{tail}</pre>}
    </div>
  </li>
}

/** The cluster page: availability, the instances with their panel links and controls, the add form, and recent operations. */
export function ClusterPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET cluster'), [], 3000)
  const [repository, setRepository] = useState('')
  const [name, setName] = useState('')
  const control = useAction(async (action: 'start' | 'stop', target: string) => {
    if (action === 'start') await call('POST cluster/instances/:name/start', { name: target })
    else await call('POST cluster/instances/:name/stop', { name: target })
  }, { reload })
  const add = useAction(async () => {
    const value = repository.trim()
    if (!value) throw new Error(t('clusterAddEmpty'))
    await call('POST cluster/instances', { body: { repository: value, ...name.trim() ? { name: name.trim() } : {} } })
    setRepository('')
    setName('')
  }, { reload })
  const submit = (event: FormEvent) => { event.preventDefault(); void add.run() }
  if (!data) return <LoadState loading={!error} error={error} />
  if (!data.available) {
    return <div className="dt-form">
      <PageHead title={t('clusterTitle')} />
      <Hint>{t('clusterUnavailable')}</Hint>
      <p className="dt-error">{t(`clusterReason.${data.reason ?? 'clusterConfigMissing'}` as 'clusterReason.clusterConfigMissing')}</p>
      <p className="dt-hint">{t('clusterConfigPath')} <code className="dt-code">{data.configPath}</code></p>
      <Hint>{t('clusterUnavailableHint')}</Hint>
    </div>
  }
  const busy = control.busy || add.busy
  const running = data.operations.some(operation => operation.finishedAt === undefined)
  return <div className="dt-form">
    <PageHead title={t('clusterTitle')}>
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={running} onClick={() => { void reload() }}>
        {t('clusterRefresh')}
      </Button>
    </PageHead>
    <Hint>{t('clusterIntro')}</Hint>
    <Hint>{t('clusterConfigPath')} <code className="dt-code">{data.configPath}</code>{data.bundle && <> · <code className="dt-code">{data.bundle}</code></>}</Hint>

    <Section title={t('clusterInstances')} count={data.instances.length} icon="queue">
      {data.instances.length === 0 ? <Hint>{t('clusterNoInstances')}</Hint>
        : <ul className="dt-list">{data.instances.map(instance => <InstanceRow key={instance.name} instance={instance} busy={busy}
          onStart={() => { void control.run('start', instance.name) }} onStop={() => { void control.run('stop', instance.name) }} />)}</ul>}
    </Section>

    {data.external.length > 0 && <Section title={t('clusterExternal')} count={data.external.length} icon="session">
      <ul className="dt-list">{data.external.map(entry => <li key={entry.name} className="dt-row">
        <Dot state={entry.unreachable ? 'warning' : entry.setupProblem || entry.healthErrors?.length ? 'warning' : 'done'}
          label={t('clusterStateExternal')} />
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-row-name">{entry.name}</span>
            <Tag tone="neutral">{t('clusterExternalTag')}</Tag><span className="dt-status-text" data-state="done">
              {entry.unreachable ? t('clusterStateStarting') : t('clusterStateReady')}</span></div>
          <div className="dt-row-meta"><span className="dt-mono">{entry.repository ?? entry.url}</span>
            {entry.load && <LabelValue label={t('clusterExecutor')} value={`${entry.load.running}/${entry.load.maxWorkers}`} />}</div>
          <div className="dt-actions"><ActionLink href={entry.url}>{t('clusterOpenPanel')}</ActionLink></div>
        </div>
      </li>)}</ul>
    </Section>}

    <Section title={t('clusterAdd')} icon="plus">
      <form className="dt-form dt-embedded" onSubmit={submit}>
        <label className="dt-field"><span>{t('clusterRepository')}</span>
          <Input value={repository} placeholder="owner/name" aria-label={t('clusterRepository')} disabled={add.busy}
            onChange={event => setRepository(event.target.value)} /></label>
        <label className="dt-field"><span>{t('clusterName')}</span>
          <Input value={name} placeholder={t('clusterNamePlaceholder')} aria-label={t('clusterName')} disabled={add.busy}
            onChange={event => setName(event.target.value)} /></label>
        <div className="dt-actions">
          <Button variant="primary" type="submit" disabled={!repository.trim() || add.busy}>{t('clusterAddAction')}</Button>
          <Hint>{t('clusterAddHint')}</Hint>
        </div>
      </form>
      <Hint>{t('clusterCliHint')} <code className="dt-code">node tools/cluster.mjs add --repo owner/name --provision</code></Hint>
    </Section>

    <Section title={t('clusterOperations')} count={data.operations.length} icon="history">
      {data.operations.length === 0 ? <Hint>{t('clusterNoOperations')}</Hint>
        : <ul className="dt-list">{data.operations.map(operation => <OperationRow key={operation.id} operation={operation} />)}</ul>}
    </Section>
  </div>
}
