import { SerialPort } from 'serialport'
import type { DaqTransport } from './serial'
import { listSerialPorts } from './serial'
import { isPitotPort } from '../shared/pitot'

/** Separate owner from the DAQ. USB identity is a candidate filter; M115 must also match. */
export class SerialPitotTransport implements DaqTransport {
  private port: SerialPort | null = null
  private opening: Promise<void> | null = null
  async open(
    options: { path: string; baudRate: number },
    events: Parameters<DaqTransport['open']>[1],
  ): Promise<void> {
    if (this.port) throw Error('Pitot serial session already open')
    const device = (await listSerialPorts()).find((p) => p.path === options.path)
    if (!device || !isPitotPort(device) || options.baudRate !== 115200)
      throw Error('Not the expected Pitot USB candidate')
    const port = new SerialPort({
      ...options,
      autoOpen: false,
      rtscts: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    })
    this.port = port
    port.on('data', events.data)
    port.on('error', events.error)
    port.on('close', events.close)
    const opening = this.operation((done) => port.open(done))
    this.opening = opening
    try {
      await opening
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    } finally {
      this.opening = null
    }
  }
  private operation(invoke: (done: (error?: Error | null) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Pitot serial operation timed out')), 3000)
      invoke((error) => {
        clearTimeout(timer)
        error ? reject(error) : resolve()
      })
    })
  }
  async write(data: Buffer): Promise<void> {
    const port = this.port
    if (!port?.isOpen) throw Error('Pitot port is closed')
    await this.operation((done) => port.write(data, done))
    await this.operation((done) => port.drain(done))
  }
  async close(): Promise<void> {
    const port = this.port
    this.port = null
    try {
      await this.opening?.catch(() => {})
      if (port?.isOpen) await this.operation((done) => port.close(done))
    } finally {
      port?.removeAllListeners()
    }
  }
}
