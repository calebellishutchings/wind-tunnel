import type { DaqTransport } from '../src/infrastructure/serial'
export class FakeTransport implements DaqTransport {
  writes: Buffer[] = []
  closed = false
  acknowledgeDac = true
  events?: Parameters<DaqTransport['open']>[1]
  async open(
    _options: Parameters<DaqTransport['open']>[0],
    events: Parameters<DaqTransport['open']>[1],
  ) {
    this.events = events
  }
  async write(data: Buffer) {
    this.writes.push(Buffer.from(data))
    if (data[0] === 0x21 && this.acknowledgeDac)
      this.emit(Buffer.from(`\xd0DAC output set to ${data.readUInt16BE(1)} mV\xd0`, 'latin1'))
  }
  async close() {
    this.closed = true
  }
  emit(data: Buffer) {
    this.events!.data(data)
  }
}
export const connect = { type: 'daq-connect', path: 'COM10', baudRate: 115200 } as const
