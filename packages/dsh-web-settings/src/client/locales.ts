/**
 * The `web-ui-plugins` locale dictionaries for the group card.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': 'Web 插件',
  'telemetry.label': '匿名安装遥测',
  'telemetry.hint': '每个浏览器每天向 dsh-market.com 发送一次匿名心跳：一个随机 ID 与本机已启用的插件名，不含任何对话内容。关闭后全部家族插件的浏览器端都不再发送；插件市场与在线更新不受影响。',
  'telemetry.dnt': '当前浏览器开启了「请勿跟踪」，心跳已停止；下面的开关只表示本机保存的偏好。',
} satisfies Record<string, string>

/** Key union for this namespace. */
export type WebUIPluginsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Web Plugins',
  'telemetry.label': 'Anonymous install telemetry',
  'telemetry.hint': 'Each browser sends one anonymous heartbeat to dsh-market.com per day: a random id plus the names of the plugins enabled here, never any conversation content. Turning it off stops the browser half of every family plugin from reporting; the Workshop and online updates keep working.',
  'telemetry.dnt': 'This browser sends a Do Not Track request, so the heartbeat has already stopped; the switch below only records a preference on this machine.',
} satisfies Record<WebUIPluginsKey, string>
