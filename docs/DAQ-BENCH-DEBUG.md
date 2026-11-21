# COM9 bench communication — November 4, 2026

## Cause of the missing display

Two application issues prevented reading this board: version 0.1 only enumerated ports and never opened a live connection, and its measurement decoder implemented only the binary response format recovered from the archived Python helper. The connected board's firmware instead emits ASCII measurement lines alongside D0-delimited debug messages. A missing pressure sensor does not explain the lack of a serial connection in that version.

## Verified device and settings

- Port: COM9, `USB Serial Device`, Microsoft driver.
- USB identity: VID `2E8A`, PID `F00F`, interface `MI_00`. The enumerated Windows identifier is retained in the capture header; it should not be assumed to be a unique factory USB serial number.
- Serial settings: 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control. The probe explicitly asserted DTR/RTS; startup text was already arriving after opening the port, so DTR was not established as the cause of the original problem.
- Startup response: D0-delimited `Opened serial` text.
- Sensor stop: raw byte `00`, acknowledged with `Turned all sensors off`.
- All-sensor start: raw bytes `01 00 01 86 A0`. Debug replies echo command 1, period 100000, continuous sample amount 0, and `Turned all sensors on`.
- No DAC, fan, motion, or firmware-flashing commands were sent.

The first all-bank probe received 6,788 bytes during its two-second acquisition stage, 6,952 bytes including startup/cleanup. It contained 75 complete ASCII measurement lines: 19 bridge, 19 temperature, 19 local pressure, and 18 absolute pressure. Receipt counts describe this capture, not a guaranteed sampling rate.

## Actual output

```text
DATA, STRAIN: , -2618.0000, 3207.0000, 4856.0000, 457.0000, TIMESTAMP: 472331345
DATA, TEMP: , nan, nan, nan, nan, TIMESTAMP: 472331932
DATA, DIFF_PRESS: , 0.0000, 0.0000, 0.0000, 0.0000, TIMESTAMP: 472332180
DATA, ABS_PRESS: , nan, TIMESTAMP: 472342560
```

These are captured values. Bridge values vary between measurements; differential pressure remains zero; temperature and absolute pressure return NaN on this uninstrumented board. A numeric raw value or zero does not establish that a sensor is connected or accurate. The firmware emits separate bank timestamps, not a simultaneous snapshot.

Later live-app testing also observed finite absolute-pressure readings (for example, 97.105 kPa). The initial all-NaN absolute-pressure capture should therefore not be generalized to every later run. Both finite readings and intermittent NaNs are retained; no replacement value is invented.

Individual commands 0x02–0x05 were also acknowledged and produced their respective data lines. Command 0x06 was acknowledged as `Toggled backpack pressure sensors`, but yielded no measurements during a two-second observation. The app leaves the 24 backpack channels missing instead of synthesizing data.

## Evidence and reproduction

- [All-bank raw capture](captures/2026-11-05T02-39-30.995Z-COM9-115200-all.jsonl)
- [Individual-bank raw capture](captures/2026-11-05T02-40-07.413Z-COM9-115200-banks.jsonl)
- Probe: `scripts/probe-daq.cjs`; run `pnpm probe:daq --port COM9 --baud 115200 --plan all`.
- Replay regression: `tests/ascii.test.ts` feeds the original received chunks to the production decoder, checks all 75 lines, preserves NaNs/zeros, and checks timestamp progression.

Capture filenames and event timestamps use UTC, so their date is November 5; the local bench session was November 4 in America/New_York. Acquisition probes stop sensor acquisition and close the port on completion; the passive listen plan only closes its port. One serial owner must release COM9 before another app can open it.

## Implementation

Version 0.2 adds an explicit live DAQ connection, serial lifecycle/error handling, automatic ASCII/binary detection, raw text/hex previews, actual receive/transmit counters, and source-correct recording/export. Receive evidence is retained even if decoding fails. Simulation and hardware calibration files and display histories are kept separate. Live fan and traverse commands are blocked at both the service and UI.

The archived Python's little-endian binary interpretation is retained for compatible firmware. This ASCII capture does not resolve binary byte order, validate physical sensor mappings, establish operating limits, or commission fan/motion control.
