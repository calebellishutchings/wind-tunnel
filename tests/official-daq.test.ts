import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SerialPort } from 'serialport'
import { DaqDecoder, DeviceClock } from '../src/domain/protocol'
import { isDaqPort, preferredDaqPath } from '../src/shared/daq-device'
import { SerialDaqTransport, type DaqTransport } from '../src/infrastructure/serial'
import { TunnelService } from '../src/main/tunnel-service'
import { SettingsStore } from '../src/infrastructure/settings'
import { exportRecordingCsv } from '../src/infrastructure/recording'

const capture = 'docs/captures/2026-11-05T15-57-56.627Z-COM10-115200-all.jsonl'
const rows = readFileSync(capture, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { direction?: string; hex?: string })
const chunks = rows
  .filter((row) => row.direction === 'rx')
  .map((row) => Buffer.from(row.hex!, 'hex'))
const daq = { path: 'COM10', vendorId: '2E8A', productId: 'F00F' }
const pitot = { path: 'COM11', vendorId: '1A86', productId: '7523' }

describe('official board capture (offline; no serial devices opened)', () => {
  it('decodes all five real binary banks with little-endian values and monotonic timestamps', () => {
    const decoder = new DaqDecoder()
    const packets = chunks.flatMap((chunk) => decoder.push(chunk))
    const frames = packets.filter((packet) => packet.type === 'measurement')
    expect(decoder.format).toBe('binary')
    expect(frames).toHaveLength(834)
    expect(
      Object.fromEntries(
        [2, 3, 4, 5, 6].map((bank) => [bank, frames.filter((p) => p.bank === bank).length]),
      ),
    ).toEqual({ 2: 167, 3: 167, 4: 167, 5: 167, 6: 166 })
    expect(frames[0]).toMatchObject({
      bank: 2,
      values: [3221929, -436778, 275214, 4579],
      deviceMicros: 304267524,
    })
    expect(frames.find((frame) => frame.bank === 4)?.values[0]).toBeCloseTo(97.42668, 4)
    expect(frames.find((frame) => frame.bank === 6)?.values).toHaveLength(24)
    const clock = new DeviceClock()
    expect(frames.map((frame) => clock.update(frame.deviceMicros)).at(-1)).toBeGreaterThan(
      19_000_000,
    )
    expect(
      packets.filter((packet) => packet.type === 'diagnostic' && packet.level !== 'info'),
    ).toEqual([])
  })
  it('feeds the production acquisition and recording pipeline entirely from saved bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-official-replay-'))
    let events!: Parameters<DaqTransport['open']>[1]
    const writes: string[] = []
    const transport: DaqTransport = {
      async open(_options, callbacks) {
        events = callbacks
      },
      async write(data) {
        writes.push(data.toString('hex'))
        if (data[0] === 0x21)
          events.data(Buffer.from(`\xd0DAC output set to ${data.readUInt16BE(1)} mV\xd0`, 'latin1'))
      },
      async close() {},
    }
    const service = new TunnelService(new SettingsStore(join(directory, 'hardware.json')), {
      transportFactory: () => transport,
      commandSpacingMs: 0,
      fanAckTimeoutMs: 30,
    })
    try {
      await service.initialize()
      await service.act({ type: 'daq-connect', path: 'COM10', baudRate: 115200 })
      await service.recorder.start(
        join(directory, 'official.jsonl'),
        { replaySource: capture },
        'hardware',
      )
      for (const chunk of chunks) {
        events.data(chunk)
        // Let real file I/O drain; a whole 20-second stream must not arrive in one synchronous burst.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const snapshot = service.snapshot()
      expect(snapshot.frameCount).toBe(834)
      expect(Object.keys(snapshot.measurements)).toHaveLength(37)
      expect(snapshot.daq.receivedBytes).toBeGreaterThanOrEqual(29101)
      expect(snapshot.measurements.temp1?.rawSpecial).toBe('NaN')
      expect(snapshot.measurements.array24?.raw).not.toBeNull()
      await service.recorder.stop()
      await exportRecordingCsv(join(directory, 'official.jsonl'), join(directory, 'official.csv'))
      const csv = await readFile(join(directory, 'official.csv'), 'utf8')
      expect(csv.trim().split('\n')).toHaveLength(6156)
      expect(csv).toContain('"hardware","array10","0"')
      expect(writes).toEqual(['210000', '01000186a0'])
    } finally {
      // Capture termination may contain an incomplete final debug message.
      events.close()
      await service.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  it('selects the DAQ by identity, excluding the Pitot even if COM numbers change', () => {
    expect(isDaqPort(pitot)).toBe(false)
    expect(preferredDaqPath([pitot, daq])).toBe('COM10')
    expect(preferredDaqPath([pitot])).toBeUndefined()
    expect(preferredDaqPath([daq, { ...daq, path: 'COM12' }])).toBeUndefined()
  })
  it('rejects the Pitot before creating or opening a SerialPort', async () => {
    const list = vi.spyOn(SerialPort, 'list').mockResolvedValue([pitot])
    try {
      const transport = new SerialDaqTransport()
      await expect(
        transport.open(
          { path: 'COM11', baudRate: 115200 },
          { data: () => {}, error: () => {}, close: () => {} },
        ),
      ).rejects.toThrow('No port was opened')
    } finally {
      list.mockRestore()
    }
  })
})
