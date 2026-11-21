import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

declare global {
  interface Window {
    fixture: {
      writes: { kind: string; command: string }[]
      opens: Record<string, number>
      closes: Record<string, number>
      files: Record<string, string>
      dropDac: boolean
      hold: string | null
      cancelChooser: boolean
      calibration: string
      loseDaq(): void
    }
  }
}

function capturedFrames(): number[][] {
  const rows = readFileSync('docs/captures/2026-11-05T15-57-56.627Z-COM10-115200-all.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { direction?: string; hex?: string })
  const bytes = Buffer.concat(
    rows.filter((r) => r.direction === 'rx').map((r) => Buffer.from(r.hex!, 'hex')),
  )
  const frames: number[][] = []
  const sizes: Record<number, number> = { 2: 21, 3: 21, 4: 9, 5: 21, 6: 101 }
  for (let offset = 0; offset < bytes.length;) {
    const id = bytes[offset]!
    let length = sizes[id] ?? 0
    if ([0xd0, 0xe0, 0xe1].includes(id)) {
      const end = bytes.indexOf(id, offset + 1)
      if (end < 0) break
      length = end - offset + 1
    }
    if (!length || offset + length > bytes.length) break
    frames.push([...bytes.subarray(offset, offset + length)])
    offset += length
  }
  return frames
}

/** Inject native API fixtures only. Production services, storage, UI and bytes remain real. */
export async function fixtureBrowser(page: Page): Promise<void> {
  await page.addInitScript(
    ({ frames }) => {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const state: Window['fixture'] = {
        writes: [],
        opens: { daq: 0, pitot: 0 },
        closes: { daq: 0, pitot: 0 },
        files: {},
        dropDac: false,
        hold: null,
        cancelChooser: false,
        calibration: '{}',
        loseDaq: () => {},
      }
      window.fixture = state
      class Port extends EventTarget {
        readable: ReadableStream<Uint8Array> | null = null
        writable: WritableStream<Uint8Array> | null = null
        controller: ReadableStreamDefaultController<Uint8Array> | null = null
        timer: ReturnType<typeof setInterval> | undefined
        index = 0
        x = 0
        y = 0
        constructor(readonly kind: 'daq' | 'pitot') {
          super()
        }
        getInfo() {
          return this.kind === 'daq'
            ? { usbVendorId: 0x2e8a, usbProductId: 0xf00f }
            : { usbVendorId: 0x1a86, usbProductId: 0x7523 }
        }
        emit(bytes: Uint8Array) {
          this.controller?.enqueue(bytes)
        }
        async open() {
          state.opens[this.kind]!++
          this.index = 0
          this.readable = new ReadableStream({
            start: (controller) => {
              this.controller = controller
            },
            cancel: () => {
              this.controller = null
            },
          })
          this.writable = new WritableStream({ write: (bytes) => this.write(bytes) })
        }
        async setSignals() {}
        async close() {
          if (this.readable?.locked || this.writable?.locked)
            throw Error('Closed before releasing stream locks')
          clearInterval(this.timer)
          this.controller?.close()
          this.controller = null
          state.closes[this.kind]!++
        }
        write(bytes: Uint8Array) {
          if (this.kind === 'daq') {
            state.writes.push({
              kind: 'daq',
              command: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
            })
            if (bytes[0] === 0x21 && !state.dropDac) {
              const mv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1)
              this.emit(
                new Uint8Array([0xd0, ...encoder.encode(`DAC output set to ${mv} mV`), 0xd0]),
              )
            }
            if (bytes[0] === 0) clearInterval(this.timer)
            if (bytes[0] === 1) {
              clearInterval(this.timer)
              this.timer = setInterval(() => {
                if (this.index < frames.length) this.emit(new Uint8Array(frames[this.index++]!))
                else clearInterval(this.timer)
              }, 20)
            }
            return
          }
          const command = decoder.decode(bytes).trim()
          state.writes.push({ kind: 'pitot', command })
          if (command === 'M112') return
          if (command === 'G28 X') this.x = 0
          if (command === 'G28 Y') this.y = 0
          if (command.startsWith('G1 ')) {
            this.x = Number(/X([\d.]+)/.exec(command)![1])
            this.y = Number(/Y([\d.]+)/.exec(command)![1])
          }
          if (command === state.hold) return
          const reply: Record<string, string> = {
            M115: 'FIRMWARE_NAME:Marlin bugfix-2.1.x MACHINE_TYPE:Pitot Mechanism KINEMATICS:Cartesian UUID:cede2a2f-41a2-4748-9b12-c55c62f367ff\nCap:EMERGENCY_PARSER:1\nok\n',
            M503: 'echo: M92 X80.00 Y80.00 Z400.00 E93.00\necho: M203 X500.00 Y500.00 Z500.00 E500.00\necho: M201 X500.00 Y500.00 Z100.00 E1000.00\necho: M204 P500.00 R500.00 T1000.00\necho: M206 X0.00 Y0.00 Z0.00\nok\n',
            M211: 'M211 S1 ; ON\n Min:  X0.00 Y0.00 Z0.00   Max:  X360.00 Y400.00 Z250.00\nok\n',
            M119: 'x_min: open\ny_min: open\nok\n',
            M114: `X:${this.x.toFixed(2)} Y:${this.y.toFixed(2)} Z:0.00 E:0.00\nok\n`,
          }
          this.emit(encoder.encode(reply[command] ?? 'ok\n'))
        }
      }
      const daq = new Port('daq'),
        pitot = new Port('pitot')
      state.loseDaq = () => {
        clearInterval(daq.timer)
        daq.controller?.error(Error('USB device disconnected'))
        daq.controller = null
      }
      const serial = new EventTarget() as EventTarget & {
        getPorts(): Promise<Port[]>
        requestPort(options: { filters: { usbVendorId: number }[] }): Promise<Port>
      }
      serial.getPorts = async () =>
        [daq, pitot].filter((p) => localStorage.getItem(`fixture-grant-${p.kind}`) === 'yes')
      serial.requestPort = async ({ filters }) => {
        if (state.cancelChooser)
          throw new DOMException('User canceled device selection', 'NotFoundError')
        const port = filters[0]!.usbVendorId === 0x2e8a ? daq : pitot
        localStorage.setItem(`fixture-grant-${port.kind}`, 'yes')
        return port
      }
      Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
      window.showSaveFilePicker = async ({ suggestedName }) => ({
        getFile: async () => new File([], suggestedName),
        createWritable: async () => {
          let text = ''
          return {
            write: async (chunk: string | Uint8Array) => {
              text += typeof chunk === 'string' ? chunk : decoder.decode(chunk)
            },
            close: async () => {
              state.files[suggestedName] = text
            },
            abort: async () => {},
          }
        },
      })
      window.showOpenFilePicker = async () => [
        { getFile: async () => new File([state.calibration], 'hardware-calibrations.json') },
      ]
    },
    { frames: capturedFrames() },
  )
}

export async function connectDaq(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hardware', exact: true }).click()
  await page.getByRole('button', { name: 'Choose DAQ device', exact: true }).click()
  await page.getByRole('button', { name: 'Connect and read DAQ', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.acquisition)))
    .toBe('running')
}
