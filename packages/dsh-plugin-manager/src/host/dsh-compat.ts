/**
 * The DSH runtime compatibility verdict for one declared plugin requirement,
 * evaluated the way the official boot gate evaluates it
 * (`evaluatePluginCompatibility` in app-boot's `plugin-compatibility.ts`):
 * the requirement is a node-semver range and the host satisfies it when
 * `semver.satisfies(host, range, { includePrerelease: true })` holds. Every
 * legal range form therefore decides: `||` alternatives, `^` and `~`,
 * whitespace-separated comparators, x-ranges, and prerelease tags compared as
 * ordinary versions.
 *
 * The requirement itself comes from `dshRequirementOf` in
 * `../core/version.ts`, which owns the field priority (this module only
 * decides the verdict). Host-only on purpose: `semver` is a node package and
 * must never be reachable from the browser half, which renders the same
 * declaration through the regex-only `displayMinimumVersion`.
 * @module @linxin666/dsh-client-ui-plugin-manager/host
 */

import semver from 'semver'

/**
 * Whether the running DSH host satisfies a declared requirement range.
 * @param host - the running DSH host version.
 * @param range - the declared requirement, in any node-semver range form.
 * @returns true / false, or undefined when the verdict cannot be verified: an
 * empty or whitespace-only declaration, a range node-semver does not parse, or
 * a host string that is not one valid version. Callers treat undefined as
 * "cannot verify" and fail closed for a declared requirement (issue #754).
 */
export function meetsMinimumDsh(host: string, range: string): boolean | undefined {
  // `semver.validRange('')` answers `'*'`, so an absent declaration would
  // otherwise read as an unconstrained range and become a satisfied verdict.
  // The official gate keeps the same `range.trim() !== ''` guard for the
  // same reason.
  if (range.trim() === '') return undefined
  if (semver.validRange(range) === null) return undefined
  // A host string that is not a single valid version is "cannot verify", not
  // "too old": `semver.satisfies` would silently answer false for it.
  if (semver.valid(host) === null) return undefined
  return semver.satisfies(host, range, { includePrerelease: true })
}
