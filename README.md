# ENS Wind Tunnel desktop app — v0.6.2

Electron acquisition software for the RP2350 DAQ, configured for binary firmware output, with a separate Marlin Pitot controller. DAQ acquisition starts disconnected. **On application startup, the connected, identified Pitot controller automatically homes X and Y. Keep the mechanism clear before launching.** No simulated measurements or motion are generated.

## Run the built application

For another Windows computer, use the single **`distribution/ENS-Wind-Tunnel-Setup-0.6.2.exe`** installer. It installs for the current user without administrator rights and includes all application runtimes; it also works offline. Windows 11 is the target, Windows 10 is allowed but unsupported. Native x64 and ARM64 payloads are included. Hardware drivers or organization restrictions may still need IT approval. Setup creates shortcuts but does not launch the app or close a running copy. See [installation and distribution](docs/DISTRIBUTION.md).

Double-click **Start Wind Tunnel.cmd** in the parent folder. It launches `release/win-unpacked/ENS Wind Tunnel.exe` with its bundled runtime; Node.js is not required to run the packaged application.

1. The app opens on **Main**, with no generated measurements. Open **Hardware** and scan ports if needed. A single matching DAQ is suggested by USB identity **2E8A:F00F**, not a saved COM number.
2. Confirm the DAQ port and baud (115200 for the measured official board), then click **Connect and read DAQ**. Binary output is fixed; there is no ASCII/Auto or simulation selector.
3. **Main** shows separate central-ring and Pitot airspeed estimates and their history. **Pressure graphs** offers individual or all 29 pressure channels; **Pressure array** selects all 24 array sensors; **Data Viewer** includes all 37 channel slots. Choose overlaid plots grouped by unit or separate sensor plots. Literal zeros and NaNs are preserved. Raw plots use original board values, including raw bridge counts.
4. **Stop acquisition** and **Start acquisition** control sensor sampling. **Record session** creates a new JSONL log; stop recording before exporting CSV.
5. **Disconnect DAQ** stops acquisition and releases the port. USB loss marks existing values stale and stops recording. Reconnecting clears the measurement session and display history.

Acquisition, recording, calibration and manual fan output require a connected DAQ. Its transport rejects other USB identities before opening a port. The Pitot uses an independent serial owner and does not require the DAQ to be connected. No firmware changes, uploads or EEPROM writes are performed.

## Operator interface

The **Fan output** dial is a manual percentage reference: **0% = 0 V, 5% = 0.150 V, 50% = 1.500 V, 100% = 3.000 V** at the DAC, before amplification. Dragging the dial or editing the number only changes the requested value; click **Apply** to send it. The app shows the board-confirmed DAC output separately and requires the exact firmware acknowledgment. This is not measured fan speed or calibrated mph. The nominal amplifier gain is three, so 100% corresponds to approximately 9 V at the VFD reference. Only the brief 0–150 mV commissioning test has been physically exercised; the user observed the fan turn on. The wider range is software-tested, not physically commissioned.

**DAQ connection is independent of VFD run readiness.** Startup attempts DAC zero, but a missing DAC acknowledgment leaves fan output unavailable while sensor acquisition and recording remain connected. Actual USB/serial failure still reports a connection error.

The dial and Apply are available directly when the DAQ is connected, DAC zero is verified and Emergency Stop is clear. There is no Rev Run confirmation box, popup or manual readiness gate. The DAQ protocol supplies no VFD run-state feedback; use the VFD's physical Run/Stop controls normally. DAC acknowledgments and measured airflow do not establish run state.

**Stop fan (0%)** requests acknowledged zero and can retry zero after a DAC acknowledgment failure; stopping acquisition alone does not change fan output. Disconnect and normal application exit request acknowledged zero before releasing the port. Nonzero requests are never restored on reconnect. A missing nonzero acknowledgment latches the stop state and attempts zero while leaving a healthy DAQ connection intact. USB loss or a process crash cannot guarantee zero or physical stopping; keep the VFD's physical Run/Stop controls available.

