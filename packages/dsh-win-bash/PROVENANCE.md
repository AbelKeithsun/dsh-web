# PROVENANCE - vendored bash runtime

This file records exactly what ships in `runtime/win32-x64/`, where it
came from, how it was reduced, and what licenses apply. Nothing here is
generated at install time: the payload is committed to the repository and
verified by SHA256 on every mount.

## Upstream

| Fact | Value |
| --- | --- |
| Project | Git for Windows (`git-for-windows/git`, the official upstream) |
| Release | `v2.56.0.windows.2` (latest stable, not a prerelease) |
| Published | 2026-10-05 |
| Asset | `MinGit-2.56.0.2-64-bit.zip` |
| Download URL | https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip |
| Source zip bytes | 39806486 |
| Source zip SHA256 | `da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be` |

MinGit is the upstream's own minimal, redistributable Git for Windows build. It
is extracted with the system `tar` (bsdtar reads zip); no patching, no
recompilation and no binary rewriting is performed on any file below.

## What ships

`runtime/win32-x64/` holds a CURATED subset of the MinGit tree - the payload
must be large enough to be a usable shell and small enough to belong to a
plugin package - plus the license texts the redistributed components require:

| Path | Contents |
| --- | --- |
| `usr/bin/bash.exe` | The upstream `usr/bin/sh.exe` byte-for-byte (upstream ships bash under both names; `bash.exe` is the name kept so the shell's own `$BASH` resolves to `/usr/bin/bash`) |
| `usr/bin/sh.exe` | The same bytes, kept under the upstream name |
| `usr/bin/*.exe` | The payload's userland: bash plus the shell/scripting/text helpers this tool promises |
| `usr/bin/msys-*.dll` | The MSYS2 runtime and exactly the DLL closure those executables import |
| `etc/` | The MSYS2 runtime configuration that makes the payload self-contained (see below) |
| `licenses/` | License texts for everything redistributed (see Licensing) |
| `checksums.sha256` | SHA256 of every other file in this directory, in `sha256sum -c` format |

### Payload inventory

| Fact | Value |
| --- | --- |
| Registered payload files | 89 |
| Payload bytes | 16769628 (15.99 MiB) |
| `usr/bin` regular files | 54 |
| `bash.exe` SHA256 | `5490d0da5e7cf9d92068cc48fcc590f2bcf8564add8ff91c3b5fe541eb2d72e3` |
| `bash.exe` bytes | 2449886 |
| `msys-2.0.dll` SHA256 | `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7` |
| Shell version | GNU bash 5.3.15(2)-release (x86_64-pc-cygwin) |

### Why the payload is curated rather than the whole MinGit tree

The full MinGit `usr/bin` carries a second, unrelated tool family (OpenSSH,
with the whole Heimdal/Kerberos/OpenSSL closure - about 9 MiB of `msys-*.dll`).
`ssh` is not what this plugin provides, and shipping it would put a
credential-bearing network client inside a DSH profile for no reason. The
vendored set is the shell plus its userland; anything else is reachable from
the session's own tools.

The excluded executables are exactly: `ssh.exe`, `ssh-add.exe`, `ssh-agent.exe`,
`rebase.exe`, `rebaseall`, `chattr.exe`, `lsattr.exe`, `getfacl.exe`,
`gencat.exe`, `getopt.exe`, `gmondump.exe`, `newgrp.exe`, `profiler.exe`,
`cygwin-console-helper.exe`, plus the DLLs only those import:
`msys-crypto-3`, `msys-asn1-8`, `msys-cbor-0.11`, `msys-com_err-1`, `msys-crypt-2`,
`msys-fido2-1`, `msys-gssapi-3`, `msys-hcrypto-4`, `msys-heimbase-1`, `msys-heimntlm-0`,
`msys-hx509-5`, `msys-krb5-26`, `msys-roken-18`, `msys-sqlite3-0`, `msys-wind-0` and `msys-z`.

The reduction was verified by PE-import analysis, not by guessing: the import
table of every kept executable was walked transitively, and every non-kept DLL
appears in no kept file's closure. The kept DLLs are exactly `msys-2.0`,
`msys-gcc_s-seh-1`, `msys-gmp-10`, `msys-iconv-2`, `msys-intl-8`, `msys-mpfr-6`,
`msys-ncursesw6`, `msys-pcre-1` and `msys-readline8`.

### Why `etc/` is part of the payload

The MSYS2 runtime resolves its own root from the executable's location. Two
files decide whether the payload is a self-contained userland or a shell that
resolves its tools against the host:

- `etc/fstab` declares the `usertemp` mount for `/tmp`. Without it, `/tmp` does
  not resolve and MSYS prints `bash.exe: warning: could not find /tmp,
  please create!` on every start, losing a working scratch directory.
- Everything else under `etc/` keeps the payload's own configuration
  (`profile`, `bash.bashrc`, `nsswitch.conf`, `msystem`, and the
  `msystem.d/` and `profile.d/` fragments) inside the package instead of
  inheriting whatever a host Git for Windows install left behind.

`etc/ssh` is deliberately NOT vendored: the payload ships no ssh client, so
its configuration would be dead weight.

### Payload integrity

- `runtime/win32-x64/checksums.sha256` registers every file in the directory
  except itself, in `sha256sum -c` format.
- The host half verifies the whole manifest BEFORE the tool is registered
  (`resolveRuntime` in `src/runtime.ts`). A mismatch refuses the mount with the
  first offending path; a tampered or half-installed payload never runs a
  model-authored command.
- The repository `.gitattributes` pins the payload's binaries (`*.exe`,
  `*.dll`) as `binary`, so a Windows checkout cannot rewrite the bytes the
  digests cover.

