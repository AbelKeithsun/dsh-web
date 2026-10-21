/**
 * The two edit forms of the agents page: squad details and member details.
 *
 * Both are plain forms with local state and no dialog chrome, so they read the
 * same on a 360px phone as on a desktop column. Optional fields travel as
 * empty strings when the user submits - leaving them empty is how a member
 * asks the Host to inherit its default, and clearing an existing value has to
 * be expressible too.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { PERMISSION_MODES, permissionLabel } from './permissions.ts'
import type { MemberDraft, MemberDefinition, AgentsPermission, TeamDefinition, TeamDraft } from '../protocol.ts'
import css from './agents.module.css'

export interface TeamFormProps {
  /** The squad being edited; omitted when creating one. */
  team: TeamDefinition | undefined
  busy: boolean
  onSubmit: (draft: TeamDraft) => void
  onCancel: () => void
}

/**
 * Render the squad form.
 * @param props - the squad under edit and the page actions.
 */
export function TeamForm({ team, busy, onSubmit, onCancel }: TeamFormProps): ReactNode {
  const [name, setName] = useState(team?.name ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const [workspaceId, setWorkspaceId] = useState(team?.workspaceId ?? '')
  const [error, setError] = useState('')
  const submit = (): void => {
    if (name.trim() === '') {
      setError(t('form.nameRequired'))
      return
    }
    setError('')
    onSubmit({
      ...(team === undefined ? {} : { id: team.id }),
      name: name.trim(),
      description,
      workspaceId,
    })
  }
  return (
    <form className={css.form} data-dsh-part="team-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h3 className={css.sectionTitle}>{t('form.teamTitle')}</h3>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.name')}</span>
        <input className={css.input} value={name} placeholder={t('form.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.description')}</span>
        <textarea className={css.textarea} value={description} placeholder={t('form.descriptionPlaceholder')} onChange={(event) => { setDescription(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.workspace')}</span>
        <input className={css.input} value={workspaceId} placeholder={t('form.workspacePlaceholder')} onChange={(event) => { setWorkspaceId(event.target.value) }} />
      </label>
      {error === '' ? null : <p className={css.noticeError} role="alert">{error}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.primary} disabled={busy}>{team === undefined ? t('form.create') : t('form.save')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}

export interface MemberFormProps {
  teamId: string
  /** The member being edited; omitted when adding one. */
  member: MemberDefinition | undefined
  busy: boolean
  onSubmit: (teamId: string, draft: MemberDraft) => void
  onCancel: () => void
}

/**
 * Render the member form.
 * @param props - the member under edit and the page actions.
 */
export function MemberForm({ teamId, member, busy, onSubmit, onCancel }: MemberFormProps): ReactNode {
  const [name, setName] = useState(member?.name ?? '')
  const [preset, setPreset] = useState(member?.preset ?? '')
  const [permission, setPermission] = useState<string>(member?.permission ?? '')
  const [model, setModel] = useState(member?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(member?.reasoningEffort ?? '')
  const [brief, setBrief] = useState(member?.brief ?? '')
  const [error, setError] = useState('')
  const submit = (): void => {
    if (name.trim() === '') {
      setError(t('form.nameRequired'))
      return
    }
    setError('')
    onSubmit(teamId, {
      ...(member === undefined ? {} : { id: member.id }),
      name: name.trim(),
      preset,
      permission: permission === '' ? undefined : (permission as AgentsPermission),
      model,
      reasoningEffort,
      brief,
    })
  }
  return (
    <form className={css.form} data-dsh-part="member-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h3 className={css.sectionTitle}>{t('form.memberTitle')}</h3>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.name')}</span>
        <input className={css.input} value={name} placeholder={t('form.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.preset')}</span>
        <input className={css.input} value={preset} placeholder={t('form.presetPlaceholder')} onChange={(event) => { setPreset(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.permission')}</span>
        <select className={css.input} value={permission} onChange={(event) => { setPermission(event.target.value) }}>
          <option value="">{t('form.permissionInherit')}</option>
          {PERMISSION_MODES.map(mode => <option key={mode} value={mode}>{permissionLabel(mode)}</option>)}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.model')}</span>
        <input className={css.input} value={model} placeholder={t('form.modelPlaceholder')} onChange={(event) => { setModel(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.reasoningEffort')}</span>
        <input className={css.input} value={reasoningEffort} onChange={(event) => { setReasoningEffort(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.brief')}</span>
        <textarea className={css.textarea} value={brief} placeholder={t('form.briefPlaceholder')} onChange={(event) => { setBrief(event.target.value) }} />
      </label>
      {error === '' ? null : <p className={css.noticeError} role="alert">{error}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.primary} disabled={busy}>{member === undefined ? t('form.create') : t('form.save')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}
