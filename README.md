# ENS Wind Tunnel web app — v0.7.0

Browser acquisition and control for the ENS wind tunnel, using desktop **Edge or Chrome** on the computer connected to the DAQ and Pitot USB cables. The existing React interface and control state machines run locally in the browser. No Electron, Python, LabVIEW, local server, or application installation is needed to use a deployed build.

**Use Disconnect before closing or reloading.** It requests acknowledged fan zero, stops acquisition, finalizes the recording, and releases both USB connections. Closing a tab cannot reliably finish asynchronous hardware cleanup. Physical VFD Stop and Pitot power cutoff remain available to the operator.

**Connecting the identified Pitot automatically homes X and Y.** Opening the website also attempts this when it already has permission for a single matching controller. Keep the mechanism clear. DAQ acquisition always requires an explicit connection.

The original desktop application is preserved on the `electron-app` branch at `f6b4492`; `main` is the browser application. Existing dated capture/commissioning/distribution documents describe the Electron releases and remain historical evidence.

## Connect and operate

1. Open the deployed site over HTTPS, or a local development build over localhost. Use the USB-connected computer; the website does not remotely control another computer's ports.
2. In **Hardware**, click **Choose DAQ device** and select the RP2350 DAQ in the browser's USB chooser. It filters USB **2E8A:F00F**. **Scan ports** lists devices already authorized for this site. `USB-1`, etc. are browser-session labels, not Windows COM numbers.
3. Select 115200 baud for the measured official board and click **Connect and read DAQ**. Binary measurements begin after an initial DAC-zero attempt. Missing DAC acknowledgment disables fan output while a healthy acquisition connection remains available.
4. In **Pitot**, click **Connect and home Pitot** to grant separate access to the CH340 controller (**1A86:7523**). Machine name, UUID, emergency parser, settings and endstops are verified before X/Y homing. DAQ and Pitot operate independently.
5. Use **Main**, **Pitot**, **Force Balance**, **Pressure graphs**, **Data Viewer**, **Pressure array**, **Calibration**, **Sessions**, and **Hardware** as in the desktop interface. Fan edits and Pitot arrows edit targets locally; **Apply** and **Move Pitot** send them.
6. Use **Record session** to record every received chunk and decoded scalar sample in persistent browser storage. **Stop recording** finalizes the run. **Sessions** lists saved runs and exports JSONL or CSV. The header's **Export CSV** exports the current/latest run.
7. Click the header's **Disconnect** before closing, reloading, unplugging, or switching control tabs. Wait for success. If fan zero is not acknowledged, the DAQ stays connected for a retry, the recording is finalized, and an error is shown. Use physical VFD Stop if zero cannot be verified. Recording-finalization failures are reported and can also be retried with Disconnect.

One browser tab owns USB control at a time. A second tab can view its own workspace and saved runs but cannot take over an active control session. After disconnect, another tab can connect. Browser/site USB policies and the operating system's device drivers still apply. A first USB permission grant requires an operator click; the app never bypasses the browser chooser.

The built application caches its UI for offline use after a successful online visit. Updates wait for existing tabs to close; they do not force a reload during a control session. Offline access still requires the same browser profile and previously cached assets.

## Recordings and calibration

Runs and calibrations belong to this website's origin, path, and browser profile. They are stored on the operating computer, not uploaded to GitHub. Normal reloads retain committed recordings and calibration. Clearing site data or using another browser/profile changes that local storage; export files to keep or share them.

Recordings use append-only IndexedDB chunks with atomic progress updates, bounded queues, and visible storage/quota failures. Disconnect waits for accepted records to commit. An interrupted tab may lose its most recent uncommitted batch; **Sessions** labels unfinalized runs and can recover their committed chunks. User-selected output files are streamed and finalized before success is reported. Existing nonempty export files are refused; choose a new filename.

JSONL retains schema version 1, hardware-source metadata, raw RX/TX bytes, raw/calibrated measurements, device and arrival timestamps, nonfinite-value tags, calibration versions, temperature changes and diagnostics. CSV retains the desktop's twelve columns:

```text
mode,channelId,raw,rawSpecial,value,unit,quality,deviceMicros,elapsedMicros,receivedAt,sequence,calibrationVersion
```

Use **Calibration → Import calibration JSON** while the DAQ is disconnected to migrate the desktop app's `hardware-calibrations.json`. Its usual Windows location is `%APPDATA%\ens-wind-tunnel\hardware-calibrations.json`. The browser cannot automatically read that directory. Export calibration JSON to back it up or transfer it. Imports are validated before saving; archived LabVIEW force curves are never activated automatically.

Calibration uses `reference = raw × scale + offset` and affects future samples only. Tare requires a fresh valid reading. Bridge inputs are raw counts until calibrated to N; the normal/axial channel assignments remain selectable because the older VI and manual disagree.

