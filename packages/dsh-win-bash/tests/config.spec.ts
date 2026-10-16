/**
 * Plugin configuration: what a profile row may supply and what happens when
 * it supplies something the shell's budgets cannot honor.
 */
import { describe, expect, it } from 'vitest'
import {
  CONFIG_DEFAULTS,
  DEFAULT_SYNC_WITH_LIANGSHEN,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  resolveConfig,
  validateConfig,
} from '../src/config.ts'

describe('configuration resolution', () => {
  it('operator mounting the row with no config block gets every default', () => {
    // Given a profile row that supplies no config,
    // When the config is resolved,
    const config = resolveConfig(undefined)
    // Then the tool runs with the documented defaults.
    expect(config).toEqual(CONFIG_DEFAULTS)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it('operator overriding one field gets that field and the defaults for the rest', () => {
    // Given a row that sets only the stdout budget,
    // When the config is resolved,
    const config = resolveConfig({ maxStdoutBytes: 4096 })
    // Then the override lands and every other field keeps its default.
    expect(config.maxStdoutBytes).toBe(4096)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(config.description).toBe(CONFIG_DEFAULTS.description)
  })

  it('operator supplying a description gets it used as the model-facing text', () => {
    // Given a row that replaces the tool description,
    // When the config is resolved,
    const config = resolveConfig({ description: 'Run this project shell command.' })
    // Then the replacement is what the tool advertises.
    expect(config.description).toBe('Run this project shell command.')
  })

  it('operator mounting the shipped default gets the LiangShen availability gate on', () => {
    // Given a profile row that supplies no config,
    // When the config is resolved,
    const config = resolveConfig(undefined)
    // Then the gate ships ON: win_bash follows the preset by default, and the
    // escape hatch is a deliberate opt-out rather than the shipped state.
    expect(config.syncWithLiangShen).toBe(DEFAULT_SYNC_WITH_LIANGSHEN)
    expect(config.syncWithLiangShen).toBe(true)
  })

  it('operator turning the escape hatch off gets that value through to the running config', () => {
    // Given a row that opts out of the availability gate,
    // When the config is resolved,
    const config = resolveConfig({ syncWithLiangShen: false })
    // Then the opt-out survives resolution, so the entry skips the gate.
    expect(config.syncWithLiangShen).toBe(false)
    // And every other field keeps its default.
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })
})

describe('configuration rejection', () => {
  it('operator supplying a timeout below the floor gets a rejection naming the field and the range', () => {
    // Given a row whose timeout is below the accepted minimum,
    let message = ''
    // When the config is resolved,
    try {
      resolveConfig({ timeoutMs: TIMEOUT_MIN_MS - 1 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // Then the rejection names the field and states the accepted range.
    expect(message).toContain('timeoutMs')
    expect(message).toContain(TIMEOUT_MIN_MS.toString())
    expect(message).toContain(TIMEOUT_MAX_MS.toString())
  })

  it('operator supplying a fractional budget gets a rejection, because a NaN budget truncates everything', () => {
    // Given a row whose stdout budget is not a whole number,
    let message = ''
    // When the config is resolved,
    try {
      resolveConfig({ maxStdoutBytes: 1024.5 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // Then the violation names the offending field.
    expect(message).toContain('maxStdoutBytes')
  })

  it('operator supplying an empty description gets a rejection', () => {
    // Given a row whose description is blank,
    const violations = validateConfig({ ...CONFIG_DEFAULTS, description: '   ' })
    // When the config is validated,
    // Then the description field is the one rejected.
    expect(violations).toEqual([{ field: 'description', message: 'must be a non-empty string' }])
  })

  it('operator supplying an out-of-range value for every bounded field gets one violation each', () => {
    // Given a config whose three numeric fields are all outside their ranges,
    const violations = validateConfig({
      ...CONFIG_DEFAULTS,
      timeoutMs: 0,
      maxStdoutBytes: Number.MAX_SAFE_INTEGER,
      maxStderrBytes: -1,
    })
    // When the config is validated,
    // Then each offending field is reported separately.
    expect(violations.map(v => v.field)).toEqual(['timeoutMs', 'maxStdoutBytes', 'maxStderrBytes'])
  })

  it('operator supplying a non-boolean sync switch gets a rejection naming the field', () => {
    // Given a row whose sync switch is not a boolean,
    // When the config is validated,
    const violations = validateConfig({ ...CONFIG_DEFAULTS, syncWithLiangShen: 'yes' as unknown as boolean })
    // Then the offending field is named, so an operator can fix the row.
    expect(violations).toEqual([{ field: 'syncWithLiangShen', message: 'must be a boolean' }])
  })

  it('operator supplying a valid maximum gets acceptance rather than an off-by-one rejection', () => {
    // Given a config sitting exactly on each upper bound,
    const violations = validateConfig({
      ...CONFIG_DEFAULTS,
      timeoutMs: TIMEOUT_MAX_MS,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 512 * 1024,
    })
    // When it is validated,
    // Then the bounds are inclusive.
    expect(violations).toEqual([])
  })
})
