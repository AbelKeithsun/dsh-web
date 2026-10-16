// @vitest-environment jsdom
/**
 * The pairing panel body: the QR symbol and its plaintext twin, the countdown
 * and its expiry state, the relay-origin warning, and the two refusal states.
 * Pure presentation — the clock arrives as a prop, so the expiry flip is a
 * value, not a wait.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PairPanel, type PairPanelState } from '../src/client/PairPanel.tsx'
import { QR_VALUE_ATTR } from '../src/client/semantic.ts'
import { zh, type RemoteBridgeKey } from '../src/client/locales.ts'

/** Translate stub over the zh dictionary, with {param} interpolation. */
function makeTranslate(): PropsLocale<'remote-bridge'>['t'] {
  return (key, params) => {
    let text: string = zh[key as RemoteBridgeKey] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

/** The page's own host:port, as the origin warning names it. */
const HOST = '127.0.0.1:19398'

/** Render the panel in one state and return the container. */
function mount(state: PairPanelState, now = 1_000_000) {
  return render(
    <PairPanel
      t={makeTranslate()}
      state={state}
      now={now}
      host={HOST}
      copy="idle"
      onClose={() => undefined}
      onRefresh={() => undefined}
      onCopy={() => undefined}
    />,
  ).container
}

afterEach(() => {
  cleanup()
})

describe('protocol v1 pairing panel', () => {
  it('operator sees the bare pairing code in the QR symbol and in plaintext', () => {
    // Given a live code on screen
    const container = mount({ kind: 'ready', token: 'Kq7xTt2mRw9vLpB4nJcH5sYzA1eU8gFoI3dXbN0rQ6w', issuedAt: 1_000_000, expiresAt: 1_030_000, origin: null, pairingUrl: null })
    // When the reader looks at the symbol and the code row
    const qr = container.querySelector('[data-dsh-part="qr"]')
    const token = container.querySelector('[data-dsh-part="token"] code')
    // Then both carry that one secret, and it is the bare token rather than a URL or a JSON document
    expect(qr?.getAttribute(QR_VALUE_ATTR)).toBe('Kq7xTt2mRw9vLpB4nJcH5sYzA1eU8gFoI3dXbN0rQ6w')
    expect(token?.textContent).toBe('Kq7xTt2mRw9vLpB4nJcH5sYzA1eU8gFoI3dXbN0rQ6w')
    const encoded = qr?.getAttribute(QR_VALUE_ATTR) ?? ''
    expect(/^(?:wss?|https?):/.test(encoded)).toBe(false)
    expect(encoded.startsWith('{')).toBe(false)
  })

  it('operator sees the countdown while the code is live and the expiry state after the deadline', () => {
    // Given a code minted at t=1_000_000 with a 30 s window
    const state: PairPanelState = { kind: 'ready', token: 'Kq7xTt2m', issuedAt: 1_000_000, expiresAt: 1_030_000, origin: null, pairingUrl: null }
    // When the panel renders one second in, then one second past the deadline
    const live = mount(state, 1_001_000)
    expect(screen.getByText('剩余 29 秒')).toBeInstanceOf(HTMLElement)
    expect(live.querySelector('[data-dsh-part="qr"]')).toBeInstanceOf(HTMLElement)
    cleanup()
    const dead = mount(state, 1_031_000)
    // Then the live render counts down and the past-deadline render states the expiry outright
    expect(screen.getByText('配对码已过期（30 秒）')).toBeInstanceOf(HTMLElement)
    expect(dead.querySelector('[data-dsh-part="qr"]')).toBeInstanceOf(HTMLElement)
  })

  it('operator is told the phone origin is the public relay rather than this page', () => {
    // Given a live code on a page served from this machine's loopback address
    const container = mount({ kind: 'ready', token: 'Kq7xTt2m', issuedAt: 1_000_000, expiresAt: 1_030_000, origin: null, pairingUrl: null })
    // When the panel renders its notices
    const notices = [...container.querySelectorAll('[data-dsh-part="notice"]')].map(node => node.textContent ?? '')
    // Then one notice names the relay origin and says this page's host is unreachable from the phone
    const origin = notices.find(text => text.includes('wss://<id>.dsh-market.com')) ?? ''
    expect(origin).toContain(HOST)
    expect(origin).toContain('手机连不上')
  })

  it('operator on a page that is not this machine is told why no code appears', () => {
    // Given the loopback gate refused the read
    const container = mount({ kind: 'forbidden' })
    // When the panel renders that state
    const alert = container.querySelector('[data-dsh-part="notice"][role="alert"]')
    // Then it names the condition and offers no code
    expect(alert?.textContent).toContain('这个页面不是从本机打开的')
    expect(alert?.textContent).toContain('http://127.0.0.1:<端口>')
    expect(container.querySelector('[data-dsh-part="qr"]')).toBeNull()
  })

  it('operator sees an unexpected status and an unreachable host as their own states', () => {
    // Given a host route that answered 500 and a request that never arrived
    const failed = mount({ kind: 'failed', status: 500 })
    // When each state renders
    const failedText = failed.querySelector('[data-dsh-part="notice"]')?.textContent ?? ''
    cleanup()
    const unreachable = mount({ kind: 'unreachable' })
    const unreachableText = unreachable.querySelector('[data-dsh-part="notice"]')?.textContent ?? ''
    // Then neither is silent, and each names its own cause
    expect(failedText).toContain('宿主返回了 HTTP 500')
    expect(unreachableText).toContain('请求没有到达宿主')
  })

  it('operator on a machine that knows its public address gets a one-scan code', () => {
    // Given a host that located its relay origin and handed back the code for it
    const payload = JSON.stringify({ token: 'Kq7xTt2m', url: 'wss://abc.dsh-market.com/ios/v1?token=Kq7xTt2m' })
    const container = mount({
      kind: 'ready',
      token: 'Kq7xTt2m',
      issuedAt: 1_000_000,
      expiresAt: 1_030_000,
      origin: 'wss://abc.dsh-market.com',
      pairingUrl: payload,
    })
    // When the panel renders
    const shown = container.querySelector('[data-dsh-part="token"]')?.textContent ?? ''
    const qr = container.querySelector(`[${QR_VALUE_ATTR}]`)
    const notices = [...container.querySelectorAll('[data-dsh-part="notice"]')].map(node => node.textContent ?? '')
    // Then the QR carries the whole {token,url} document, the plaintext is the same
    // string so it can be pasted instead of scanned, and the notice says the address
    // travelled with the code instead of leaving it to the operator
    expect(qr?.getAttribute(QR_VALUE_ATTR)).toBe(payload)
    expect(shown).toContain(payload)
    expect(notices.some(text => text.includes('wss://abc.dsh-market.com') && text.includes('已写进二维码'))).toBe(true)
  })
})
