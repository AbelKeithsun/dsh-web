/**
 * Copy of the agents sub-plugin: a zh-first dictionary with an English
 * companion, registered into the shell's locale service and read through one
 * tiny lookup so plain-DOM callers (the sidebar row label) follow the active
 * language without a reload.
 *
 * The dictionaries stay dependency-free on purpose: the browser bundle may
 * not value-import an SDK package, and the registration below is the only
 * place that touches `ctx.locale`.
 */

/** Locale namespace this plugin registers its dictionaries under. */
export const AGENTS_LOCALE_NAMESPACE = 'dsh-agents'

/** zh dictionary (key-set source of truth). */
export const zh = {
  'entry.label': '智能体',
  'agents.title': '智能体',
  'agents.subtitle': '小队是成员的集合，成员可以单独点播成会话',
  'agents.refresh': '刷新',
  'agents.loading': '正在读取小队…',
  'agents.retry': '重试',
  'error.title': '读取失败',
  'error.notMounted': '智能体的后台接口没有挂载：宿主没有加载这个插件，或该行启动失败。重启 DSH 服务后再试。',
  'error.unauthorized': '登录状态已失效，请刷新页面后重试。',
  'error.forbidden': '当前环境未通过同源校验：桌面外壳或反向代理可能没有传递浏览器标记。',
  'error.rejected': '后台拒绝了这次请求：{detail}',
  'error.unknownPreset': '成员钉住的预设在这个部署里不可用（预设不存在，或部署没有预设注册表），点播被拒绝。换一个预设，或确认宿主已经安装它。',
  'error.noWorkspace': '小队和成员都没有可用工作区（或钉住的工作区不在宿主名录里），点播被拒绝。先给小队绑定一个可用工作区。',
  'error.timeout': '后台 {seconds} 秒内没有响应，请稍后重试。',
  'error.unreachable': '连接不上本机 DSH 服务，请确认它仍在运行。',
  'error.unexpected': '后台返回了无法识别的响应（HTTP {status}）。',
  'error.unknown': '出现了未预期的错误，请重试。',
  'error.squadMissing': '这个小队已经不存在了，可能刚被删除。返回列表后重新选一个。',
  'error.leadCreateFailed': '宿主没能创建整队的 Lead 会话，整队没有启动。稍后重试，或先确认小队的工作区仍可用。',
  'error.leadPrepareFailed': 'Lead 会话已经创建，但没能准备好：改名或首条消息失败，这次运行记为失败。可以从运行记录里打开这个会话查看。',
  'error.ledgerUnavailable': '小队账本现在读不到或写不进（被别的 DSH 进程占用、损坏或无法写入）。修好账本文件后再试。',
  'list.new': '新建小队',
  'list.empty': '还没有小队',
  'list.emptyHint': '把常用的智能体组成一个小队，之后就能一键点播。',
  'list.memberCount': '{count} 位成员',
  'list.open': '打开小队 {name}',
  'list.noDescription': '没有简介',
  'detail.back': '返回小队列表',
  'detail.members': '成员',
  'detail.addMember': '添加成员',
  'detail.editTeam': '编辑小队',
  'detail.deleteTeam': '删除小队',
  'detail.deleteTeamConfirm': '确认删除',
  'detail.cancel': '取消',
  'detail.workspace': '工作区：{name}',
  'detail.noWorkspace': '未绑定工作区',
  'detail.membersEmpty': '这个小队还没有成员',
  'detail.membersEmptyHint': '成员至少要有名字；预设、权限、模型留空表示继承宿主默认。',
  'squad.runTitle': '整队运行',
  'squad.goalLabel': '目标（可选）',
  'squad.goalPlaceholder': '这一队要一起完成什么',
  'squad.leadPresetLabel': 'Lead 预设',
  'squad.leadPresetInherit': '部署默认',
  'squad.run': '运行整队',
  'squad.running': '正在启动整队…',
  'squad.runStarted': '已启动 Lead 会话 {session}',
  'squad.liveTitle': '正在运行',
  'squad.liveNoRun': '还没有整队运行',
  'squad.liveNoRunHint': '运行整队后，Lead 和它派出的成员会出现在这里。',
  'squad.livePending': '正在等待 Lead 发布队伍状态…',
  'squad.liveUnavailable': '这个部署没有把整队状态送到浏览器；运行记录仍然可用。',
  'squad.liveFailure': '整队状态发布失败：{detail}',
  'squad.lead': '队长',
  'squad.teammate': '成员',
  'squad.phase.provisioning': '正在启动',
  'squad.phase.active': '运行中',
  'squad.phase.failed': '启动失败',
  'squad.historyTitle': '运行记录',
  'squad.historyEmpty': '还没有运行记录',
  'squad.kind.squad': '整队',
  'squad.kind.member': '成员',
  'squad.memberGone': '成员已删除',
  'squad.goalLine': '目标：{goal}',
  'member.preset': '预设',
  'member.permission': '权限',
  'member.model': '模型',
  'member.inherit': '继承',
  'member.run': '点播',
  'member.runAgain': '再点播',
  'member.running': '正在点播…',
  'member.openSession': '打开会话',
  'member.edit': '编辑成员',
  'member.delete': '删除成员',
  'member.deleteConfirm': '确认删除',
  'member.cancel': '取消',
  'member.status.running': '会话运行中',
  'member.status.settled': '会话已结束',
  'member.status.failed': '会话已失败',
  'member.runStarted': '已启动会话 {session}',
  'permission.read-only': '只读',
  'permission.workspace-write': '可写工作区',
  'permission.danger-full-access': '完全访问',
  'form.teamTitle': '小队信息',
  'form.memberTitle': '成员信息',
  'form.name': '名字',
  'form.namePlaceholder': '例如：架构评审',
  'form.description': '简介（可选）',
  'form.descriptionPlaceholder': '这个小队负责什么',
  'form.workspace': '工作区（可选）',
  'form.workspacePlaceholder': '宿主的 workspace id；留空表示不绑定',
  'form.preset': '预设（可选）',
  'form.presetPlaceholder': '部署里的 agent preset id；留空表示继承',
  'form.permission': '权限（可选）',
  'form.permissionInherit': '继承宿主默认',
  'form.model': '模型（可选）',
  'form.modelUnlisted': '（不在当前模型目录中）',
  'form.reasoningEffort': '思考档位（可选）',
  'form.effortInherit': '模型默认',
  'form.effortNoLevels': '该模型没有声明思考档位',
  'form.effortUnlisted': '（不在当前档位列表中）',
  'form.brief': '简介（可选）',
  'form.briefPlaceholder': '这个成员擅长什么，一两句话说清',
  'form.save': '保存',
  'form.create': '创建',
  'form.cancel': '取消',
  'form.nameRequired': '名字不能为空',
  'form.leadPreset': 'Lead 预设（可选）',
  'form.leadPresetPlaceholder': '部署里的 agent preset id；留空表示部署默认',
  'form.basics': '基本信息',
  'form.basicsHint': '名字必填；简介会显示在小队卡片上。两项都能之后改。',
  'form.nameHint': '显示在小队卡片和小队标题上。',
  'form.runtime': '运行环境',
  'form.runtimeHint': '决定整队运行时 Lead 会话用哪个工作区、哪套配置；都能留空，运行前再定。',
  'form.generate': '自动生成简介',
  'form.generating': '正在生成…',
  'form.descriptionHint': '也可以自己写；点「自动生成简介」会按名字和这段文字起草。',
  'form.descriptionTemplate': '{name}\n职责：\n输入：\n产出：',
  'form.workspaceInherit': '不绑定（运行整队前要绑定）',
  'form.workspaceHint': '整队运行前必须绑定工作区，否则宿主会拒绝启动。',
  'form.workspaceHintTyped': '宿主没有上报工作区名录，这里填宿主的工作区 id。',
  'form.leadPresetHint': '留空表示用部署默认的智能体配置。',
  'form.leadPresetHintTyped': '宿主没有上报预设名录，这里填预设 id。',
  'form.preview': '预览',
  'form.previewName': '未命名小队',
  'form.previewWorkspace': '工作区：{name}',
  'form.previewLead': 'Lead：{name}',
  'error.describeUnavailable': '这个部署没有可用的模型路由，生成简介用不了；直接自己写就行。',
  'error.describeFailed': '模型没能写出简介：{detail}。直接自己写就行。',
  'settings.title': '智能体小队',
  'settings.description': '控制本插件对 agent 的公告。',
  'settings.enabledNote': '插件的总开关是配置行上的 enabled（默认开启）：关闭后小队账本、后台接口、成员简介注入与整队运行时都停止工作，本页的设置也随之失效。',
  'settings.announceToAgent': '向 agent 公告本插件',
  'settings.announceToAgentHint': '开启后向每一轮 agent 系统提示注入本插件公告（能力、约束与触发词）；默认关闭以保持提示词干净。',
  'settings.on': '开',
  'settings.off': '关',
  'settings.inherit': '继承（跟随部署默认）',
  'settings.overridden': '已覆盖',
  'settings.reset': '重置',
  'settings.invalidValue': '该取值不被接受',
  'settings.notExposed': '当前 DSH 版本未向设置页暴露本插件的配置命名空间，表单不可用。可编辑 $DSH_HOME/settings.yaml 直接配置，或确认提供该命名空间的插件已挂载其设置域并重启。',
  'settings.readOnly': '当前部署的设置只读。',
  'settings.expand': '展开设置',
  'settings.collapse': '收起设置',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.discard': '放弃',
  'settings.unsaved': '未保存',
  'settings.saveFailed': '部署未接受这些值，已保留供你修改。',
}

