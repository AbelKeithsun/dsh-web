/**
 * The family-wide anonymous install telemetry switch, rendered inside the Web
 * Plugins settings section above the plugin cards.
 *
 * The control is a settings-section fragment, not a plugin root, so it carries
 * no data-dsh-plugin or data-dsh-part attribute. It reads the stored preference
 * on mount and writes it through the shared reporter, which every family client
 * package consumes; the browser's own Do Not Track signal suppresses the
 * heartbeat independently, so the note under the hint reports that state.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { WebUIPluginsKey } from './locales.ts'
import {
  isTelemetryOptedOut,
  isTelemetrySuppressed,
  setTelemetryOptedOut,
} from './telemetry.ts'
import css from './web-ui-settings.module.css'

/** Props the settings section binds for the telemetry switch. */
export type TelemetryToggleProps = {
  /** Locale reader for the 'web-ui-plugins' namespace. */
  t: (key: WebUIPluginsKey) => string
}

/** Render the opt-out checkbox, its explanatory hint, and the Do Not Track note. */
export function TelemetryToggle(props: TelemetryToggleProps): ReactNode {
  const { t } = props
  // Read after mount: the first client render has no storage to consult, and a
  // server-rendered frame must not disagree with the browser's stored value.
  const [optedOut, setOptedOut] = useState(false)
  const [doNotTrack, setDoNotTrack] = useState(false)
  useEffect(() => {
    setOptedOut(isTelemetryOptedOut())
    setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
  }, [])

  return (
    <div className={css.telemetry}>
      <label className={css.telemetryRow}>
        <input
          type="checkbox"
          className={css.telemetryCheckbox}
          checked={optedOut}
          onChange={(event) => {
            const next = event.target.checked
            setOptedOut(next)
            setTelemetryOptedOut(next)
            setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
          }}
        />
        <span className={css.telemetryLabel}>{t('telemetry.label')}</span>
      </label>
      <span className={css.telemetryHint}>{t('telemetry.hint')}</span>
      {doNotTrack ? (
        <span className={css.telemetryDnt} role="status">{t('telemetry.dnt')}</span>
      ) : null}
    </div>
  )
}
