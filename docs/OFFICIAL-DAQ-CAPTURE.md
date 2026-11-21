# Official DAQ capture — November 5, 2026

The official board was identified as COM10 with USB VID 2E8A / PID F00F. A separate CH340 device appeared on COM11 (1A86:7523); it was never opened or sent any data. No firmware was changed and no G-code or DAC commands were sent.

Two short acquisitions were completed immediately while the board was available. The DAQ port was then closed; all subsequent development and verification used saved bytes offline.

## Wire format and commands

The official firmware sends little-endian binary float32 measurements with trailing uint32 microsecond timestamps, interleaved with D0-delimited debug text. This differs from the November 4 bench board's ASCII DATA responses. The app's existing Auto detect decoder successfully decodes the actual official-board capture without a firmware change.

Only acquisition commands were used: `00` to stop and `01 00 01 86 A0` to request all banks with a 100000-microsecond period. Neither command changes the fan reference. Startup includes SPI initialization and strain-channel detection text. Opening the port does not establish that initialization is complete, so the first capture also retains startup messages.

## Captured results

The [20-second acquisition capture](captures/2026-11-05T15-57-56.627Z-COM10-115200-all.jsonl) contains 29,101 received bytes and 834 decoded measurement frames:

| Bank                             | Frames | Values per frame |
| -------------------------------- | -----: | ---------------: |
| Bridge 0x02                      |    167 |                4 |
| Temperature 0x03                 |    167 |                4 |
| Absolute pressure 0x04           |    167 |                1 |
| Local differential pressure 0x05 |    167 |                4 |
| Backpack pressures 0x06          |    166 |               24 |

All 37 channel slots are present, corresponding to 6,155 scalar samples. Device timestamps advance monotonically across the saved stream. There are no decoder warning/error events in the capture. A requested 10 Hz is not an assertion that every bank physically samples at 10 Hz; this run yielded about 8.3 frames per second per bank.

The first bridge frame contains raw counts 3221929, -436778, 275214, and 4579. Absolute pressure initially decodes to about 97.42668 kPa. The local differential bank includes values near 2335.7163 Pa and 2767.5713 Pa, with NaNs on other local channels. Temperatures are NaN. The backpack returns 24 values, including repeated values near 2767.5713 and some literal zeros. These are raw device readings; repeated high values, tubing assignment, pressure polarity, calibration and sensor validity need physical verification before interpreting them as airflow.

The [initial two-second capture](captures/2026-11-05T15-57-27.055Z-COM10-115200-all.jsonl) also contains all five banks and retains more startup text.

## Software changes and verification

- Port selection uses USB identity instead of assuming COM9. One matching DAQ is suggested automatically; connection remains an explicit operator action.
- The main-process serial transport checks the identity again before opening a port and excludes CH340/Pitot devices. The command-line probe has the same identity restriction.
- The Hardware view describes the verified official binary format and retains ASCII support for the earlier board.
- `tests/official-daq.test.ts` replays actual chunks through the production decoder, timestamp handling, measurement service, recorder and CSV exporter, with an in-memory transport and no hardware access. It verifies 834 frames, all 37 channels, NaNs/zeros, 6,155 exported samples, and rejection of the Pitot identity before opening a port.

The rebuilt application defaults to simulation at launch. To use real data, open Hardware, confirm the detected DAQ (COM10 during this capture), leave Response format on Auto detect, and click Connect and read DAQ. Device names can change between connections. Live fan and traverse commands remain disabled.
