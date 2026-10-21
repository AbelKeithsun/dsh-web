/**
 * The agents page: one load state, one poll loop, and the squad/member
 * actions that write through the transport.
 *
 * M1 refreshes by polling GET state every {@link AGENTS_POLL_INTERVAL_MS}
 * while the page is mounted, plus the manual refresh control in the header;
 * the loop stops and its in-flight read is aborted on unmount. A poll that
 * fails after a good read keeps the last snapshot on screen and reports the
 * failure as a banner, so a flaky phone link never blanks the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { failureOf } from './host-api.ts'
import type { AgentsFailure, AgentsTransport } from './host-api.ts'
import { t } from './locales.ts'
import { TeamForm, MemberForm } from './Forms.tsx'
import { SquadList } from './SquadList.tsx'
import { SquadDetail } from './SquadDetail.tsx'
import type { MemberNotice } from './MemberCard.tsx'
import type { AgentsStateView, MemberDefinition, MemberDraft, TeamDefinition, TeamDraft } from '../protocol.ts'
import css from './agents.module.css'

/** Refresh cadence while the page is mounted. M1 polls; there is no stream. */
export const AGENTS_POLL_INTERVAL_MS = 5000

/** What the page has read so far. */
type Load =
  | { phase: 'loading' }
  | { phase: 'error'; failure: AgentsFailure; message: string }
  | { phase: 'ready'; state: AgentsStateView; stale?: { failure: AgentsFailure; message: string } }

/** The open edit form, if any. */
type Form =
  | { kind: 'team'; team: TeamDefinition | undefined }
  | { kind: 'member'; teamId: string; member: MemberDefinition | undefined }

export interface AgentsPageProps {
  transport: AgentsTransport
  /** Switch the GUI to an existing member session; absent when the deployment has none. */
  openSession?: (sessionId: string) => void
}

/**
 * Render the whole agents page.
 * @param props - the transport and the optional session opener.
 */
export function AgentsPage({ transport, openSession }: AgentsPageProps): ReactNode {
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<Form | undefined>(undefined)
  const [notice, setNotice] = useState<MemberNotice | undefined>(undefined)
  const [pageError, setPageError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const state = await transport.state(signal)
      if (!mounted.current) return
      setLoad({ phase: 'ready', state })
    } catch (error) {
      if (!mounted.current) return
      // A read this page cancelled (unmount) says nothing about the Host.
      if (signal !== undefined && signal.aborted) return
      const described = failureOf(error)
      setLoad(previous => previous.phase === 'ready'
        ? { phase: 'ready', state: previous.state, stale: described }
        : { phase: 'error', failure: described.failure, message: described.message })
    }
  }, [transport])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = globalThis.setInterval(() => { void refresh(controller.signal) }, AGENTS_POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      globalThis.clearInterval(timer)
      controller.abort()
    }
  }, [refresh])

  /** Run one write, report its failure at page level, and re-read on success. */
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setPageError(undefined)
    try {
      await action()
    } catch (error) {
      if (mounted.current) setPageError(failureOf(error).message)
      if (mounted.current) setBusy(false)
      return
    }
    if (mounted.current) setBusy(false)
    await refresh()
  }

  const runMember = (teamId: string, memberId: string): void => {
    void (async () => {
      setBusy(true)
      setNotice(undefined)
      setPageError(undefined)
      try {
        const run = await transport.run(teamId, memberId)
        if (!mounted.current) return
        setNotice({ memberId, kind: 'ok', message: t('member.runStarted', { session: run.sessionId }) })
        await refresh()
      } catch (error) {
        if (!mounted.current) return
        setNotice({ memberId, kind: 'failed', message: failureOf(error).message })
      } finally {
        if (mounted.current) setBusy(false)
      }
    })()
  }

  const submitTeam = (draft: TeamDraft): void => {
    void perform(async () => {
      const team = await transport.createTeam(draft)
      setForm(undefined)
      setSelectedTeamId(team.id)
    })
  }

  const submitMember = (teamId: string, draft: MemberDraft): void => {
    void perform(async () => {
      await transport.saveMember(teamId, draft)
      setForm(undefined)
    })
  }

  const selectedTeam = load.phase === 'ready' ? load.state.teams.find(team => team.id === selectedTeamId) : undefined

  const body = ((): ReactNode => {
    if (form !== undefined && form.kind === 'team') {
      return <TeamForm team={form.team} busy={busy} onSubmit={submitTeam} onCancel={() => { setForm(undefined) }} />
    }
    if (form !== undefined && form.kind === 'member') {
      return <MemberForm teamId={form.teamId} member={form.member} busy={busy} onSubmit={submitMember} onCancel={() => { setForm(undefined) }} />
    }
    if (load.phase === 'loading') {
      return <p className={css.state} role="status" data-dsh-part="agents-loading">{t('agents.loading')}</p>
    }
    if (load.phase === 'error') {
      return (
        <div className={css.state} role="alert" data-dsh-part="agents-error">
          <p className={css.emptyTitle}>{t('error.title')}</p>
          <p className={css.emptyHint}>{load.message}</p>
          <button type="button" className={css.primary} onClick={() => { void refresh() }}>{t('agents.retry')}</button>
        </div>
      )
    }
    if (selectedTeam !== undefined) {
      return (
        <SquadDetail
          team={selectedTeam}
          runs={load.state.runs}
          busy={busy}
          notice={notice}
          actions={{
            back: () => { setSelectedTeamId(undefined); setNotice(undefined) },
            editTeam: () => { setForm({ kind: 'team', team: selectedTeam }) },
            deleteTeam: () => {
              void perform(async () => {
                await transport.deleteTeam(selectedTeam.id)
                setForm(undefined)
                setSelectedTeamId(undefined)
              })
            },
            addMember: () => { setForm({ kind: 'member', teamId: selectedTeam.id, member: undefined }) },
            editMember: (memberId: string) => {
              const member = selectedTeam.members.find(candidate => candidate.id === memberId)
              setForm({ kind: 'member', teamId: selectedTeam.id, member })
            },
            deleteMember: (memberId: string) => {
              void perform(async () => { await transport.deleteMember(selectedTeam.id, memberId) })
            },
            run: (memberId: string) => { runMember(selectedTeam.id, memberId) },
            ...(openSession === undefined ? {} : { openSession }),
          }}
        />
      )
    }
    return (
      <SquadList
        teams={load.state.teams}
        onOpen={(teamId: string) => { setSelectedTeamId(teamId); setNotice(undefined) }}
        onNew={() => { setForm({ kind: 'team', team: undefined }) }}
      />
    )
  })()

  return (
    <div className={css.page} data-dsh-plugin="agents" data-dsh-agents-view="">
      <header className={css.header}>
        <div className={css.headerTitle}>
          <h2 className={css.title}>{t('agents.title')}</h2>
          <p className={css.subtitle}>{t('agents.subtitle')}</p>
        </div>
        <button type="button" className={css.secondary} aria-label={t('agents.refresh')} title={t('agents.refresh')} onClick={() => { void refresh() }}>
          {t('agents.refresh')}
        </button>
      </header>
      {load.phase === 'ready' && load.stale !== undefined ? (
        <p className={css.noticeError + ' ' + css.banner} role="status" data-dsh-part="agents-stale">{load.stale.message}</p>
      ) : null}
      {pageError === undefined ? null : <p className={css.noticeError + ' ' + css.banner} role="alert" data-dsh-part="agents-page-error">{pageError}</p>}
      <div className={css.body}>{body}</div>
    </div>
  )
}
