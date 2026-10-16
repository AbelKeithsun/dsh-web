// @vitest-environment jsdom
/**
 * The pairing seat's behavior: one read per open, mint-again, the 30 s expiry
 * flip, the copy action, and the two refusal states. The wire call and the
 * clipboard arrive as injected props (see src/client/index.ts), so these suites
 * drive real component state instead of patching a module or the global fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PairEntry } from '../src/client/PairEntry.tsx'
import type { PairTokenOutcome } from '../src/client/pair-token.ts'
import { zh, type RemoteBridgeKey } from '../src/client/locales.ts'

/** Translate stub over the zh dictionary, with {param} interpolation. */
function makeTranslate(): PropsLocale<'remote-bridge'>['t'] {
  return (key, params) => {
    let text: string = zh[key as RemoteBridgeKey] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

const t = makeTranslate()

/** A reader that answers the given codes in order, each with a 30 s window. */
function makeReader(tokens: readonly string[]) {
  let served = 0
  return {
    read: async (): Promise<PairTokenOutcome> => {
      const token = tokens[Math.min(served, tokens.length - 1)] ?? ''
      served += 1
      return { kind: 'ok', token, expiresAt: Date.now() + 30_000 }
    },
    served: () => served,
  }
}

/** A clipboard that records what it was handed and reports success. */
function makeCopier() {
  const written: string[] = []
  return {
    copy: async (text: string): Promise<boolean> => {
      written.push(text)
      return true
    },
    written,
  }
}

/** Mount the seat and open the panel. */
async function open(readPairToken: () => Promise<PairTokenOutcome>, copy: (text: string) => Promise<boolean>) {
  return {
    reader: render(<PairEntry wide read={readPairToken} copy={copy} t={t} />),
    trigger: await act(async () => fireEvent.click(screen.getByRole('button', { name: zh['entry.label'] }))),
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('protocol v1 pairing seat', () => {
  it('operator opens the seat and one live code appears in the symbol and the code row', async () => {
    // Given a footer seat whose reader answers one code
    const reader = makeReader(['token-one'])
    await open(reader.read, makeCopier().copy)
    // When the panel has settled
    // Then that one code is on screen, exactly once, and the seat read once
    expect(reader.served()).toBe(1)
    expect(screen.getByText('token-one')).toBeInstanceOf(HTMLElement)
    expect(document.querySelector('[data-dsh-part="qr"]')?.getAttribute('data-dsh-qr-value')).toBe('token-one')
  })

  it('operator asks for a new code and only the new one stays on screen', async () => {
    // Given an open panel holding the first code
    const reader = makeReader(['token-one', 'token-two'])
    await open(reader.read, makeCopier().copy)
    expect(screen.getByText('token-one')).toBeInstanceOf(HTMLElement)
    // When the operator presses the mint-again action
    await act(async () => fireEvent.click(screen.getByRole('button', { name: zh['pair.refresh'] })))
    // Then a second read happened and the previous code is gone
    expect(reader.served()).toBe(2)
    expect(screen.getByText('token-two')).toBeInstanceOf(HTMLElement)
    expect(screen.queryByText('token-one')).toBeNull()
  })

  it('operator leaves the panel past the deadline and the code reads as expired', async () => {
    // Given a live countdown on a 30 s code
    vi.useFakeTimers()
    const reader = makeReader(['token-one'])
    await open(reader.read, makeCopier().copy)
    expect(screen.getByText('剩余 30 秒')).toBeInstanceOf(HTMLElement)
    // When the clock passes the deadline
    await act(async () => { vi.advanceTimersByTime(31_000) })
    // Then the expiry state is on screen instead of a countdown
    expect(screen.getByText('配对码已过期（30 秒）')).toBeInstanceOf(HTMLElement)
    expect(screen.queryByText('剩余 30 秒')).toBeNull()
  })

  it('operator copies the code and the panel confirms it', async () => {
    // Given an open panel holding a code
    const reader = makeReader(['token-one'])
    const clipboard = makeCopier()
    await open(reader.read, clipboard.copy)
    // When the operator presses copy
    await act(async () => fireEvent.click(screen.getByRole('button', { name: zh['action.copy'] })))
    // Then the clipboard got that exact code and the button says so
    expect(clipboard.written).toEqual(['token-one'])
    expect(screen.getByText(zh['action.copied'])).toBeInstanceOf(HTMLElement)
  })

  it('operator on a page that is not this machine sees the refusal and no retry action', async () => {
    // Given a page the loopback gate refuses
    const read = async (): Promise<PairTokenOutcome> => ({ kind: 'forbidden' })
    await open(read, makeCopier().copy)
    // When the panel settled on that answer
    // Then the refusal is stated, no code is shown, and minting again is not offered
    expect(screen.getByText(zh['forbidden.title'])).toBeInstanceOf(HTMLElement)
    expect(document.querySelector('[data-dsh-part="qr"]')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['pair.refresh'] })).toBeNull()
  })

  it('operator whose host never answered sees the unreachable state and can retry', async () => {
    // Given a page that cannot reach its host
    const read = async (): Promise<PairTokenOutcome> => ({ kind: 'unreachable' })
    await open(read, makeCopier().copy)
    // When the panel settled on that answer
    // Then the network failure is named rather than swallowed, and a retry is offered
    expect(screen.getByText(zh['unreachable.title'])).toBeInstanceOf(HTMLElement)
    expect(screen.getByRole('button', { name: zh['pair.refresh'] })).toBeInstanceOf(HTMLElement)
  })
})
