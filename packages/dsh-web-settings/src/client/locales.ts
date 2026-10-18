/**
 * The `web-ui-plugins` locale dictionaries for the group card.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': 'Web 插件',
  'telemetry.title': '匿名安装遥测',
  'telemetry.description': '每日一次匿名心跳，说明本机在用哪些家族插件',
  'telemetry.meta': '关闭后全部家族插件的浏览器端都不再发送；插件市场与在线更新不受影响。',
  'telemetry.dnt': '当前浏览器开启了「请勿跟踪」，心跳已停止；右侧开关只表示本机保存的偏好。',
  'settings.collapse': '收起',
  'settings.expand': '展开',
  'settings.notExposed': '该设置段未暴露（宿主命名空间缺失）',
  'settings.unsaved': '有未保存的更改',
  'settings.readOnly': '只读',
  'settings.saveFailed': '保存失败',
  'settings.discard': '放弃更改',
  'settings.save': '保存',
  'settings.saving': '保存中…',
} satisfies Record<string, string>

/** Key union for this namespace. */
export type WebUIPluginsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Web Plugins',
  'telemetry.title': 'Anonymous install telemetry',
  'telemetry.description': 'One anonymous heartbeat a day listing the family plugins in use here',
  'telemetry.meta': 'Turning it off stops the browser half of every family plugin from reporting; the Workshop and online updates keep working.',
  'telemetry.dnt': 'This browser sends a Do Not Track request, so the heartbeat has already stopped; the switch on the right only records a preference on this machine.',
  'settings.collapse': 'Collapse',
  'settings.expand': 'Expand',
  'settings.notExposed': 'Section not exposed (host namespace missing)',
  'settings.unsaved': 'Unsaved changes',
  'settings.readOnly': 'Read only',
  'settings.saveFailed': 'Save failed',
  'settings.discard': 'Discard changes',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
} satisfies Record<WebUIPluginsKey, string>
