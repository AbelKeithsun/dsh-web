/**
 * Chrome discovery and port selection: the two things that decide whether a
 * launch can even begin, plus the cleanup rule that must never follow a link
 * out of the profile directory.
 */

import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHROME_INSTALL_CANDIDATES,
  CHROME_PATH_ENV,
  ChromeProcess,
  chromeLaunchArgs,
  chromePathCandidates,
  pickFreePort,
  removeTempProfile,
  resolveChromePath,
} from '../../src/core/chrome.ts'

describe('chrome path candidates', () => {
  it('operator sets CHROME_PATH and the override leads the candidate list', () => {
    // Given the CHROME_PATH variable naming one binary
    // When discovery builds its candidate list
    // Then the override is the first candidate
    const candidates = chromePathCandidates({ [CHROME_PATH_ENV]: 'D:\\tools\\chrome.exe' })
    expect(candidates[0]).toBe('D:\\tools\\chrome.exe')
  })

  it('operator sets a blank CHROME_PATH and discovery falls back to the install locations', () => {
    // Given CHROME_PATH set to whitespace
    // When discovery builds its candidate list
    // Then the first candidate is the first install location and no empty string is listed
    const candidates = chromePathCandidates({ [CHROME_PATH_ENV]: '   ' })
    expect(candidates[0]).toBe(CHROME_INSTALL_CANDIDATES[0])
    expect(candidates).not.toContain('')
  })

  it('operator runs without an override and the Windows install locations are probed', () => {
    // Given an environment without CHROME_PATH
    // When discovery builds its candidate list
    // Then the Program Files install location is among the candidates
    const candidates = chromePathCandidates({})
    expect(candidates).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })
})

describe('resolveChromePath', () => {
  it('operator has Chrome in a default location and discovery returns that exact path', () => {
    // Given a probe that reports only the second install location as a file
    // When the path is resolved
    // Then that exact path is returned
    const target = CHROME_INSTALL_CANDIDATES[1]
    const found = resolveChromePath({ env: {}, isFile: path => path === target })
    expect(found).toBe(target)
  })

  it('operator has both an override and an installed binary and the override wins', () => {
    // Given both the override and the first install location exist
    // When the path is resolved
    // Then the returned path is the override
    const override = 'D:\\tools\\chrome.exe'
    const found = resolveChromePath({
      env: { [CHROME_PATH_ENV]: override },
      isFile: path => path === override || path === CHROME_INSTALL_CANDIDATES[0],
    })
    expect(found).toBe(override)
  })

  it('operator has no Chrome installed and discovery reports no path', () => {
    // Given a probe that finds nothing on disk
    // When the path is resolved
    // Then the result is undefined
    expect(resolveChromePath({ env: {}, isFile: () => false })).toBeUndefined()
  })

  it('operator launches without Chrome installed and the failure names the probed paths', async () => {
    // Given no Chrome binary and no override on the machine
    // When a launch is attempted
    // Then it rejects with a message naming CHROME_PATH and the probed Program Files paths
    await expect(ChromeProcess.launch({ discovery: { env: {}, isFile: () => false } }))
      .rejects.toThrow(/No Chrome binary found.*CHROME_PATH.*Program Files/)
  })
})

describe('pickFreePort', () => {
  it('operator asks for a free port and the returned one binds immediately', async () => {
    // Given no server bound to an ephemeral port
    // When a free port is picked and then bound
    // Then the port is in range and the bind succeeds
    const port = await pickFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65_536)
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })

  it('operator asks for two ports in a row and never receives the same number twice', async () => {
    // Given a port already handed out
    // When a second free port is picked
    // Then it differs from the first and is still in range
    const first = await pickFreePort()
    const second = await pickFreePort()
    expect(second).toBeGreaterThan(0)
    expect(first).not.toBe(second)
  })
})

describe('chromeLaunchArgs', () => {
  it('operator launches headless and the args carry a private profile and pinned window size', () => {
    // Given a headless launch with a private profile and a 1280x800 viewport
    // When the launch args are built
    // Then they carry headless=new, the debug port, the profile dir, the window size and end with about:blank
    const args = chromeLaunchArgs({
      port: 9222,
      userDataDir: 'C:\\temp\\profile',
      headless: true,
      viewport: { width: 1280, height: 800 },
    })
    expect(args).toContain('--headless=new')
    expect(args).toContain('--remote-debugging-port=9222')
    expect(args).toContain('--user-data-dir=C:\\temp\\profile')
    expect(args).toContain('--window-size=1280,800')
    expect(args.at(-1)).toBe('about:blank')
  })

  it('operator asks for headful with extra switches and headless is omitted while the extras come last', () => {
    // Given a headful launch with one extra switch
    // When the launch args are built
    // Then no headless switch appears and the extra switch is last
    const args = chromeLaunchArgs({
      port: 9223,
      userDataDir: 'C:\\temp\\profile',
      headless: false,
      viewport: { width: 800, height: 600 },
      extraArgs: ['--lang=en-US'],
    })
    expect(args.some(arg => arg.startsWith('--headless'))).toBe(false)
    expect(args.at(-1)).toBe('--lang=en-US')
  })
})

describe('removeTempProfile', () => {
  it('operator disposes a launch and the nested profile directory is gone', async () => {
    // Given a profile directory holding a nested cache and a Local State file
    // When the profile is removed
    // Then the directory no longer exists
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bv-clean-'))
    await mkdir(join(dir, 'Default', 'Cache'), { recursive: true })
    await writeFile(join(dir, 'Default', 'Cache', 'data.bin'), 'x', 'utf8')
    await writeFile(join(dir, 'Local State'), '{}', 'utf8')

    await removeTempProfile(dir)

    await expect(stat(dir)).rejects.toThrow()
  })

  it('operator disposes a profile that holds a junction and the linked tree survives', async () => {
    // Given a profile directory holding a junction to a tree outside it
    // When the profile is removed
    // Then the linked tree still holds its file and the profile root is gone
    const outside = await mkdtemp(join(tmpdir(), 'dsh-bv-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
    const inside = await mkdtemp(join(tmpdir(), 'dsh-bv-inside-'))
    await symlink(outside, join(inside, 'linked'), 'junction')

    await removeTempProfile(inside)

    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    await expect(stat(inside)).rejects.toThrow()
    await removeTempProfile(outside)
  })

  it('operator disposes a path outside the OS temp directory and nothing is touched', async () => {
    // Given a path that resolves outside the OS temp directory
    // When the profile is removed
    // Then the marker file outside survives untouched
    // Resolving ".." takes this path out of the temp root, which is exactly the
    // mis-resolved case the guard exists for: it must return without touching
    // anything.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bv-guard-'))
    const outside = join(tmpdir(), '..', 'dsh-bv-guard-escape')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'marker.txt'), 'keep', 'utf8')

    await removeTempProfile(outside)

    expect(await readFile(join(outside, 'marker.txt'), 'utf8')).toBe('keep')
    // Named deletes only, never a recursive removal: the marker file, the now
    // empty directory, the temp directory this test created.
    const { unlink, rmdir } = await import('node:fs/promises')
    await unlink(join(outside, 'marker.txt'))
    await rmdir(outside)
    await removeTempProfile(dir)
  })
})
