import { describe, expect, it, vi } from 'vitest'
import type { BrowserSerial, BrowserSerialPort } from '../src/shared/browser'
import { SerialDaqTransport, SerialRegistry, type DaqTransport } from '../src/infrastructure/serial'
import { SerialPitotTransport } from '../src/infrastructure/pitot-serial'

class NativePort extends EventTarget implements BrowserSerialPort {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  controller: ReadableStreamDefaultController<Uint8Array> | null = null
  opens = 0
  closes = 0
  writes: number[][] = []
  signals: unknown[] = []
  failWrite = false
  rejectOpen = false
  constructor(private readonly kind: 'daq' | 'pitot' = 'daq') {
    super()
  }
  getInfo() {
    return this.kind === 'daq'
      ? { usbVendorId: 0x2e8a, usbProductId: 0xf00f }
      : { usbVendorId: 0x1a86, usbProductId: 0x7523 }
  }
  async open() {
    this.opens++
    if (this.rejectOpen) throw Error('Device busy')
    this.readable = new ReadableStream({
      start: (c) => {
        this.controller = c
      },
      cancel: () => {
        this.controller = null
      },
    })
    this.writable = new WritableStream({
      write: async (bytes) => {
        if (this.failWrite) throw Error('Write disconnected')
        this.writes.push([...bytes])
      },
    })
  }
  async setSignals(signals: unknown) {
    this.signals.push(signals)
  }
  async close() {
    expect(this.readable?.locked).toBe(false)
    expect(this.writable?.locked).toBe(false)
    this.closes++
  }
}
function inventory(ports: NativePort[], selected = ports[0]!) {
  const requestPort = vi.fn(async () => selected)
  const api = Object.assign(new EventTarget(), {
    getPorts: async () => ports,
    requestPort,
  }) as BrowserSerial
  return { registry: new SerialRegistry(() => api), requestPort }
}
const events = () => ({ data: vi.fn(), close: vi.fn(), error: vi.fn() })

describe('Web Serial transport', () => {
  it('requests only the proper USB identity and lists only authorized handles without opening them', async () => {
    const port = new NativePort()
    const { registry, requestPort } = inventory([port])
    await expect(registry.request('daq')).resolves.toMatchObject({
      path: 'USB-1',
      vendorId: '2E8A',
      productId: 'F00F',
    })
    expect(requestPort).toHaveBeenCalledWith({
      filters: [{ usbVendorId: 0x2e8a, usbProductId: 0xf00f }],
    })
    expect(await registry.refresh()).toHaveLength(1)
    expect(port.opens).toBe(0)
  })
  it('preserves arbitrary read fragmentation and exact writes, then cancels and unlocks streams', async () => {
    const port = new NativePort()
    const { registry } = inventory([port])
    await registry.refresh()
    const transport = new SerialDaqTransport(registry)
    const callbacks = events()
    await transport.open({ path: 'USB-1', baudRate: 115200 }, callbacks)
    expect(port.signals).toEqual([{ dataTerminalReady: true, requestToSend: true }])
    port.controller!.enqueue(new Uint8Array([2, 0, 1]))
    port.controller!.enqueue(new Uint8Array([3]))
    await vi.waitFor(() => expect(callbacks.data).toHaveBeenCalledTimes(2))
    await transport.write(new Uint8Array([0x21, 0, 150]))
    expect(port.writes).toEqual([[0x21, 0, 150]])
    await Promise.all([transport.close(), transport.close()])
    expect(port.closes).toBe(1)
    expect(callbacks.close).not.toHaveBeenCalled()
    await transport.open({ path: 'USB-1', baudRate: 115200 }, callbacks)
    await transport.close()
    expect(port.closes).toBe(2)
  })
  it('prevents duplicate ownership and keeps the Pitot independent without asserting DAQ signals', async () => {
    const port = new NativePort('pitot')
    const { registry } = inventory([port])
    await registry.refresh()
    const pitot = new SerialPitotTransport(registry)
    await pitot.open({ path: 'USB-1', baudRate: 115200 }, events())
    await expect(
      new SerialPitotTransport(registry).open({ path: 'USB-1', baudRate: 115200 }, events()),
    ).rejects.toThrow('already in use')
    await expect(
      new SerialDaqTransport(registry).open({ path: 'USB-1', baudRate: 115200 }, events()),
    ).rejects.toThrow('No port was opened')
    expect(port.signals).toEqual([])
    await pitot.close()
  })
  it('reports USB loss through the error path and still releases stream locks on close', async () => {
    const port = new NativePort()
    const { registry } = inventory([port])
    await registry.refresh()
    const transport = new SerialDaqTransport(registry)
    const callbacks = events()
    await transport.open({ path: 'USB-1', baudRate: 115200 }, callbacks)
    port.controller!.error(Error('USB removed'))
    await vi.waitFor(() =>
      expect(callbacks.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'USB removed' }),
      ),
    )
    await transport.close()
    expect(port.closes).toBe(1)
  })
  it('releases a rejected open so an operator can retry after the other owner exits', async () => {
    const port = new NativePort()
    port.rejectOpen = true
    const { registry } = inventory([port])
    await registry.refresh()
    const transport: DaqTransport = new SerialDaqTransport(registry)
    await expect(transport.open({ path: 'USB-1', baudRate: 115200 }, events())).rejects.toThrow(
      'Device busy',
    )
    await transport.close()
    port.rejectOpen = false
    const retry = new SerialDaqTransport(registry)
    await retry.open({ path: 'USB-1', baudRate: 115200 }, events())
    await retry.close()
  })
})