/** The dictionary key union. */
export type AgentsKey = keyof typeof zh

/** en dictionary (full mirror of the zh key set). */
export const en: Record<AgentsKey, string> = {
  'entry.label': 'Agents',
  'agents.title': 'Agents',
  'agents.subtitle': 'A squad groups members; start any member as its own session',
  'agents.refresh': 'Refresh',
  'agents.loading': 'Loading squads…',
  'agents.retry': 'Try again',
  'error.title': 'Could not load',
  'error.notMounted': 'The agents Host routes are not mounted: DSH did not load this plugin, or its row failed during start. Restart the DSH service and try again.',
  'error.unauthorized': 'Your sign-in expired. Reload the page and try again.',
  'error.forbidden': 'This environment failed the same-origin check: the desktop shell or a reverse proxy may have dropped the browser marker.',
  'error.rejected': 'The Host rejected this request: {detail}',
  'error.unknownPreset': 'The member pins a preset this deployment cannot serve (the preset is unknown, or the deployment has no preset registry), so the run was refused. Pick another preset, or confirm the Host has it installed.',
  'error.noWorkspace': 'Neither the squad nor the member pins a usable workspace (or the pinned one is not in the Host registry), so the run was refused. Bind a usable workspace to the squad first.',
  'error.timeout': 'The Host did not answer within {seconds}s. Try again later.',
  'error.unreachable': 'Cannot reach the local DSH service. Confirm it is still running.',
  'error.unexpected': 'The Host returned a response this page cannot read (HTTP {status}).',
  'error.unknown': 'Something unexpected went wrong. Try again.',
  'error.squadMissing': 'This squad no longer exists; it may have just been deleted. Go back to the list and pick another one.',
  'error.leadCreateFailed': 'The Host could not create the squad Lead session, so the run did not start. Try again shortly, or confirm the squad workspace is still available.',
  'error.leadPrepareFailed': 'The Lead session was created but could not be prepared: renaming it or queuing its first message failed, so this run is recorded as failed. Open it from the run history to look.',
  'error.ledgerUnavailable': 'The squad ledger cannot be read or written right now (another DSH process owns it, it is corrupt, or it cannot be written). Fix the ledger file and try again.',
  'list.new': 'New squad',
  'list.empty': 'No squads yet',
  'list.emptyHint': 'Group the agents you use together, then start any of them with one tap.',
  'list.memberCount': '{count} members',
  'list.open': 'Open squad {name}',
  'list.noDescription': 'No description',
  'detail.back': 'Back to squads',
  'detail.members': 'Members',
  'detail.addMember': 'Add member',
  'detail.editTeam': 'Edit squad',
  'detail.deleteTeam': 'Delete squad',
  'detail.deleteTeamConfirm': 'Confirm delete',
  'detail.cancel': 'Cancel',
  'detail.workspace': 'Workspace: {name}',
  'detail.noWorkspace': 'No workspace bound',
  'detail.membersEmpty': 'This squad has no members yet',
  'detail.membersEmptyHint': 'A member needs a name; leaving preset, permission or model empty inherits the Host default.',
  'squad.runTitle': 'Squad run',
  'squad.goalLabel': 'Goal (optional)',
  'squad.goalPlaceholder': 'What this squad must achieve together',
  'squad.leadPresetLabel': 'Lead preset',
  'squad.leadPresetInherit': 'Deployment default',
  'squad.run': 'Run squad',
  'squad.running': 'Starting the squad…',
  'squad.runStarted': 'Lead session {session} started',
  'squad.liveTitle': 'Running now',
  'squad.liveNoRun': 'No squad run yet',
  'squad.liveNoRunHint': 'Once the squad runs, the Lead and the teammates it spawns appear here.',
  'squad.livePending': 'Waiting for the Lead to publish its team…',
  'squad.liveUnavailable': 'This deployment does not publish squad state to the browser; the run history still works.',
  'squad.liveFailure': 'The squad state could not be published: {detail}',
  'squad.lead': 'Lead',
  'squad.teammate': 'Teammate',
  'squad.phase.provisioning': 'Starting',
  'squad.phase.active': 'Running',
  'squad.phase.failed': 'Failed',
  'squad.historyTitle': 'Run history',
  'squad.historyEmpty': 'No runs yet',
  'squad.kind.squad': 'Squad',
  'squad.kind.member': 'Member',
  'squad.memberGone': 'Member removed',
  'squad.goalLine': 'Goal: {goal}',
  'member.preset': 'Preset',
  'member.permission': 'Permission',
  'member.model': 'Model',
  'member.inherit': 'Inherited',
  'member.run': 'Run',
  'member.runAgain': 'Run again',
  'member.running': 'Starting…',
  'member.openSession': 'Open session',
  'member.edit': 'Edit member',
  'member.delete': 'Delete member',
  'member.deleteConfirm': 'Confirm delete',
  'member.cancel': 'Cancel',
  'member.status.running': 'Session running',
  'member.status.settled': 'Session settled',
  'member.status.failed': 'Session failed',
  'member.runStarted': 'Session {session} started',
  'permission.read-only': 'Read only',
  'permission.workspace-write': 'Workspace write',
  'permission.danger-full-access': 'Full access',
  'form.teamTitle': 'Squad details',
  'form.memberTitle': 'Member details',
  'form.name': 'Name',
  'form.namePlaceholder': 'For example: architecture review',
  'form.description': 'Description (optional)',
  'form.descriptionPlaceholder': 'What this squad is for',
  'form.workspace': 'Workspace (optional)',
  'form.workspacePlaceholder': 'A Host workspace id; leave empty to bind none',
  'form.preset': 'Preset (optional)',
  'form.presetPlaceholder': 'An agent preset id on this deployment; empty inherits',
  'form.permission': 'Permission (optional)',
  'form.permissionInherit': 'Inherit the Host default',
  'form.model': 'Model (optional)',
  'form.modelUnlisted': ' (not in the current model catalog)',
  'form.reasoningEffort': 'Reasoning effort (optional)',
  'form.effortInherit': 'Model default',
  'form.effortNoLevels': 'This model declares no reasoning levels',
  'form.effortUnlisted': ' (not in the current effort list)',
  'form.brief': 'Brief (optional)',
  'form.briefPlaceholder': 'What this member is good at, in one or two sentences',
  'form.save': 'Save',
  'form.create': 'Create',
  'form.cancel': 'Cancel',
  'form.nameRequired': 'A name is required',
  'form.leadPreset': 'Lead preset (optional)',
  'form.leadPresetPlaceholder': 'An agent preset id on this deployment; empty uses the deployment default',
  'form.basics': 'Basics',
  'form.basicsHint': 'A name is required; the description shows on the squad card. Both can change later.',
  'form.nameHint': 'Shows on the squad card and on the squad title.',
  'form.runtime': 'Runtime',
  'form.runtimeHint': 'Which workspace and which configuration the Lead session runs as. Both may stay empty until you run the squad.',
  'form.generate': 'Draft the description',
  'form.generating': 'Drafting…',
  'form.descriptionHint': 'You can write it yourself; the button drafts it from the name and this text.',
  'form.descriptionTemplate': '{name}\nPurpose:\nInputs:\nOutputs:',
  'form.workspaceInherit': 'Bind none (needed before a squad run)',
  'form.workspaceHint': 'A squad run is refused until a workspace is bound.',
  'form.workspaceHintTyped': 'This Host reports no workspace list; type a Host workspace id.',
  'form.leadPresetHint': 'Empty uses the deployment default agent preset.',
  'form.leadPresetHintTyped': 'This Host reports no preset list; type a preset id.',
  'form.preview': 'Preview',
  'form.previewName': 'Untitled squad',
  'form.previewWorkspace': 'Workspace: {name}',
  'form.previewLead': 'Lead: {name}',
  'error.describeUnavailable': 'This deployment serves no model route, so a description cannot be drafted; write it yourself.',
  'error.describeFailed': 'The model could not draft a description: {detail}. Write it yourself.',
  'settings.title': 'Agent squads',
  'settings.description': 'Controls how this plugin announces itself to agents.',
  'settings.enabledNote': "The plugin's master switch is enabled on its profile row (on by default): turning it off stops the squad ledger, its routes, the member-brief section and the squad runtime, which also disables the settings on this page.",
  'settings.announceToAgent': 'Announce this plugin to agents',
  'settings.announceToAgentHint': 'Adds this plugin announcement (capabilities, constraints and trigger words) to every agent system prompt; off by default so prompts stay clean.',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.inherit': 'Inherit (deployment default)',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.invalidValue': 'The value is not accepted',
  'settings.notExposed': "This DSH version does not expose this plugin's settings namespace to the configuration page, so the form is unavailable. Edit $DSH_HOME/settings.yaml directly, or confirm that the plugin owning the namespace is mounted with its settings domain and restart.",
  'settings.readOnly': 'This deployment stores settings read-only.',
  'settings.expand': 'Show settings',
  'settings.collapse': 'Hide settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.discard': 'Discard',
  'settings.unsaved': 'Unsaved',
  'settings.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
}

