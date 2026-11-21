# DAQ timing and supervised fan test — November 18, 2026

## Findings from actual USB bytes

COM10 identified as RP2350 DAQ USB 2E8A:F00F. COM11 identified as CH340 USB 1A86:7523, consistent with the separate Pitot controller; it was never opened. Firmware was examined read-only and was not modified or uploaded.

The [12-second all-bank capture](captures/2026-11-18T21-29-06.042Z-COM10-115200-all.jsonl) contains 17,462 RX bytes and 499 measurement packets. There are 100 packets each for strain, temperature, absolute pressure and local differential pressure, plus 99 backpack packets. The independent audit and production-decoder replay agree. There are no unknown leading bytes/decoder framing warnings in the measurement stream. Capture shutdown ends with an incomplete debug message, retained as evidence rather than invented completion bytes.

| Observation                                     | Result                                      |
| ----------------------------------------------- | ------------------------------------------- |
| Differential-bank median interval               | 120.227 ms, approximately 8.3 Hz            |
| Valid local pressure 1 / 2                      | 100 / 100 each                              |
| Local pressure 3 / 4                            | NaN in all 100 packets                      |
| Absolute pressure                               | 50 finite, 50 NaN; finite median 99.300 kPa |
| Largest gap between finite atmospheric arrivals | 603 ms                                      |
| Previous renderer publication interval          | 250 ms, 4 Hz                                |

The [individual-bank comparison](captures/2026-11-18T21-31-10.009Z-COM10-115200-banks.jsonl) measures approximately 101.53 ms for local differential pressure, 110.04 ms for absolute pressure, and 120.22 ms for the backpack bank. Firmware records its last-sample time after acquisition, so the requested 100 ms period is followed by sensor acquisition time. The absolute-pressure driver explicitly waits 10 ms. Reducing USB baud-rate overhead cannot remove that sensor/firmware timing. An earlier interrupted bank capture records a USB removal; the user confirmed the cable was pulled and reconnected it.

Acquisition startup produces large pressure values that decay during roughly the first second or two, including local values near 2337/2768 Pa. After settling, pressure 1 is near zero (occasionally slightly negative) and pressure 2 is near +7 Pa. These are observed offsets, not calibrated airflow. Fan-off tare/polarity and physical tubing assignment still require verification; no automatic tare or pressure clamping was introduced.

## Atmospheric NaN cause

In the supplied `src/sensor/AbsPressureSensor.cpp`, the 14-bit pressure request is 0x2800. Its diagnosis test uses `(_rawFrame >> 1) & 1`, overlapping the low pressure-data bit. The [manufacturer's KP467 datasheet](https://www.infineon.com/assets/row/public/documents/30/49/infineon-kp467-datasheet-en.pdf), figure 14 and table 30, assigns diagnosis to bit 15, data to bits 14–1 and parity to bit 0. The conversion gain/offset are 105.70 LSB/kPa and −4756.

The supplied check consequently rejects odd pressure codes. Valid USB values imply even codes (for example 5734, 5736, 5738, 5740, 5742), matching the roughly 50% NaN rate. This is strong evidence for the observed failure; exact flashed firmware identity and raw SPI frames cannot be authenticated from this USB protocol alone. The host cannot recover a pressure code already replaced by NaN. Firmware is unchanged.

Version 0.5.0 bridges these short gaps using the last valid measured atmospheric pressure for at most two seconds, with age and held status displayed. Raw values and logs retain every NaN. It never substitutes a constant standard atmosphere. Expiry or USB loss removes the effective input. Differential-pressure NaNs/negative values are not replaced. Derived airspeed waits through two seconds of startup settling; original samples are still graphed/recorded. Snapshots publish every 100 ms rather than 250 ms.

## Fan command verification

The path is PC → DAQ USB → DAC → amplifier → VFD reference. The fan test used raw opcode 0x21 with big-endian millivolts, separate from acquisition opcode 0x00. The [supervised test capture](captures/2026-11-18T21-33-34.304Z-fan-check.jsonl) includes exact firmware acknowledgments for zero, 50, 100, 150 and zero millivolts. Nonzero steps lasted three seconds each. The operator confirmed Rev Run and physical Stop availability before the test, then reported that the fan turned on as expected. Zero was acknowledged twice at the end. Physical VFD Stop was requested afterward; its operation was not independently observed.

The desktop dial now maps 0–100% to 0–3000 mV before amplification. Only Apply sends the requested value. Initial connection, fan Stop, Emergency Stop, disconnect and normal exit request acknowledged zero. Nonzero output is never restored after reconnect. A missing acknowledgment latches a fault and attempts zero. Commands are paced at least 250 ms apart to avoid the firmware consuming adjacent requests as one command's arguments. Clock faults continue decoding diagnostic/DAC acknowledgment messages. Neither acknowledgment nor serial close proves actual motor state. Physical VFD controls remain necessary, particularly for USB/power/process failures. Only 0–150 mV was exercised physically; the full percentage range is verified offline.

## Updated production-app live check

The [zero-output live capture](captures/2026-11-18T21-53-33.311Z-app-zero-check.jsonl) and [summary](captures/2026-11-18T21-53-33.311Z-app-zero-check-summary.json) use the real service, IPC, transport, decoder and recorder. Of 100 snapshot checks, 53 latest raw atmospheric readings were NaN, while the bounded effective atmospheric input was available in 99 (the first check preceded its initial valid reading). Board-confirmed output remained zero. The connection was closed with zero-output cleanup. No nonzero command or Pitot I/O was used in that check. The user subsequently disconnected the DAQ; further verification is offline.

Diagnostic tools are explicit command-line entry points, not startup hooks: `scripts/analyze-daq-capture.cjs` reads saved bytes; `scripts/check-live-zero.cjs` performs zero-only live acquisition; `scripts/fan-check.cjs` is the fixed, supervised 0–150 mV commissioning test and waits for an explicit RUN token after acknowledged zero. None is bundled into the renderer or invoked automatically.
