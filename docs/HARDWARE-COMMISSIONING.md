# Lab visit checklist

Use this to gather the information needed for complete tunnel integration. The application supports live DAQ acquisition; the November 5 official-board capture confirms all five binary measurement banks. Physical sensor validation and actuator commissioning remain separate work. Keep existing operating procedures and original software available.

## Identify and preserve

- Copy or fingerprint the actual running LabVIEW VI, Python helper, and configuration. Compare with `Documentation/Software Rewrite Reference/source_fingerprints.json`.
- Obtain the production RP2350B firmware source/build and `Defines.h`, plus the configured Marlin source, board revision, flashed version, and build artifacts.
- Record DAQ and traverse VID/PID, USB serial numbers, manufacturer strings, COM paths, driver versions, and baud. The archive suggests 115200; old diagrams conflict. Do not rely on COM7/COM9.
- Confirm the work is on ENS; AEL has a different VFD interface and unverified travel values.

## DAQ capture

Capture startup text and complete responses for each bank: 0x02 bridge (21 bytes), 0x03 temperature (21), 0x04 absolute pressure (9), 0x05 local differential pressure (21), 0x06 backpack pressures (101).

Save original bytes and note the physical condition and expected units. Confirm little-endian float32 and uint32 timestamps against a known reading. Exercise one bank at a time where the known firmware permits it; confirm optional command fields and command-boundary behavior before changing the known acquisition command.

Record NaNs, sensor faults, missing channels, timing, counter rollover, board restarts, and debug/warning/error frames. The protocol does not provide integrity checks. Do not infer valid synchronization from a plausible number alone.

## Sensors

- Apply known differential pressures one channel at a time. Record which tube/sensor corresponds to each channel, high/low polarity, units, and bank order, including all 24 backpack taps.
- Confirm the absolute sensor's kPa scale and temperature availability. Room temperature remains a manual input initially.
- Apply known normal and axial loads separately. The VI aliases strain2 to Normal and strain3 to Axial; the manual reverses those names. Keep Bridge labels until this is resolved.
- Record bridge gain jumper settings, raw zero/span, reference loads in N, cable/harness mapping, and polarity.
- Decide whether differential 1 is the intended Pitot input and what static-ring correction is physically justified.

## Traverse

- Verify board/Marlin version and actual baud; USB logic power is distinct from motor power.
- Establish coordinate units, axis directions, origin, verified travel, homing-switch behavior, motion power state, feed rate, and soft limits.
- Capture startup, `ok`, error, busy, homing, and completion responses for the installed firmware. Verify availability/semantics of `G90`, `M400`, and `M114` before using them.
- Distinguish a requested point, queued motion, controller-confirmed completion, and encoder measurement. The archive provides no encoder interface.
- Do not copy AEL's 495 × 540 mm dimensions or this simulator's 300 × 300 mm workspace into an ENS hardware profile.

## Fan reference

- Verify the AccuFlow analog reference wiring and manual run controls with the responsible lab operator.
- Measure DAC-to-amplifier-to-RJ4 transfer, offset, usable command range, and maximum acceptable output. The protocol's 3300 mV ceiling is not a verified tunnel operating limit.
- Confirm behavior on DAC zero, acquisition stop, normal application close, process failure, USB loss, and DAQ power loss. The archive reports a floating-reference problem on power loss.
- Record the actual physical stop procedure and available fault/run feedback. Software DAC zero is not an emergency stop and cannot establish motor state.
- Validate a manual output path first. Recover and evaluate any deployed PID separately; the saved 15% limit and gains are development evidence.

## Deliverables after the visit

Bring back a short device/profile sheet, unedited binary captures, sensor/axis maps, operating limits, firmware sources/builds, and the installed software identity. These support real DAQ acquisition first, followed by bounded manual output and acknowledged traverse control.