## Hardware behavior retained

- All **37 channels**: four bridges, four thermocouples, atmospheric pressure, four local differential pressures, and 24 backpack pressures. Literal zeros, signed pressures, NaN/Infinity identity, quality, timestamp rollover, and raw serial monitoring are preserved.
- Fan **0–100% → 0–3000 mV** before nominal ×3 amplification. Only explicit Apply sends a changed target, and exact board acknowledgment is required. This is a manual voltage reference, not calibrated airspeed or VFD run-state feedback. Only 0–5% was physically commissioned in the archived evidence.
- **Stop acquisition does not stop the fan.** Stop fan requests zero. Emergency Stop immediately blocks nonzero commands, requests DAC zero and sends Pitot `M112`; reset never restores output. USB/process/power failure cannot guarantee physical stopping.
- Pitot targets remain **X0–360/Y0–360 mm**, without swapping. X is horizontal and Y vertical. Each connection homes only X then Y. Homing persists across navigation and idle time; `M84 S0` retains holding torque. Moves use 300 mm/min in 5-mm end zones and 4000 mm/min in the interior, awaiting `M400` and matching `M114` per segment. Position is Marlin-reported/open loop. Stop requires a controller power cycle and reconnect/home. No EEPROM or firmware writes are performed.
- Airspeed retains separate Pitot/ring mappings (defaults `press1`/`press2`), manual room temperature, mph/m/s, two-second startup settling and a maximum two-second last-valid atmospheric hold. Differential pressure from −3 through zero Pa is clamped only for derived speed; lower, invalid or stale pressure suppresses it. Raw graphs and recordings are unchanged.
- UI snapshots publish at 10 Hz with bounded histories; recording receives every sample independently of the display. Source changes/reconnect clear display histories, and nonzero fan output is never restored.

The supplied SensorBoard source selects ASCII in `Defines.h`; the physical board and this app use its **binary** output branch. Do not reflash it for this port. Replies are a bank byte, little-endian float32 values, and a little-endian uint32 microsecond timestamp. Banks 02/03/04/05/06 have 4/4/1/4/24 values. D0/E0/E1-delimited diagnostics remain visible.

Host arguments are big-endian: acquisition starts with `01 00 01 86 A0`, stops with `00`, and DAC zero is `21 00 00`. Commands remain spaced by at least 250 ms because the firmware consumes pending bytes together. The wire protocol has no checksum; the app retains original evidence rather than claiming guaranteed resynchronization.

## Develop and verify

Use Node.js 24 and pnpm 11.25.0:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open the printed URL under `/wind-tunnel/`. Development tools are needed only on a build/development computer.

| Command         | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| `pnpm check`    | TypeScript, offline regressions, formatting                     |
| `pnpm build`    | Static production build plus offline asset cache in `dist/`     |
| `pnpm start`    | Preview the built site at localhost:4173/wind-tunnel/           |
| `pnpm test:e2e` | Browser workflows with injected native USB/file-picker fixtures |
| `pnpm format`   | Format application code, tests, configuration and README        |

Install Playwright's Chromium once for browser tests:

```powershell
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

To test an already-installed Edge browser on Windows:

```powershell
$env:WT_BROWSER_CHANNEL = 'msedge'
pnpm test:e2e
```

Tests inject native-API fixtures before the page starts. They use original captured board bytes through the production decoder, services, browser storage and UI, and never open physical hardware. No fixture/replay/simulation switch is included in the production build. Node filesystem adapters live only under `tests/support` for comparison with the desktop recording behavior.

`src/browser/runtime.ts` supplies the typed browser API and exclusive-tab ownership. `src/main/` retains the portable control state machines; its Electron entry was removed. `src/infrastructure/` implements Web Serial, persistent recording, settings and byte utilities. `src/domain` and `src/shared` retain protocol, calculation, validation and channel contracts. `src/renderer` retains the React interface.

## GitHub Pages

The repository workflow [pages.yml](.github/workflows/pages.yml) validates, builds and tests pushes to `main`, then publishes **only `dist/`** to GitHub Pages. Pull requests run the same validation without publishing. `electron-app` does not deploy this website.

In the GitHub repository, set **Settings → Pages → Build and deployment → Source → GitHub Actions**. Push the browser changes to `main`, then check the workflow's deployment result. The expected project address is [calebellishutchings.github.io/wind-tunnel/](https://calebellishutchings.github.io/wind-tunnel/); that address is live only after a successful deployment. Adding the workflow locally does not publish it.

The Vite base defaults to `/wind-tunnel/`. For a different repository path, set `WT_BASE_PATH` during build and update the test base URL accordingly. GitHub Pages serves static files; USB access, computation and storage execute in the visitor's browser. Captures, original firmware, tests and local recordings are excluded from the deployment artifact.
