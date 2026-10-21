/**
 * The two edit forms of the agents page: squad details and member details.
 *
 * Both are plain forms with local state and no dialog chrome, so they read the
 * same on a 360px phone as on a desktop column. Optional fields travel as
 * empty strings when the user submits - leaving them empty is how a member
 * asks the Host to inherit its default, and clearing an existing value has to
 * be expressible too.
 *
 * The member's permission, model and reasoning effort are PICKERS, never text
 * boxes: every one of them stores an id the Host resolves later, and free
 * typing is exactly how a member ends up pinning an id no Host will honour. The
 * model and effort rows come from the catalog the Host publishes, and the
 * inherit row is the first one in each.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { effortLevels, effortRows, modelDeclaresNoLevels, modelRows } from './model-options.ts'
import { PERMISSION_MODES, permissionLabel } from './permissions.ts'
import type { AgentsModelOption, MemberDraft, MemberDefinition, AgentsPermission, TeamDefinition, TeamDraft } from '../protocol.ts'
import css from './agents.module.css'

/**
 * The full-draft view of one squad.
 *
 * The Host replaces every editable field with what a `POST /team` draft carries:
 * a field the draft omits is cleared, not preserved. Anything that saves a squad
 * therefore starts from this function, so an action that only changes one field
 * cannot silently drop the workspace pin, the Lead preset or the sort order.
 * @param team - the current squad.
 * @param overrides - fields the caller is changing; an explicit `undefined`
 *   clears that field.
 */
export function teamDraftOf(team: TeamDefinition, overrides?: { leadPreset?: string }): TeamDraft {
  const leadPreset = overrides !== undefined && 'leadPreset' in overrides ? overrides.leadPreset : team.leadPreset
  return {
    id: team.id,
    name: team.name,
    ...(team.description === undefined ? {} : { description: team.description }),
    ...(team.workspaceId === undefined ? {} : { workspaceId: team.workspaceId }),
    ...(leadPreset === undefined ? {} : { leadPreset }),
    ...(team.order === undefined ? {} : { order: team.order }),
  }
}

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
  const [leadPreset, setLeadPreset] = useState(team?.leadPreset ?? '')
  const [error, setError] = useState('')
  const submit = (): void => {
    if (name.trim() === '') {
      setError(t('form.nameRequired'))
      return
    }
    setError('')
    const pinnedLead = leadPreset.trim()
    onSubmit({
      ...(team === undefined ? {} : teamDraftOf(team)),
      name: name.trim(),
      description,
      workspaceId,
      // Always present so clearing the field actually clears the pin: the Host
      // reads an absent field as "keep nothing" for a replace and drops the key
      // from the JSON body either way.
      leadPreset: pinnedLead === '' ? undefined : pinnedLead,
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
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.leadPreset')}</span>
        <input className={css.input} value={leadPreset} placeholder={t('form.leadPresetPlaceholder')} onChange={(event) => { setLeadPreset(event.target.value) }} />
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
  /**
   * The model catalog the Host published. Absent when it published none, and
   * the form then offers no model picker at all instead of an empty one.
   */
  models?: readonly AgentsModelOption[]
  /** The deployment-wide reasoning levels the Host published, when it published any. */
  efforts?: readonly string[]
  onSubmit: (teamId: string, draft: MemberDraft) => void
  onCancel: () => void
}

/**
 * Render the member form.
 * @param props - the member under edit and the page actions.
 */
export function MemberForm({ teamId, member, busy, models, efforts, onSubmit, onCancel }: MemberFormProps): ReactNode {
  const [name, setName] = useState(member?.name ?? '')
  const [preset, setPreset] = useState(member?.preset ?? '')
  const [permission, setPermission] = useState<string>(member?.permission ?? '')
  const [model, setModel] = useState(member?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(member?.reasoningEffort ?? '')
  const [brief, setBrief] = useState(member?.brief ?? '')
  const [error, setError] = useState('')
  // Read per render: the picker follows the model currently chosen, not the one
  // the member arrived with.
  const levels = effortLevels(models, efforts, model)
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
      {models === undefined ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('form.model')}</span>
          <select className={css.input} name="model" value={model} onChange={(event) => { setModel(event.target.value) }}>
            <option value="">{t('member.inherit')}</option>
            {modelRows(models, model).map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
        </label>
      )}
      {models === undefined && efforts === undefined ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('form.reasoningEffort')}</span>
          {/* The explicit name keeps the control's own label free of the hint
              beside it, which states why the picker offers so little. */}
          <select
            className={css.input}
            name="reasoningEffort"
            aria-label={t('form.reasoningEffort')}
            value={reasoningEffort}
            onChange={(event) => { setReasoningEffort(event.target.value) }}
          >
            <option value="">{t('form.effortInherit')}</option>
            {effortRows(levels, reasoningEffort).map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
          {modelDeclaresNoLevels(models, model) ? <span className={css.fieldHint}>{t('form.effortNoLevels')}</span> : null}
        </label>
      )}
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
