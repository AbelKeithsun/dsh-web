/**
 * The protocol v1 pairing panel body: the QR symbol, the same secret in
 * plaintext, the 30 s countdown with its expiry state, the refresh action, and
 * the two facts the reader must not miss — the phone's origin is the public
 * relay (never this machine's loopback address), and the code is one-shot.
 *
 * Pure presentation: every state and action arrives through props, and the
 * clock is a prop, so the expiry flip is deterministic instead of read from
 * `Date.now()` here.
 */
import { memo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CheckIcon, CloseIcon, CopyIcon, RefreshIcon } from './icons.tsx'
import { PART_COPY, PART_NOTICE, PART_PANEL, PART_QR, PART_REFRESH, PART_TOKEN, PLUGIN_ATTR, QR_VALUE_ATTR } from './semantic.ts'
import css from './panel.module.css'

/** What the panel is currently showing. */
export type PairPanelState =
  /** A read is in flight. */
  | { kind: 'reading' }
  /**
   * A live one-shot secret. `pairingUrl`, when the host could name its own
   * public origin, is what the QR encodes: a `{token, url}` document the iOS
   * client parses into both halves of its configuration, so one scan sets the
   * address AND the token. With no origin the QR carries the bare token and the
   * panel says the address has to be set on the phone by hand.
   */
  | { kind: 'ready'; token: string; issuedAt: number; expiresAt: number; origin: string | null; pairingUrl: string | null }
  /** 403 from the loopback gate: this page is not open on the machine itself. */
  | { kind: 'forbidden' }
  /** The host route answered with an unexpected status or shape. */
  | { kind: 'failed'; status: number }
  /** The request never reached the host. */
  | { kind: 'unreachable' }

/** How the last copy attempt went. */
export type PairCopyState = 'idle' | 'copied' | 'failed'

export interface PairPanelProps {
  t: PropsLocale<'remote-bridge'>['t']
  state: PairPanelState
  /** The current wall clock; the entry supplies it from a one-second ticker. */
  now: number
  /** This page's own `host:port`, named in the origin warning. */
  host: string
  copy: PairCopyState
  onClose(): void
  onRefresh(): void
  onCopy(token: string): void
}

/**
 * The QR symbol, memoized on the secret: the countdown re-renders the panel
 * every second, and qrcode.react rebuilds the whole module path on each render.
 * The encoded value is the host's own `pairingUrl` verbatim when there is one —
 * a `{token, url}` document whose `url` names THIS instance's public relay, so
 * the phone adopts an origin that actually reaches this host. The bare-token
 * fallback means the phone keeps whatever origin it already has.
 */
const PairQrCode = memo(function PairQrCode({ value, label }: { value: string; label: string }) {
  return <QRCodeSVG value={value} size={184} level="M" marginSize={1} aria-label={label} />
})

/** One state notice: a title and, when there is one, the sentence explaining it. */
function Notice({ tone, title, body }: { tone: 'plain' | 'warning' | 'alert'; title: string; body?: string }) {
  return (
    <div className={css.notice} data-dsh-part={PART_NOTICE} data-tone={tone} role={tone === 'plain' ? 'status' : 'alert'}>
      <p className={css.noticeTitle}>{title}</p>
      {body !== undefined && <p className={css.noticeBody}>{body}</p>}
    </div>
  )
}

/**
 * Render the pairing panel.
 * @param props - locale seat, view state, clock, page host and actions.
 * @returns the panel element tree.
 */
export function PairPanel({ t, state, now, host, copy, onClose, onRefresh, onCopy }: PairPanelProps) {
  const remainingMs = state.kind === 'ready' ? Math.max(0, state.expiresAt - now) : 0
  const expired = state.kind === 'ready' && remainingMs <= 0
  const seconds = Math.ceil(remainingMs / 1000)
  const windowMs = state.kind === 'ready' ? Math.max(1, state.expiresAt - state.issuedAt) : 1
  const percent = Math.min(100, Math.max(0, Math.round((remainingMs / windowMs) * 100)))
  // What the QR encodes and what the copy button hands over: the same string,
  // so a human can paste exactly what a camera would have read.
  const payload = state.kind === 'ready' ? (state.pairingUrl ?? state.token) : ''

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        data-dsh-plugin={PLUGIN_ATTR}
        data-dsh-part={PART_PANEL}
      >
        <div className={css.header}>
          <div className={css.heading}>
            <h2 className={css.title}>{t('title')}</h2>
            <p className={css.subtitle}>{t('subtitle')}</p>
          </div>
          <button type="button" className={css.closeButton} aria-label={t('action.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {state.kind === 'reading' && <Notice tone="plain" title={t('state.reading')} />}

        {state.kind === 'forbidden' && (
          <Notice tone="alert" title={t('forbidden.title')} body={t('forbidden.body')} />
        )}

        {state.kind === 'failed' && (
          <Notice tone="alert" title={t('failed.title')} body={t('failed.body', { status: String(state.status) })} />
        )}

        {state.kind === 'unreachable' && (
          <Notice tone="alert" title={t('unreachable.title')} body={t('unreachable.body')} />
        )}

        {state.kind === 'ready' && (
          <>
            <div className={css.qrCard}>
              <div className={css.qrWrap} data-dsh-part={PART_QR} {...{ [QR_VALUE_ATTR]: payload }}>
                <PairQrCode value={payload} label={t('pair.qrLabel')} />
              </div>
              {expired ? (
                <Notice tone="alert" title={t('pair.expired')} body={t('pair.expiredHint')} />
              ) : (
                <div className={css.countdown}>
                  <span className={css.countdownText}>{t('pair.countdown', { s: String(seconds) })}</span>
                  <span className={css.bar}>
                    <span className={css.barFill} style={{ width: `${String(percent)}%` }} />
                  </span>
                </div>
              )}
            </div>

            <div className={css.tokenRow} data-dsh-part={PART_TOKEN}>
              <span className={css.tokenLabel}>{t('pair.payloadLabel')}</span>
              <code className={css.token}>{payload}</code>
            </div>

            <button
              type="button"
              className={css.copyButton}
              data-dsh-part={PART_COPY}
              data-copied={copy === 'copied'}
              data-failed={copy === 'failed'}
              onClick={() => { onCopy(payload) }}
            >
              {copy === 'copied' ? <CheckIcon /> : <CopyIcon />}
              {copy === 'copied' ? t('action.copied') : copy === 'failed' ? t('action.copyFailed') : t('action.copy')}
            </button>

            {state.pairingUrl === null ? (
              <Notice tone="warning" title={t('origin.title')} body={t('origin.body', { host })} />
            ) : (
              <Notice
                tone="plain"
                title={t('origin.located.title')}
                body={t('origin.located.body', { origin: state.origin ?? '' })}
              />
            )}
          </>
        )}

        <div className={css.actions}>
          {state.kind !== 'reading' && state.kind !== 'forbidden' && (
            <button type="button" className={css.refresh} data-dsh-part={PART_REFRESH} onClick={onRefresh}>
              <RefreshIcon />
              {t('pair.refresh')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
