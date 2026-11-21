# Architecture — browser v0.7.0

`src/browser/runtime.ts` creates one `TunnelService`, recorder, calibration store and pair of serial transports outside React's component lifecycle. It supplies the same typed `window.tunnel` boundary used by the instrument views. There is no Electron preload, IPC, Node runtime, local server or generic serial-write API in the deployed application.

## Acquisition and display

```text
Web Serial reader → Uint8Array chunks → DaqDecoder → DeviceClock
  → immutable channel measurement → persistent recorder + latest snapshot → React
```

The DAQ transport accepts only the RP2350 identity 2E8A:F00F. A browser registry associates authorized native port handles with session labels such as USB-1; these labels do not expose or represent OS COM paths. Scan lists existing grants, while Choose DAQ device invokes the browser's filtered permission chooser directly from an operator click.

The production decoder and command encoder use Uint8Array, DataView and TextDecoder. Binary bank counts, endian conventions, timestamps, diagnostics, raw zeros, signed values and nonfinite-value identities are unchanged. Unknown bytes and bounded unterminated text remain explicit protocol faults; the checksum-free firmware cannot provide guaranteed resynchronization.

`TunnelService` retains the acquisition queue, clock, calibrations, raw monitor, fan state and measurement quality. It publishes immutable snapshots every 100 ms. React retains the original instrument pages, SVG plots, styles and bounded 120-point display histories. Full-rate recording is independent of display refresh and navigation.

Pressure-derived speed retains the two-second startup settling window, a separately aged last-valid atmospheric input capped at two seconds, and the small-negative differential-pressure clamp only for airspeed. Raw samples and recorded history are unchanged by display calculations or later calibration edits.

## Control and ownership

DAQ and Pitot use independent native port handles, readers and writers. Transports release stream locks before closing. Operations have deadlines; a late-opening or unsuccessfully closed handle cannot be silently reused. Native API failures reach the existing connection-loss paths, invalidating measurement freshness or homing rather than supplying generated data.

The browser registry checks USB identity again before reserving/opening a handle. A Web Lock, scoped to this application path, prevents another tab of the application from becoming a second control owner. Pending connection requests carry a revision so a chooser or lock wait cannot reopen hardware after Disconnect.

Fan output retains its exact acknowledgment requirement, initial zero, 0–3000 mV limit, 250-ms command pacing, immediate Emergency Stop latch and supersession of pending nonzero commands. Neither serial completion nor a DAC acknowledgment establishes actual VFD run state.

Pitot retains its independent Marlin machine/UUID/emergency-parser checks, runtime settings verification, explicit X-then-Y homing, holding torque, conservative 360-mm bounds, end-zone motion planning, M400/M114 completion and fixed deadlines. No raw G-code, EEPROM write, firmware upload, Z move, automatic reset/resume or encoder claim is exposed. Previously authorized single-controller discovery can connect/home at page startup; first access requires the browser chooser.

## Disconnect and page lifecycle

The persistent header Disconnect button calls `TunnelService.disconnectAll`. It synchronously blocks new control work and supersedes pending nonzero output, interrupts possible Pitot motion independently of the DAQ queue, then requests acknowledged DAC zero and acquisition stop before closing the DAQ. Recording finalization is awaited even if fan zero fails. A healthy DAQ remains connected for retry after a missing zero acknowledgment; the result reports failure. Storage-finalization failures remain visible and support a retry. An already unavailable DAQ cannot produce a claimed zero acknowledgment.

The runtime also awaits any file operation already in progress and prevents a concurrent recording start from surviving shutdown. Snapshots retain the disconnecting state through both hardware and file cleanup. Emergency Stop and further zero-output requests remain available while commands are blocked.

`beforeunload` requests a browser warning while USB, recording, shutdown or file work is active. It does not claim to complete asynchronous cleanup. A killed/reloaded tab, USB loss, browser crash or power loss cannot guarantee physical stopping. Explicit Disconnect and physical hardware controls are separate operating actions.

## Recording and calibration

The production recorder commits append-only JSONL chunks and their progress metadata in atomic IndexedDB transactions. IDs are unique even when run names match. Writes are batched at 100 ms or 64 KiB and the pending queue is capped at 1 MiB. Quota/write failures stop recording visibly; uncommitted samples are not represented as committed rows. Stop/Disconnect waits for pending writes and final metadata. An interrupted run remains labeled unfinalized after reload, and its committed prefix can be recovered.

Sessions lists saved runs from the current origin/application path/profile. JSONL and twelve-column scalar CSV export stream one bounded chunk at a time into a user-selected file; success waits for file close. Existing nonempty output files are refused. Raw bytes, zeros/NaNs, timestamps, hardware labels and calibration versions retain the desktop schema. Derived speed histories and operator targets remain display state rather than invented measurement columns.

Small, validated hardware calibrations persist in localStorage with the same origin/path scope. Import/export supports the original Electron hardware-calibrations.json. Imports require a disconnected DAQ and pass the canonical-unit/schema checks before changing storage. The website cannot automatically read Electron's profile directory. Existing readings are never recalculated retroactively.

## Build and deployment

Vite builds only the browser entry and its reachable dependencies into dist. There are no production imports of Electron, serialport, Node fs, test transports or capture files. The offline build helper precaches the HTML, JS and CSS. It neither forces waiting service workers to activate nor reloads active control pages.

The Pages workflow validates, builds and tests main pushes, uploads only dist and deploys that artifact. Pull requests validate without deployment. The project base is /wind-tunnel/ by default. Pages serves static assets; all device I/O and measurement storage remain on the visitor's computer. Setting up or running this workflow does not upload user recordings or calibration.

## Verification boundaries

Core regressions retain original saved-byte coverage. Node filesystem adapters under tests/support compare recording and calibration behavior with the desktop contract; they are unreachable from the browser build. Browser integration tests inject native Web Serial and file-picker fixtures before application startup and exercise the real state machines, decoder, IndexedDB, Web Locks and React UI in a Chromium browser. The fixtures never open hardware and do not ship in dist.

The original Electron source and architecture are preserved on the electron-app branch at f6b4492. Historical capture and commissioning documents describe the evidence available for the physical devices. Actual Web Serial acquisition and actuator operation with the installed hardware remain separate lab validation.