## Licensing

Git for Windows is a distribution of many upstream projects, and the parts of
it this package redistributes are licensed under GPL-2.0-or-later and
GPL-3.0-or-later among others. The corresponding texts ship with the payload
in `runtime/win32-x64/licenses/`, so the vendored binaries are never distributed
without their notices.

The Git for Windows umbrella license (`git-for-windows-LICENSE.txt`) is
reproduced verbatim from the upstream archive, together with every license
text that archive itself ships for the components below. For components whose
MSYS2 package ships no license text inside the MinGit archive (bash,
msys2-runtime, coreutils, sed, grep, gawk, findutils, diffutils and dash), the
canonical upstream text of the license named by the MSYS2 package is vendored
instead and listed as such.

| Vendored file | Applies to | License |
| --- | --- | --- |
| `git-for-windows-LICENSE.txt` | the Git for Windows distribution as a whole | GPL-2.0 |
| `GPL-3.0.txt` | bash, msys2-runtime (Cygwin), coreutils, sed, grep, gawk, findutils, diffutils | GPL-3.0-or-later |
| `GPL-2.0.txt` | dash, gmp, and the GPLv2 components of the distribution | GPL-2.0 |
| `LGPL-2.1.txt` | libiconv, libintl (gettext-runtime), libxcrypt | LGPL-2.1-or-later |
| `LGPL-3.0.txt` | mpfr, gmp (dual) | LGPL-3.0-or-later |
| `gcc-libs-RUNTIME.LIBRARY.EXCEPTION.txt` | libgcc_s (msys-gcc_s-seh-1.dll) | GCC Runtime Library Exception |
| `ncurses-LICENSE` | ncurses (msys-ncursesw6.dll) | MIT-style |
| `libpcre-LICENCE.txt` | PCRE1 (msys-pcre-1.dll) | BSD-3-Clause |
| `libiconv-COPYING.txt`, `libiconv-COPYING.LIB.txt` | libiconv (msys-iconv-2.dll) | LGPL-2.1-or-later |
| `gettext-runtime-COPYING.txt`, `gettext-runtime-COPYING.LIB.txt` | GNU gettext runtime (msys-intl-8.dll) | LGPL-2.1-or-later |
| `libffi-LICENSE.txt` | libffi | MIT |
| `expat-COPYING.txt` | Expat | MIT |
| `zlib-LICENSE` | zlib | Zlib |
| `libcbor-LICENSE.md` | libcbor | MIT |
| `libfido2-LICENSE.txt` | libfido2 | BSD-2-Clause |
| `heimdal-LICENSE.txt` | Heimdal | BSD-3-Clause |
| `libopenssl-LICENSE.txt` | OpenSSL | Apache-2.0 |
| `libsqlite-LICENSE` | SQLite | Public domain |
| `openssh-LICENCE.txt` | OpenSSH (carried because the MinGit archive ships it for the runtime family; no ssh client is vendored here) | BSD-style |

The package's own source code is Apache-2.0, matching the rest of this
repository. The vendored payload keeps its own licenses; the two do not mix,
which is why the payload sits in its own directory with its own `licenses/`
tree rather than being folded into the package's source.

## Reproducing this payload

1. Download the pinned asset from the URL above.
2. Verify its SHA256 against the value in the table.
3. Extract it with `tar -xf <zip> -C <dir>` (bsdtar handles zip).
4. Copy `usr/bin/*` EXCEPT the excluded names listed above, copy
   `usr/bin/sh.exe` to `usr/bin/bash.exe`, and copy `etc/` minus `etc/ssh`.
5. Copy the license texts into `licenses/`.
6. Regenerate `checksums.sha256` over the result.

A packaging-time verification script that performs steps 1-6 and checks the
result against a committed manifest is listed as follow-up work in the package
README; this file records what the committed payload IS.
