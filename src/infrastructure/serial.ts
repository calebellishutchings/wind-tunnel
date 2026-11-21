import type { PortInfo } from '../shared/model'
import type { BrowserSerial, BrowserSerialPort } from '../shared/browser'
import { isDaqPort } from '../shared/daq-device'
import { isPitotPort } from '../shared/pitot'

export interface DaqTransport {
  open(
    options: { path: string; baudRate: number },
    events: { data: (chunk: Uint8Array) => void; error: (error: Error) => void; close: () => void },
  ): Promise<void>
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}
export type DeviceKind = 'daq' | 'pitot'
const matches = (kind: DeviceKind, port: PortInfo) =>
  kind === 'daq' ? isDaqPort(port) : isPitotPort(port)

/** Only authorized handles. USB-N is a session label, not an OS COM name. */
export class SerialRegistry {
  private handles = new Map<BrowserSerialPort, string>()
  private available = new Set<BrowserSerialPort>()
  private owners = new Set<BrowserSerialPort>()
  private selectedPitot: BrowserSerialPort | undefined
  constructor(private readonly access: () => BrowserSerial | undefined = () => navigator.serial) {}
  private api(): BrowserSerial {
    const serial = this.access()
    if (!serial) throw Error('USB serial requires desktop Edge or Chrome over HTTPS or localhost.')
    return serial
  }
  private register(port: BrowserSerialPort): string {
    if (!this.handles.has(port)) this.handles.set(port, `USB-${this.handles.size + 1}`)
    this.available.add(port)
    return this.handles.get(port)!
  }
  private info(port: BrowserSerialPort): PortInfo {
    const info = port.getInfo()
    const hex = (n: number | undefined) => n?.toString(16).padStart(4, '0').toUpperCase()
    return {
      path: this.handles.get(port)!,
      vendorId: hex(info.usbVendorId),
      productId: hex(info.usbProductId),
    }
  }
  async refresh(): Promise<PortInfo[]> {
    const ports = await this.api().getPorts()
    this.available = new Set(ports)
    ports.forEach((port) => this.register(port))
    return this.list()
  }
  list(): PortInfo[] {
    return [...this.available].map((port) => this.info(port))
  }
  pitotPorts(): PortInfo[] {
    return this.selectedPitot && this.available.has(this.selectedPitot)
      ? [this.info(this.selectedPitot)]
      : this.list().filter(isPitotPort)
  }
  /** Call from a click, before any await that might lose browser user activation. */
  async request(kind: DeviceKind): Promise<PortInfo> {
    const port = await this.api().requestPort({
      filters: [
        kind === 'daq'
          ? { usbVendorId: 0x2e8a, usbProductId: 0xf00f }
          : { usbVendorId: 0x1a86, usbProductId: 0x7523 },
      ],
    })
    this.register(port)
    const info = this.info(port)
    if (!matches(kind, info))
      throw Error(`The selected device is not the expected ${kind} USB device`)
    if (kind === 'pitot') this.selectedPitot = port
    return info
  }
  reserve(path: string, kind: DeviceKind): BrowserSerialPort {
    const port = [...this.available].find((p) => this.handles.get(p) === path)
    if (!port || !matches(kind, this.info(port)))
      throw Error(`Selected port is not the identified ${kind} USB device. No port was opened.`)
    if (this.owners.has(port)) throw Error('This USB serial device is already in use')
    this.owners.add(port)
    return port
  }
  release(port: BrowserSerialPort): void {
    this.owners.delete(port)
  }
}
export const serialRegistry = new SerialRegistry()
export const listSerialPorts = (): Promise<PortInfo[]> => serialRegistry.refresh()

export function serialDeadline<T>(operation: Promise<T>, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('USB serial operation timed out')), timeoutMs)
    operation.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** One reader/writer per handle; cancel the reader before releasing stream locks. */
export class BrowserSerialTransport implements DaqTransport {
  private port: BrowserSerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reading: Promise<void> | null = null
  private opening: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private intentionalClose = false
  private opened = false
  private events: Parameters<DaqTransport['open']>[1] | null = null
  constructor(
    private readonly kind: DeviceKind,
    private readonly registry = serialRegistry,
  ) {}
  async open(
    options: { path: string; baudRate: number },
    events: Parameters<DaqTransport['open']>[1],
  ): Promise<void> {
    if (this.port) throw Error('USB serial session is already open')
    if (this.kind === 'pitot' && options.baudRate !== 115200)
      throw Error('Pitot requires 115200 baud')
    const port = this.registry.reserve(options.path, this.kind)
    this.port = port
    this.events = events
    this.intentionalClose = false
    this.opening = port
      .open({
        baudRate: options.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
      })
      .then(() => {
        this.opened = true
      })
    try {
      await serialDeadline(this.opening)
      if (this.intentionalClose) throw Error('USB connection was canceled')
      if (!port.readable || !port.writable) throw Error('USB serial streams are unavailable')
      this.reader = port.readable.getReader()
      this.writer = port.writable.getWriter()
      this.reading = this.read(events)
      if (this.kind === 'daq')
        await serialDeadline(port.setSignals({ dataTerminalReady: true, requestToSend: true }))
    } catch (error) {
      // Keep a late-opening handle quarantined until cleanup finishes, without hanging the UI.
      void this.close().catch(() => {})
      throw error
    }
  }
  private async read(events: Parameters<DaqTransport['open']>[1]): Promise<void> {
    try {
      while (!this.intentionalClose && this.reader) {
        const { value, done } = await this.reader.read()
        if (this.intentionalClose) break
        if (done) {
          events.close()
          break
        }
        if (value?.length) events.data(value)
      }
    } catch (error) {
      if (!this.intentionalClose)
        events.error(error instanceof Error ? error : Error(String(error)))
    }
  }
  async write(data: Uint8Array): Promise<void> {
    if (!this.writer || this.intentionalClose) throw Error('USB serial port is not open')
    try {
      await serialDeadline(this.writer.write(data))
    } catch (error) {
      if (!this.intentionalClose)
        this.events?.error(error instanceof Error ? error : Error(String(error)))
      throw error
    }
  }
  close(): Promise<void> {
    if (this.closing) return serialDeadline(this.closing)
    this.intentionalClose = true
    const port = this.port
    this.closing = (async () => {
      try {
        // Closing during open still closes the eventual handle before it can be reused.
        await this.opening?.catch(() => {})
        await this.reader?.cancel().catch(() => {})
        await this.reading
        this.reader?.releaseLock()
        this.writer?.releaseLock()
        if (port && this.opened) await port.close()
        if (port) this.registry.release(port)
      } finally {
        // A handle whose close failed stays reserved; never silently share uncertain ownership.
        this.port = null
        this.opened = false
        this.reader = null
        this.writer = null
        this.events = null
      }
    })().finally(() => {
      this.closing = null
    })
    return serialDeadline(this.closing)
  }
}
export class SerialDaqTransport extends BrowserSerialTransport {
  constructor(registry = serialRegistry) {
    super('daq', registry)
  }
}
