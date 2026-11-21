import type { BankId } from '../shared/model'
export const BANK_SIZES: Record<BankId, number> = { 2: 4, 3: 4, 4: 1, 5: 4, 6: 24 }
export type Packet =
  | { type: 'measurement'; bank: BankId; values: number[]; deviceMicros: number }
  | { type: 'diagnostic'; level: 'info' | 'warning' | 'error'; message: string }

/** Binary float32 and uint32 fields match the captured RP2350 firmware. */
export class DaqDecoder {
  private buffer = Buffer.alloc(0)
  get format(): 'binary' {
    return 'binary'
  }
  push(chunk: Uint8Array): Packet[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    const packets: Packet[] = []
    while (this.buffer.length) {
      const id = this.buffer[0]!
      if (id === 0xd0 || id === 0xe0 || id === 0xe1) {
        const end = this.buffer.indexOf(id, 1)
        if (end < 0) {
          if (this.buffer.length <= 4096) break
          packets.push({
            type: 'diagnostic',
            level: 'error',
            message:
              'Unterminated DAQ text exceeded 4096 bytes; decoder reset. Framing is uncertain.',
          })
          this.buffer = Buffer.alloc(0)
          break
        }
        packets.push({
          type: 'diagnostic',
          level: id === 0xd0 ? 'info' : id === 0xe0 ? 'warning' : 'error',
          message: this.buffer.subarray(1, end).toString('utf8'),
        })
        this.buffer = this.buffer.subarray(end + 1)
        continue
      }
      const count = BANK_SIZES[id as BankId]
      if (!count) {
        let skipped = 0
        while (
          skipped < this.buffer.length &&
          !BANK_SIZES[this.buffer[skipped] as BankId] &&
          ![0xd0, 0xe0, 0xe1].includes(this.buffer[skipped]!)
        )
          skipped++
        this.buffer = this.buffer.subarray(skipped)
        packets.push({
          type: 'diagnostic',
          level: 'warning',
          message: `Discarded ${skipped} unknown byte(s). Protocol has no checksum; synchronization is not guaranteed.`,
        })
        continue
      }
      const length = 5 + count * 4
      if (this.buffer.length < length) break
      const values = Array.from({ length: count }, (_, i) => this.buffer.readFloatLE(1 + 4 * i))
      packets.push({
        type: 'measurement',
        bank: id as BankId,
        values,
        deviceMicros: this.buffer.readUInt32LE(1 + count * 4),
      })
      this.buffer = this.buffer.subarray(length)
    }
    return packets
  }
}
export function encodeFrame(bank: BankId, values: number[], deviceMicros: number): Buffer {
  if (values.length !== BANK_SIZES[bank]) throw new Error('Incorrect bank size')
  const frame = Buffer.alloc(5 + values.length * 4)
  frame[0] = bank
  values.forEach((value, i) => frame.writeFloatLE(value, 1 + 4 * i))
  frame.writeUInt32LE(deviceMicros >>> 0, 1 + values.length * 4)
  return frame
}
export function acquisitionCommand(periodMicros: number): Buffer {
  if (!Number.isInteger(periodMicros) || periodMicros < 1 || periodMicros > 0xffffffff)
    throw new Error('Invalid period')
  const command = Buffer.alloc(5)
  command[0] = 1
  command.writeUInt32BE(periodMicros, 1)
  return command
}
export function dacCommand(millivolts: number): Buffer {
  if (!Number.isInteger(millivolts) || millivolts < 0 || millivolts > 3300)
    throw new Error('DAC must be an integer from 0 to 3300 mV')
  const command = Buffer.alloc(3)
  command[0] = 0x21
  command.writeUInt16BE(millivolts, 1)
  return command
}

/** Accumulates wraps. A backwards jump smaller than half a period signals reset/out-of-order data. */
export class DeviceClock {
  private previous: number | undefined
  private elapsed = 0
  update(micros: number): number {
    if (this.previous === undefined) {
      this.previous = micros
      return 0
    }
    const delta = (micros - this.previous + 0x100000000) % 0x100000000
    if (delta > 0x80000000)
      throw new Error('Device clock moved backwards. Reset session before accepting more packets.')
    this.elapsed += delta
    this.previous = micros
    return this.elapsed
  }
}