/** Active dictionary, picked by the document language at call time. */
export function dictionary(): Record<AgentsKey, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/**
 * SDK translate seat wired by the plugin entry once `ctx.locale` is bound.
 * While present it reads the ACTIVE locale at call time, so the sidebar row
 * (whose label the shell re-resolves on every locale change) follows the
 * Language setting; the document-language pick above stays the unwired
 * fallback for tests and for early module-scope callers.
 */
let runtimeT: ((key: AgentsKey, params?: Record<string, string>) => string) | undefined

/** Wire the SDK translate seat; pass undefined to restore the document-language pick. */
export function setRuntimeTranslate(seat: ((key: AgentsKey, params?: Record<string, string>) => string) | undefined): void {
  runtimeT = seat
}

/** Translate a key with optional {name} template params. */
export function t(key: AgentsKey, params?: Record<string, string>): string {
  if (runtimeT !== undefined) return runtimeT(key, params)
  let text: string = dictionary()[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(value)
  }
  return text
}

/** The slice of the locale service this registration needs. */
export interface LocaleRegistrar {
  register(namespace: string, dictionaries: { zh: Record<AgentsKey, string>; en: Record<AgentsKey, string> }): () => void
  bind(namespace: string): (key: AgentsKey, params?: Record<string, string>) => string
}

/**
 * Register both dictionaries and wire the runtime translate seat.
 * A deployment without the locale service keeps the document-language
 * fallback instead of failing the plugin's apply.
 * @param ctx - client context (service: locale, optional).
 * @returns disposer restoring the fallback.
 */
export function registerAgentLocales(ctx: { locale?: LocaleRegistrar }): () => void {
  let locale: LocaleRegistrar | undefined
  try {
    locale = ctx.locale
  } catch {
    locale = undefined
  }
  if (locale === undefined) return () => {}
  let dispose: () => void
  try {
    dispose = locale.register(AGENTS_LOCALE_NAMESPACE, { zh, en })
    setRuntimeTranslate(locale.bind(AGENTS_LOCALE_NAMESPACE))
  } catch {
    return () => {}
  }
  return () => {
    setRuntimeTranslate(undefined)
    dispose()
  }
}
