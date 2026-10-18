/**
 * Russian dictionary for the "web-ui-plugins" locale namespace.
 * Source package: packages/dsh-web-settings (its zh dictionary is the key source).
 * Maintained centrally by the dsh-i18n language pack; when a zh key is added
 * or changed upstream, mirror it here and run `pnpm i18n:check`.
 */

export const ru: Record<string, string> = {
  'title': 'Веб-плагины',
  'telemetry.label': 'Анонимная телеметрия установок',
  'telemetry.hint': 'Каждый браузер раз в сутки отправляет на dsh-market.com один анонимный сигнал: случайный идентификатор и названия включённых здесь плагинов, без какого-либо содержимого диалогов. Если выключить, браузерная часть всех плагинов семейства перестаёт отправлять данные; Мастерская и онлайн-обновления продолжают работать.',
  'telemetry.dnt': 'Браузер передаёт запрос Do Not Track, поэтому отправка сигналов уже остановлена; переключатель ниже лишь сохраняет предпочтение на этой машине.',
}
