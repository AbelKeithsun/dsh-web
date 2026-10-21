/**
 * The squad detail page: the squad's own facts, the member cards, and the
 * add/edit/delete actions for the squad and for each member.
 *
 * It is presentational as well - every action is a callback the page wires to
 * the transport - so a failure the page reports lands on the card it belongs
 * to instead of replacing the whole view.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { latestRunFor } from './runs.ts'
import { MemberCard } from './MemberCard.tsx'
import type { MemberNotice } from './MemberCard.tsx'
import type { RunRecord, TeamDefinition } from '../protocol.ts'
import css from './agents.module.css'

/** Everything the detail view can ask the page to do. */
export interface SquadActions {
  back(): void
  editTeam(): void
  deleteTeam(): void
  addMember(): void
  editMember(memberId: string): void
  deleteMember(memberId: string): void
  run(memberId: string): void
  openSession?: (sessionId: string) => void
}

export interface SquadDetailProps {
  team: TeamDefinition
  /** Every run the Host published; the card picks its own newest one. */
  runs: readonly RunRecord[]
  /** A page-level action is in flight. */
  busy: boolean
  notice: MemberNotice | undefined
  actions: SquadActions
}

/**
 * Render the squad detail page.
 * @param props - the squad, the run list and the page actions.
 */
export function SquadDetail({ team, runs, busy, notice, actions }: SquadDetailProps): ReactNode {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const description = team.description ?? ''
  return (
    <section className={css.section} data-dsh-part="squad-detail">
      <div className={css.detailHead}>
        <button type="button" className={css.secondary} onClick={actions.back}>{t('detail.back')}</button>
        <div className={css.detailTitle}>
          <h3 className={css.sectionTitle}>{team.name}</h3>
          <p className={css.detailWorkspace}>{team.workspaceId === undefined || team.workspaceId === '' ? t('detail.noWorkspace') : t('detail.workspace', { name: team.workspaceId })}</p>
        </div>
      </div>
      {description === '' ? null : <p className={css.detailDescription} data-dsh-part="squad-description">{description}</p>}
      <div className={css.detailActions}>
        <button type="button" className={css.primary} onClick={actions.addMember}>{t('detail.addMember')}</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={actions.editTeam}>{t('detail.editTeam')}</button>
        {confirmingDelete ? (
          <>
            <button type="button" className={css.danger} disabled={busy} onClick={() => { setConfirmingDelete(false); actions.deleteTeam() }}>
              {t('detail.deleteTeamConfirm')}
            </button>
            <button type="button" className={css.secondary} onClick={() => { setConfirmingDelete(false) }}>{t('detail.cancel')}</button>
          </>
        ) : (
          <button type="button" className={css.secondary} disabled={busy} onClick={() => { setConfirmingDelete(true) }}>{t('detail.deleteTeam')}</button>
        )}
      </div>
      <h4 className={css.membersTitle}>{t('detail.members')}</h4>
      {team.members.length === 0 ? (
        <div className={css.empty} data-dsh-part="member-empty">
          <p className={css.emptyTitle}>{t('detail.membersEmpty')}</p>
          <p className={css.emptyHint}>{t('detail.membersEmptyHint')}</p>
        </div>
      ) : (
        <ul className={css.memberGrid}>
          {team.members.map(member => (
            <li key={member.id} className={css.memberItem}>
              <MemberCard
                member={member}
                run={latestRunFor(runs, team.id, member.id)}
                busy={busy}
                notice={notice !== undefined && notice.memberId === member.id ? notice : undefined}
                onRun={() => { actions.run(member.id) }}
                onOpenSession={actions.openSession}
                onEdit={() => { actions.editMember(member.id) }}
                onDelete={() => { actions.deleteMember(member.id) }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
