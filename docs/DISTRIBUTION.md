# Historical Windows distribution — Electron v0.6.2

`main` now builds the browser application. See [the current README](../README.md#github-pages) for GitHub Pages deployment and browser operation. The installer workflow below belongs to the preserved `electron-app` branch and is retained as historical evidence.

## Installing on another computer

Copy **only `distribution/ENS-Wind-Tunnel-Setup-0.6.2.exe`** to the destination computer and double-click it normally. It installs into the current Windows user's Programs folder and creates Desktop/Start menu shortcuts plus a Windows uninstall entry. Administrator membership is not required and setup never requests elevation. Do not use Run as administrator.

One setup EXE contains native **x64 and ARM64** applications; setup selects the appropriate payload. Windows 11 is the target. There is no Windows-11-only version gate, so Windows 10 can install, but it is unsupported and untested. 32-bit Windows is not supported. Organization policies can still forbid running user-installed or unsigned applications; this installer cannot override those policies.

The installer is self-contained and works offline. **Electron, Chromium, Node.js, the application and the native serial-port module are included.** No Node.js, pnpm, Python, LabVIEW, .NET, WebView2 or Visual Studio installation is needed on the destination computer. There are no additional application frameworks to fetch online. Build tools download the pinned Electron runtimes and NSIS resources from their upstream sources when the developer's cache is empty, then embed the needed components in the EXE.

USB drivers are separate from application runtimes. Windows normally supplies the DAQ's USB CDC serial driver. The Ender controller's CH340 driver may come from Windows Update. If a device does not get a COM port, check Device Manager / Windows Update or ask IT. Installing a missing kernel driver or changing managed-computer policy can require administrator approval. Setup neither installs unsigned drivers nor bypasses Windows permissions.

Close the control app normally before installing/updating/removing it. Setup refuses to proceed if an ENS Wind Tunnel process is running, including during silent installation; it never kills that process. **Setup does not launch the app after installation.** Start it from a shortcut when the rig is ready, because launching the application automatically homes the connected Pitot mechanism.

Updates reuse the stable application ID and per-user installation. Run a newer Setup EXE normally. Calibration/settings live in the Windows user profile, outside the installation directory, and are retained on update/uninstall. Recordings saved outside the app directory are retained. Use Windows Settings → Apps → Installed apps to uninstall. Application data is normally under `%APPDATA%\ens-wind-tunnel`; installation is normally under `%LOCALAPPDATA%\Programs\ens-wind-tunnel` (Windows known-folder redirection can change the root).

The setup EXE is currently **unsigned**. Windows may show an Unknown publisher/SmartScreen prompt. A trusted signing certificate can be added later; no certificate or publishing credentials are assumed here. Share the EXE through a trusted team location and optionally supply `SHA256SUMS.txt` so recipients can compare `Get-FileHash` results.

## Windows blocks setup before installation

On November 21 a destination computer reported "Windows cannot access the specified device, path, or file" after starting Setup transferred by flash drive. A normal-user event-log query subsequently confirmed Defender ASR blocks against `Downloads\ENS-Wind-Tunnel-Setup-0.6.2.exe`, launched by Explorer:

| Rule GUID                              | Confirmed policy block                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `01443614-cd74-433a-b99e-2ecdc07bfc25` | The executable did not meet the configured reputation/age/trust criteria; blocked at 10:18:16 and 10:20:38 local time. |
| `b2b3f03d-6a65-4f7b-a9c7-1c7ef74a9ba4` | Untrusted/unsigned USB-origin code; blocked at 10:18:16 local time.                                                    |

Both rules fired against the setup EXE before installation. These events establish the cause of the reported launch denial; they do not show an Electron startup or DAQ/Pitot error and do not establish a malware detection. The source installer still matches the published SHA-256 and remains unsigned. No new installer, security-policy change or firmware change was made in response. The authorized IT review needs to address **both** policies. Signing may be part of the approved deployment solution, but is not by itself a guarantee that the reputation rule will allow the release.

Defender can block unsigned/unknown executables independently of whether setup requests elevation. Its USB execution rule can also apply after a file has been copied from USB to disk, so copying, renaming, or rebuilding is not a confirmed solution. See [Microsoft's ASR reference](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-rules-reference#block-untrusted-and-unsigned-processes-that-run-from-usb). The separate Smart App Control feature can also block untrusted unsigned code; see [Microsoft's explanation](https://support.microsoft.com/en-gb/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions). A generic risk notification alone does not identify either mechanism.

To obtain the actual ASR rule and affected path, the destination user can try this **read-only** query in ordinary Windows PowerShell shortly after the failed launch:

```powershell
Get-WinEvent -FilterHashtable @{
  LogName = 'Microsoft-Windows-Windows Defender/Operational'
  Id = 1121
  StartTime = (Get-Date).AddHours(-1)
} -MaxEvents 5 | Format-List TimeCreated, Id, Message
```

Permissions vary. If access is denied, an authorized administrator/IT must collect it; if no events match, it does not establish an ASR block. Other useful logs are CodeIntegrity/Operational (3077) and AppLocker/EXE and DLL (8004). Microsoft documents [Defender block events](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-windows-events), [App Control events](https://learn.microsoft.com/en-us/defender-endpoint/app-control-for-business/operations/event-id-explanations) and [AppLocker events](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/windows-defender-application-control/applocker/using-event-viewer-with-applocker).

Give IT the release manifest/checksum and request review of the **specific** blocked installer or extracted component under the organization's normal approval process. For v0.6.2 the installer is 219,913,146 bytes with SHA-256 `7f7a23c1e9eb812688c208378d53fe947884ffdaec50f4b570c4891457759678`. Reliable wider distribution may require an approved signing identity and/or an IT-managed deployment/allow rule. Signing needs to cover the components identified by the block, not merely change the EXE's name. The per-user installer cannot grant itself trust. Do not turn off Defender/Smart App Control or grant broad folder exclusions as a troubleshooting step.

## Building a distribution release

Use the existing development computer. Double-click **Build Installer.cmd** in the parent folder, or run:

```powershell
pnpm dist
```

This is an explicit release operation. **`pnpm dev`, `pnpm build`, and `pnpm package` do not build an installer.** Keep using the normal development flow between distribution releases. The first installer build may download Electron/NSIS resources; subsequent builds reuse those caches. No release is uploaded or published automatically.

The release script defaults to 7-Zip compression level 3 to keep packaging quick. This trades a somewhat larger setup EXE for less build time. Set `ELECTRON_BUILDER_COMPRESSION_LEVEL=9` before the build only if a smaller download is more important than compression time; no application behavior changes.

The release command typechecks, runs offline unit tests, compiles the app, creates both architecture payloads and the combined NSIS EXE, writes SHA-256/manifest/install instructions, then statically checks the embedded payloads, runtime versions, build matches and `asInvoker` manifests. It writes into **`distribution/`**, leaving the existing `release/win-unpacked` development launcher and any running copy untouched. Build tools are invoked by their installed Node entry points, without depending on a globally installed electron-builder or NSIS.

Important output:

| File                                   | Purpose                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `ENS-Wind-Tunnel-Setup-<version>.exe`  | The single file recipients need                                    |
| `INSTALL.txt`                          | Short user instructions, optional to share                         |
| `SHA256SUMS.txt`                       | Integrity checksum for that release                                |
| `release-manifest.json`                | Version, timestamp, architectures, file size and hash              |
| `verification.json`                    | Static artifact verification results                               |
| `win-unpacked/`, `win-arm64-unpacked/` | Developer inspection/testing only; do not send the whole directory |

For the next release, increment `package.json`'s version and the displayed version in `src/renderer/src/App.tsx`, then run the release command. Keep the app ID and package name unchanged so installations/settings remain associated. The installer name includes the version; release outputs are excluded from source control. Copy a release to a separate archive/distribution location before building the next version, since the checksum/manifest files describe the most recently built release.

On a newly configured **build computer** only, install Node.js 24 LTS and pnpm 11.25.0, then:

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm dist
```

These are developer prerequisites, not prerequisites for people running Setup. No compiler toolchain is required with the supplied Windows N-API serial-port prebuilds. `scripts/build-installer.cjs`, `scripts/release-manifest.cjs`, `scripts/verify-distribution.cjs`, `build/installer.nsh` and `package.json` are the release implementation.

## Verification and limitations

Run desktop regression tests against the new x64 payload without opening hardware:

```powershell
$env:WT_TEST_EXECUTABLE = (Resolve-Path 'distribution/win-unpacked/ENS Wind Tunnel.exe').Path
pnpm test:e2e
```

The tests explicitly disable real startup Pitot discovery and inject serial fixtures. Artifact verification can be repeated without running Setup:

```powershell
node scripts/verify-distribution.cjs
```

Native ARM64 execution and Windows 10 need separate machines for runtime validation. Before distributing widely, test fresh installation, reinstall/update, shortcut launch, calibration preservation and uninstall on a Windows 11 standard-user account or clean VM. The installer has not been installed on this development computer because the operator requested keeping the running tunnel application undisturbed. No installation/upgrade/uninstall success on a clean computer is claimed by static artifact checks.