The **Pitot** page and compact Main controls show connection, homing and completed controller position. Startup finds a single CH340 candidate (USB 1A86:7523, currently COM14), then verifies Marlin's machine name, UUID and emergency-parser support before any homing. Every new connection restores the original captured runtime motion limits and completes `G28 X`, `G28 Y`, `M400` and a zero `M114` check before movement becomes available. **Home Pitot** repeats that sequence. `G28` without explicit axes is never sent, avoiding the unused Z axis.

Targets and arrow buttons edit locally; **Move Pitot** sends the selected target and waits for `M400` and matching `M114`. Both axes accept **0–360 mm**, with no axis swap. The controller reported native X360/Y400, while LabVIEW's displayed axes were reported as X400/Y360; the operator chose 360 mm for both until the larger rail is identified. Firmware software endstops remain enabled and unchanged. X is horizontal and Y vertical, as observed during November 19 homing. Marlin reports an open-loop coordinate, not an encoder-measured location.

**Homing persists for the connection.** Idle time, snapshots and navigation between Main/Pitot do not invalidate it or send a Home command. The app sets the runtime stepper inactivity timeout to zero (`M84 S0`) so idle motors retain holding torque after homing. There is no periodic rehoming requirement. Disconnect/reconnect, controller reset/error, stop, failed motion or loss of position validity require homing again. Home Pitot remains available on demand. Holding remains configured in RAM until the controller is restarted; the app does not release the vertical carriage on disconnect.

Moves follow the requested straight line with a **5 mm end zone**: moving axes depart from or approach either configured limit at **300 mm/min (5 mm/s)**, with normal **4000 mm/min** travel in the interior. A stationary axis near an end does not slow the other axis's whole traversal. Each segment completes and its reported position is checked before the next segment; Stop can interrupt between or during segments. Completion deadlines account for distance and speed, including full diagonal travel. Targets outside the range are rejected in main-process validation as well as bounded in the UI.

The original LabVIEW move string omits feedrate. Its exact inherited feedrate is not saved in the archive. This app explicitly uses the upstream Marlin default **4000 mm/min (66.7 mm/s)** for moves; homing uses the firmware's native homing speed. It restores captured original `M203 X500 Y500`, `M201 X500 Y500` and `M204 P500 T1000` values in RAM, removing the 1 mm/s commissioning cap. It does not change steps/mm, offsets, firmware or EEPROM. **Stop Pitot** and the global **Emergency Stop** send `M112` through the verified emergency parser, invalidate position and require a controller power cycle followed by reconnect/homing. Keep physical motor power cutoff available. The Pitot stop does not command the fan; global Emergency Stop also requests DAC zero.

**Force Balance** shows selectable raw bridge inputs and only labels forces in newtons after an appropriate calibration. See [Pitot evidence and implementation](docs/PITOT-2026-11-19.md).

Airspeed uses `v = sqrt(2 × Δp / ρ)` and `ρ = Pabs / [287.05 × (T + 273.15)]`. Differential pressure must be fresh, valid Pa. The atmospheric display and density calculation use the last valid measured kPa value for at most **2 seconds**, displaying its age and labeling held values in Data Viewer. Raw atmospheric NaNs remain visible in the raw column/graphs and recordings. If the two-second limit expires or USB disconnects, the effective value becomes unavailable; there is no invented standard-atmosphere fallback. Startup/restart suppresses derived airspeed for two seconds while the observed pressure transients settle. Raw sampling and recording continue throughout. Displays refresh at 10 Hz rather than 4 Hz. See [November 18 diagnosis](docs/DAQ-AND-FAN-2026-11-18.md) for the firmware bit-check issue underlying the NaNs.

Temperature is entered manually in the acquisition panel. Both estimates support mph and m/s independently of the fan percentage. For airspeed only, finite differential pressure from **−3 Pa through 0 Pa** is treated as zero before the square root, with a clamp explanation shown. Values **below −3 Pa**, invalid/nonfinite inputs and stale readings leave speed unavailable. Negative atmospheric pressure is never clamped into a valid density input. Raw/calibrated signed pressures, plots, quality flags and recordings are unchanged. This low-pressure clamp is separate from NaNs already emitted by the atmospheric sensor firmware.

Archived defaults are Pitot = `press1`, central ring = `press2`; the Main source selectors can change these. Verify the tubing/channel mapping at the tunnel. An unverified legacy static-ring area correction is deliberately not applied. Source changes clear speed history; unit changes convert it. Preview settings and source selections last for the current app session.

