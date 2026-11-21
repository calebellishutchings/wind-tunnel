import { SerialPort } from 'serialport'
import type { PortInfo } from '../shared/model'
import { isDaqPort } from '../shared/daq-device'

/** Enumeration only. Listing devices does not open a port or send startup commands. */
export async function listSerialPorts(): Promise<PortInfo[]> {
  return (await SerialPort.list()).map(
    ({ path, manufacturer, serialNumber, vendorId, productId }) => ({
      path,
      manufacturer,
      serialNumber,
      vendorId,
      productId,
    }),
  )
}

export interface DaqTransport {
  open(
    options: { path: string; baudRate: number },
    events: { data: (chunk: Buffer) => void; error: (error: Error) => void; close: () => void },
  ): Promise<void>
  write(data: Buffer): Promise<void>
  close(): Promise<void>
}
function serialOperation(invoke: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('DAQ serial operation timed out after 3 seconds')),
      3000,
    )
    invoke((error) => {
      clearTimeout(timer)
      error ? reject(error) : resolve()
    })
  })
}

/** Single-owner serial session; exposes no commands to the renderer. */
export class SerialDaqTransport implements DaqTransport {
  private port: SerialPort | null = null
  async open(
    options: { path: string; baudRate: number },
    events: { data: (chunk: Buffer) => void; error: (error: Error) => void; close: () => void },
  ): Promise<void> {
    if (this.port) throw new Error('DAQ serial session is already open')
    const device = (await listSerialPorts()).find(
      (port) => port.path.toUpperCase() === options.path.toUpperCase(),
    )
    if (!device || !isDaqPort(device))
      throw new Error(
        'Selected port is not the identified RP2350 DAQ (USB 2E8A:F00F). No port was opened; Pitot/CH340 devices are excluded.',
      )
    const port = new SerialPort({
      ...options,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
    })
    this.port = port
    port.on('data', events.data)
    port.on('error', events.error)
    port.on('close', events.close)
    try {
      await serialOperation((done) => port.open(done))
      await serialOperation((done) => port.set({ dtr: true, rts: true }, done))
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    }
  }
  async write(data: Buffer): Promise<void> {
    const port = this.port
    if (!port?.isOpen) throw new Error('DAQ serial port is not open')
    await serialOperation((done) => port.write(data, done))
    await serialOperation((done) => port.drain(done))
  }
  async close(): Promise<void> {
    const port = this.port
    this.port = null
    if (port?.isOpen) await serialOperation((done) => port.close(done))
    port?.removeAllListeners()
  }
}
