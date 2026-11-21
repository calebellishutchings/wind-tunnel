import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DaqDecoder } from '../src/domain/protocol'
import { snapshotAirspeed } from '../src/domain/measurements'
import { TunnelService } from '../src/main/tunnel-service'
import { SettingsStore } from '../src/infrastructure/settings'
import { FakeTransport, connect } from './helpers'

it('replays November 18 wire evidence: 120 ms differential packets, 50 atmospheric NaNs, bounded density reuse', async () => {
  const rows = readFileSync('docs/captures/2026-11-18T21-29-06.042Z-COM10-115200-all.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) => JSON.parse(line) as { at: string; direction?: string; hex?: string; stage: string },
    )
  const startAt = Date.parse(rows.find((r) => r.direction === 'tx' && r.hex === '01000186a0')!.at)
  const decoder = new DaqDecoder()
  const packets = rows
    .filter((r) => r.direction === 'rx')
    .flatMap((r) => decoder.push(Buffer.from(r.hex!, 'hex')))
  const frames = packets.filter((p) => p.type === 'measurement')
  expect(frames).toHaveLength(499)
  const diff = frames.filter((p) => p.bank === 5)
  expect(diff).toHaveLength(100)
  expect(diff.every((p) => Number.isFinite(p.values[0]) && Number.isFinite(p.values[1]))).toBe(true)
  expect(frames.filter((p) => p.bank === 4 && Number.isNaN(p.values[0]))).toHaveLength(50)
  const intervals = diff
    .slice(1)
    .map((p, i) => (p.deviceMicros - diff[i]!.deviceMicros) >>> 0)
    .sort((a, b) => a - b)
  expect(intervals[Math.floor(intervals.length / 2)]).toBeCloseTo(120227, -2)
  expect(packets.filter((p) => p.type === 'diagnostic' && p.level !== 'info')).toEqual([])
  const directory = await mkdtemp(join(tmpdir(), 'ens-current-'))
  const transport = new FakeTransport()
  const service = new TunnelService(new SettingsStore(join(directory, 'settings.json')), {
    transportFactory: () => transport,
    commandSpacingMs: 0,
    fanAckTimeoutMs: 30,
  })
  try {
    await service.initialize()
    await service.act(connect)
    const base = Date.now()
    let calculatedDespiteRawNaN = 0
    for (const row of rows.filter((r) => r.direction === 'rx')) {
      const at = base + Date.parse(row.at) - startAt
      service.ingest(Buffer.from(row.hex!, 'hex'), at)
      const s = service.snapshot(at)
      if (s.measurements.abs_pressure?.rawSpecial === 'NaN' && snapshotAirspeed(s, 'press2'))
        calculatedDespiteRawNaN++
    }
    expect(calculatedDespiteRawNaN).toBeGreaterThan(20)
  } finally {
    // The original capture closes mid-debug-message. Reproduce that port close before teardown;
    // appending a fabricated DAC reply into the truncated text would be a framing error.
    transport.events?.close()
    await service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
