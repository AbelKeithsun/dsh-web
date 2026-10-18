/**
 * The family-wide anonymous install telemetry switch, rendered inside the Web
 * Plugins settings section above the plugin cards.
 *
 * The control is a settings-section fragment, not a plugin root, so it carries
 * no data-dsh-plugin attribute. It renders through the family card chrome so it
 * reads as a sibling of the plugin cards below rather than a box of its own:
 * the same mark tile, title and description rhythm, with the switch taking the
 * place a disclosure chevron has on a plugin card.
 *
 * The card's title is the setting name and the switch is its positive value,
 * checked meaning the heartbeat runs, which is the default. The stored
 * preference is the opt-out, so the switch and the stored value are inverses.
 * The explanation is the card's description line; the browser's Do Not Track
 * signal suppresses the heartbeat independently, so a note under that line
 * (inside the card) reports that state.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { WebUIPluginsKey } from './locales.ts'
import {
  isTelemetryOptedOut,
  isTelemetrySuppressed,
  setTelemetryOptedOut,
} from './telemetry.ts'
import { PluginSettingsCard, ToggleSwitch } from './PluginSettingsCard.tsx'
import css from './web-ui-settings.module.css'

/** Props the settings section binds for the telemetry switch. */
export type TelemetryToggleProps = {
  /** Locale reader for the 'web-ui-plugins' namespace. */
  t: (key: WebUIPluginsKey) => string
}

/**
 * Card state for a setting that applies on flip: always available (a local
 * browser preference, not a Host namespace), always writable, and never dirty,
 * because nothing is staged.
 */
const IMMEDIATE_CARD_STATE = {
  available: true,
  exposed: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
} as const

/** Heartbeat mark for the card header: a signal pulsing out of one point. */
function TelemetryMark(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="2.1" fill="currentColor" />
      <path d="M5.4 5.4a5.1 5.1 0 0 0 0 7.2M12.6 5.4a5.1 5.1 0 0 1 0 7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2.9 2.9a8.6 8.6 0 0 0 0 12.2M15.1 2.9a8.6 8.6 0 0 1 0 12.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

/** Render the telemetry card: its mark, title, switch, and the Do Not Track note. */
export function TelemetryToggle(props: TelemetryToggleProps): ReactNode {
  const { t } = props
  const titleId = useId()
  // Read after mount: the first client render has no storage to consult, and a
  // server-rendered frame must not disagree with the browser's stored value.
  const [optedOut, setOptedOut] = useState(false)
  const [doNotTrack, setDoNotTrack] = useState(false)
  useEffect(() => {
    setOptedOut(isTelemetryOptedOut())
    setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
  }, [])

  const store = (nextOptedOut: boolean): void => {
    setOptedOut(nextOptedOut)
    setTelemetryOptedOut(nextOptedOut)
    setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
  }

  return (
    <div className={css.telemetry} data-dsh-part="telemetry">
      <ul className={css.subcards}>
        <PluginSettingsCard
          t={t}
          titleKey="telemetry.title"
          descriptionKey="telemetry.description"
          titleId={titleId}
          icon={<TelemetryMark />}
          descriptionNode={(
            <>
              <span className={css.telemetrySummary}>{t('telemetry.description')}</span>
              <span className={css.telemetryMeta}>{t('telemetry.meta')}</span>
              {doNotTrack ? <span className={css.telemetryNote} role="status">{t('telemetry.dnt')}</span> : null}
            </>
          )}
          alwaysOpen
          headerOnly
          hideFooter
          state={IMMEDIATE_CARD_STATE}
          headerAction={(
            <ToggleSwitch
              labelledBy={titleId}
              checked={!optedOut}
              onChange={(next) => { store(!next) }}
            />
          )}
          onSave={() => {}}
          onDiscard={() => {}}
        >
          {null}
        </PluginSettingsCard>
      </ul>
    </div>
  )
}