**Emergency Stop** immediately latches a main-process block on new nonzero output/acquisition commands and queues DAC zero. Zero remains permitted while latched, including on disconnect/exit. Queued nonzero fan requests are superseded by Stop. **Reset command block** sends no command and never restores a previous percentage. Incoming data and recording may continue. The header remains visible while scrolling. The zero acknowledgment is a firmware report, not feedback of actual motor state; use the physical VFD Stop. Bytes already handed to the serial driver cannot be recalled.

## Firmware contract

The application targets the binary output branch (`SERIAL_OUTPUT_MODE == DATA_MODE_HEX`) in the supplied firmware. Each frame contains a bank byte, little-endian float32 values, and a little-endian uint32 microsecond timestamp. D0/E0/E1-delimited diagnostics are handled independently. Banks 02/03/04/05/06 contain 4/4/1/4/24 values respectively.

Connect attempts `21 00 00` (DAC zero), then sends `01 00 01 86 A0` for a 100000-microsecond period even if zero was not acknowledged, provided the USB connection remains healthy. Commands are spaced by at least 250 ms because the firmware consumes all pending bytes as one command's arguments. Fan Apply sends `21` followed by an unsigned big-endian millivolt value, capped at 3000 mV in both IPC validation and the service. Stop acquisition sends `00`, which does not stop the fan. Raw RX/TX previews remain available in Hardware.

The measured November 5 stream contains 834 frames and all 37 channel slots. The binary decoder, clock, measurement processing, recording and CSV export are verified offline against those original bytes. See [OFFICIAL-DAQ-CAPTURE.md](docs/OFFICIAL-DAQ-CAPTURE.md). Historical bench captures and reports describe earlier releases; the current app accepts binary measurements only.

## Development

Use Node.js 24 LTS and pnpm 11.25.0. From this directory:

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm dev
```

| Command         | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `pnpm check`    | TypeScript, offline tests, formatting                              |
| `pnpm build`    | Compile main, preload and renderer                                 |
| `pnpm start`    | Run compiled desktop application                                   |
| `pnpm test:e2e` | Desktop integration test using saved capture and fixture transport |
| `pnpm package`  | Build Windows executable folder                                    |
| `pnpm dist`     | Explicitly build a per-user x64/ARM64 installer in `distribution/` |

Double-click **Build Installer.cmd** in the parent folder only when preparing a release to share. Normal development/build commands do not rebuild setup. The distribution build leaves the working `release/win-unpacked` app alone. Runtime/framework downloads happen on the build computer when needed; destination computers need only the finished EXE.

Build before desktop tests. To test the packaged executable:

```powershell
$env:WT_TEST_EXECUTABLE = (Resolve-Path 'release/win-unpacked/ENS Wind Tunnel.exe').Path
pnpm test:e2e
Remove-Item Env:WT_TEST_EXECUTABLE
```

The desktop test injects a transport exclusively within its own main-process test session. It uses the real service, binary decoder, preload, IPC, UI and recorder, with saved board bytes and fixture port metadata; it never opens hardware. No replay/simulation switch is shipped in the renderer or preload API. Test files and capture fixtures are excluded from the packaged application.

## Data and code

Hardware calibration persists in Electron's user-data directory as `hardware-calibrations.json`. Older simulation settings are never loaded. `WT_DATA_DIR` selects an isolated data directory for tests. Calibration changes apply only to future samples and carry version numbers.

JSONL stores session metadata, full raw transport chunks, samples, calibration changes, diagnostics and temperature settings. CSV has one row per scalar sample with raw/calibrated values, units, quality, device/arrival timestamps and calibration version. All new recordings are labeled hardware. New files use exclusive creation. Disk backpressure stops recording visibly; normal stop and export wait for finalization.

Derived airspeed history, operator preview targets, and the airspeed source selections are display settings; they are not exported as derived CSV/JSONL measurements. Preserve the selected mapping separately when analyzing a run.

`src/domain` implements the protocol and calculations; `src/infrastructure` owns serial and storage; `src/main` owns the session and Electron lifecycle; `src/preload` exposes a narrow typed API; `src/renderer` contains React views. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [VALIDATION.md](docs/VALIDATION.md).
