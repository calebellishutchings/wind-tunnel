import { describe, expect, it } from 'vitest'
import {
  acquisitionCommand,
  BANK_SIZES,
  dacCommand,
  DaqDecoder,
  DeviceClock,
  encodeFrame,
} from '../src/domain/protocol'
import type { BankId } from '../src/shared/model'

describe('archived DAQ protocol', () => {
  it('decodes all 37 channels through byte-by-byte fragmentation', () => {
    const decoder = new DaqDecoder()
    const data = Buffer.concat(
      ([2, 3, 4, 5, 6] as BankId[]).map((bank) =>
        encodeFrame(
          bank,
          Array.from({ length: BANK_SIZES[bank] }, (_, i) => i + 0.5),
          123456,
        ),
      ),
    )
    const packets = [...data].flatMap((byte) => decoder.push(Buffer.from([byte])))
    expect(packets).toHaveLength(5)
    expect(packets.flatMap((p) => (p.type === 'measurement' ? p.values : []))).toHaveLength(37)
    expect(packets[4]).toMatchObject({ bank: 6, deviceMicros: 123456 })
  })
  it('preserves zeros, negative values and nonfinite readings', () => {
    const [packet] = new DaqDecoder().push(encodeFrame(2, [0, -2.5, NaN, Infinity], 100))
    expect(packet?.type).toBe('measurement')
    if (packet?.type !== 'measurement') throw new Error('Missing frame')
    expect(packet.values[0]).toBe(0)
    expect(packet.values[1]).toBe(-2.5)
    expect(packet.values[2]).toBeNaN()
    expect(packet.values[3]).toBe(Infinity)
  })
  it('retains interleaved diagnostics and following measurements', () => {
    const text = Buffer.from([0xd0, 65, 0xd0, 0xe0, 66, 0xe0, 0xe1, 67, 0xe1])
    const packets = new DaqDecoder().push(Buffer.concat([text, encodeFrame(4, [101.325], 200)]))
    expect(packets.slice(0, 3)).toEqual([
      { type: 'diagnostic', level: 'info', message: 'A' },
      { type: 'diagnostic', level: 'warning', message: 'B' },
      { type: 'diagnostic', level: 'error', message: 'C' },
    ])
    expect(packets[3]).toMatchObject({ type: 'measurement', bank: 4 })
  })
  it('bounds unterminated text and explicitly reports discarded bytes', () => {
    const decoder = new DaqDecoder()
    expect(decoder.push(Buffer.from([0xff, 0xff]))[0]).toMatchObject({
      type: 'diagnostic',
      level: 'warning',
    })
    expect(
      decoder.push(Buffer.concat([Buffer.from([0xd0]), Buffer.alloc(4097, 65)]))[0],
    ).toMatchObject({ type: 'diagnostic', level: 'error' })
    expect(decoder.push(encodeFrame(4, [0], 0))[0]).toMatchObject({
      type: 'measurement',
      values: [0],
    })
  })
  it('encodes integer arguments big-endian, independently of response order', () => {
    expect(Buffer.from(acquisitionCommand(100000)).toString('hex')).toBe('01000186a0')
    expect(Buffer.from(dacCommand(1250)).toString('hex')).toBe('2104e2')
    expect(Buffer.from(dacCommand(0)).toString('hex')).toBe('210000')
    expect(() => dacCommand(3301)).toThrow()
    expect(() => dacCommand(-1)).toThrow()
    expect(() => dacCommand(NaN)).toThrow()
    expect(() => acquisitionCommand(0)).toThrow()
  })
})
describe('device clock', () => {
  it('accumulates multiple wraps beyond the old 71-minute limit', () => {
    const clock = new DeviceClock()
    expect(clock.update(0xfffffff0)).toBe(0)
    expect(clock.update(10)).toBe(26)
    clock.update(0x7ffffff0)
    clock.update(0xfffffff0)
    expect(clock.update(20)).toBe(0x100000000 + 36)
  })
  it('accepts equal bank timestamps and rejects backwards resets', () => {
    const clock = new DeviceClock()
    clock.update(1000)
    expect(clock.update(1000)).toBe(0)
    expect(() => clock.update(900)).toThrow('backwards')
  })
})
