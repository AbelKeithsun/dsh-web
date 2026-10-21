/**
 * Run lookup and run-status copy for the agents page.
 *
 * The wire carries a flat run list; the page only ever needs the newest run of
 * one member, so this module owns that reduction and the label each status
 * reads as - the member card and the page share it, and neither re-derives it.
 */
import { t } from './locales.ts'
import type { RunRecord } from '../protocol.ts'

/**
 * The newest run of one member, or undefined when it never ran.
 * @param runs - every run the Host published.
 * @param teamId - squad the member belongs to.
 * @param memberId - the member.
 */
export function latestRunFor(runs: readonly RunRecord[], teamId: string, memberId: string): RunRecord | undefined {
  let latest: RunRecord | undefined
  for (const run of runs) {
    if (run.teamId !== teamId || run.memberId !== memberId) continue
    if (latest === undefined || run.createdAt >= latest.createdAt) latest = run
  }
  return latest
}

/** The localized state of one run. */
export function runStatusLabel(run: RunRecord): string {
  if (run.status === 'settled') return t('member.status.settled')
  if (run.status === 'failed') return t('member.status.failed')
  return t('member.status.running')
}
