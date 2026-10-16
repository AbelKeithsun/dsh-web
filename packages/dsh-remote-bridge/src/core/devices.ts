/**
 * The paired-device roster: `$DSH_HOME/remote-bridge/devices.json`.
 *
 * What is stored is deliberately not a credential. Each row keeps the device's
 * public key, its fingerprint, and the SHA-256 of the bearer token it was
 * issued — never the token itself, so a leaked roster file grants nothing. The
 * directory is 0700 and the file 0600, written through a temporary file plus
 * rename, and a file that cannot be parsed is moved aside instead of being
 * silently treated as an empty roster (which would quietly un-pair every phone
 * and then overwrite the evidence on the next write).
 * @module dsh-remote-bridge/core/devices
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { base64UrlEncode, constantTimeEqualText, fingerprintOfSpki, isP256Spki, randomBase64Url, tokenHash } from './crypto.ts'

/** Entropy of one device bearer token. */
export const DEVICE_TOKEN_BYTES = 32
/** Entropy of one device id. */
export const DEVICE_ID_BYTES = 12
/** On-disk schema version of the roster file. */
export const ROSTER_VERSION = 1

/** One paired device as the bridge keeps it. */
export interface DeviceRecord {
  readonly deviceId: string
  /** base64url SPKI of the device's P-256 key. */
  readonly pubKey: string
  /** SHA-256 hex of the SPKI DER: the human-comparable identity of the device. */
  readonly fingerprint: string
  readonly createdAt: number
  readonly lastSeenAt: number
}

/** A roster row plus the one field that never leaves the file. */
interface StoredDevice extends DeviceRecord {
  readonly tokenHash: string
}

/** What one successful enrollment hands back to the caller exactly once. */
export interface EnrollmentResult {
  readonly deviceId: string
  /** The bearer token: returned to the enrolling connection and never persisted again. */
  readonly deviceToken: string
}

export interface DeviceRosterOptions {
  /** Absolute path of the roster file. */
  readonly file: string
  readonly now?: () => number
  readonly log?: (message: string) => void
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.deviceId === 'string' && row.deviceId !== ''
    && typeof row.pubKey === 'string' && row.pubKey !== ''
    && typeof row.fingerprint === 'string' && row.fingerprint !== ''
    && typeof row.tokenHash === 'string' && row.tokenHash !== ''
    && typeof row.createdAt === 'number'
    && typeof row.lastSeenAt === 'number'
}

/**
 * The persisted, revocable device roster.
 *
 * Revocation is a file edit: protocol v1 has no revoke method, so an operator
 * removes the row (or deletes the file) and restarts. The in-memory copy is
 * loaded once per process.
 */
export class DeviceRoster {
  readonly #file: string
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #devices = new Map<string, StoredDevice>()
  #loaded: Promise<void> | undefined

  constructor(options: DeviceRosterOptions) {
    this.#file = options.file
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => undefined)
  }

  /**
   * Read the roster once. A missing file is an empty roster; an unreadable or
   * malformed one is moved aside and reported, never silently zeroed.
   * @returns when the in-memory roster reflects the file.
   */
  load(): Promise<void> {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  /** @returns every paired device, without the token hash. */
  devices(): readonly DeviceRecord[] {
    return [...this.#devices.values()].map(({ tokenHash: _ignored, ...record }) => record)
  }

  /**
   * Resolve a bearer token to its device.
   * @returns the device, or undefined when the token is unknown.
   */
  authenticate(token: string): DeviceRecord | undefined {
    if (token === '') return undefined
    // The frozen design asks for a fixed-length comparison on the token path. A
    // Map lookup would compare the stored hash with the map's own early-exit
    // equality, so every row is compared instead — including after a match, so
    // the number of rows examined does not depend on which one matched. The
    // roster is a handful of phones, so the scan costs nothing.
    const presented = tokenHash(token)
    let matched: StoredDevice | undefined
    for (const row of this.#devices.values()) {
      if (constantTimeEqualText(row.tokenHash, presented)) matched = row
    }
    if (matched === undefined) return undefined
    const { tokenHash: _ignored, ...record } = matched
    return record
  }

  /**
   * Admit one device for a public key it has already proven possession of.
   * @param pubKey - base64url SPKI of the device's P-256 key.
   * @returns the enrollment, or undefined when the key is not an acceptable P-256 SPKI.
   */
  async enroll(pubKey: string): Promise<EnrollmentResult | undefined> {
    if (!isP256Spki(pubKey)) return undefined
    const fingerprint = fingerprintOfSpki(pubKey)
    if (fingerprint === undefined) return undefined
    const now = this.#now()
    const deviceId = `dev_${randomBase64Url(DEVICE_ID_BYTES)}`
    const token = base64UrlEncode(randomBytes(DEVICE_TOKEN_BYTES))
    this.#devices.set(tokenHash(token), { deviceId, pubKey, fingerprint, createdAt: now, lastSeenAt: now, tokenHash: tokenHash(token) })
    await this.#persist()
    return { deviceId, deviceToken: token }
  }

  /** Record that a device just reconnected; the file is refreshed at most once per call. */
  async touch(deviceId: string): Promise<void> {
    let touched: StoredDevice | undefined
    for (const row of this.#devices.values()) {
      if (row.deviceId !== deviceId) continue
      touched = { ...row, lastSeenAt: this.#now() }
      this.#devices.set(row.tokenHash, touched)
      break
    }
    if (touched !== undefined) await this.#persist()
  }

  async #read(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#log(`device roster ${this.#file} is unreadable (${String(error)}); continuing with an empty roster`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      await this.#quarantine('is not JSON')
      return
    }
    const rows = (parsed as { devices?: unknown } | null)?.devices
    if (!Array.isArray(rows) || !rows.every(isStoredDevice)) {
      await this.#quarantine('has no valid device table')
      return
    }
    for (const row of rows) this.#devices.set(row.tokenHash, row)
    this.#log(`device roster ${this.#file}: ${rows.length} paired device(s)`)
  }

  /** Move a corrupt roster aside so the failure survives and the next write cannot erase it. */
  async #quarantine(reason: string): Promise<void> {
    const target = `${this.#file}.corrupt-${this.#now()}`
    try {
      await rename(this.#file, target)
      this.#log(`device roster ${this.#file} ${reason}; moved to ${target} and starting empty`)
    } catch (error) {
      this.#log(`device roster ${this.#file} ${reason} and could not be moved aside (${String(error)}); starting empty`)
    }
  }

  /**
   * Write the roster atomically: same directory, 0600 from creation, flushed
   * before the rename so a crash cannot leave a truncated file in place.
   */
  async #persist(): Promise<void> {
    const directory = dirname(this.#file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ version: ROSTER_VERSION, devices: [...this.#devices.values()] }, null, 2)
    const temporary = `${this.#file}.${process.pid}.${randomBase64Url(6)}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.#file)
    // The mode is set at creation; the explicit chmod also covers a rename over
    // a pre-existing file with wider permissions.
    await chmod(this.#file, 0o600)
  }
}
