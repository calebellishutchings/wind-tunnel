import { textOf, utf8 } from '../infrastructure/bytes'
import type { DaqTransport } from '../infrastructure/serial'
import { listSerialPorts } from '../infrastructure/serial'
import { SerialPitotTransport } from '../infrastructure/pitot-serial'
import type { PortInfo } from '../shared/model'
import {
  initialPitot,
  isPitotPort,
  pitotActionSchema,
  PITOT_UUID,
  PITOT_LIMITS_MM,
  type PitotState,
} from '../shared/pitot'
import { planPitotMove } from '../domain/pitot-motion'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
interface Options {
  listPorts?: () => Promise<PortInfo[]>
  transportFactory?: () => DaqTransport
  startupDelayMs?: number
  commandTimeoutMs?: number
  homingTimeoutMs?: number
}
/** One command in flight, no queued moves, no generic G-code API. All positions are open loop. */
export class PitotService {
  private state = initialPitot()
  private transport: DaqTransport | null = null
  private pending: {
    lines: string[]
    resolve: (lines: string[]) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private buffer = ''
  private verified = false
  private busy = false
  private generation = 0
  private motionPossible = false
  constructor(
    private readonly options: Options = {},
    private readonly diagnostic: (message: string) => void = () => {},
  ) {}
  snapshot(): PitotState {
    return structuredClone(this.state)
  }
  async act(input: unknown): Promise<void> {
    const action = pitotActionSchema.parse(input)
    if (action.type === 'stop') return this.stop()
    if (action.type === 'disconnect') return this.disconnect()
    if (this.busy) throw Error('Pitot is busy; wait for completion or press Stop Pitot')
    if (action.type === 'connect' && this.transport)
      throw Error('Disconnect the Pitot before reconnecting')
    if (action.type !== 'connect') {
      if (!this.transport || !this.verified || this.state.status === 'fault')
        throw Error('Connect the Pitot controller first')
      if (action.type === 'move' && !this.snapshot().homed)
        throw Error('Home the Pitot before moving')
    }
    this.busy = true
    try {
      if (action.type === 'connect') await this.connect()
      else {
        if (action.type === 'home') await this.home()
        else await this.move(action.x, action.y)
      }
    } catch (error) {
      if (this.motionPossible) await this.stop().catch(() => {})
      this.state.homed = false
      this.state.position = null
      this.state.status = 'fault'
      this.state.error = String(error)
      this.diagnostic(`Pitot: ${String(error)}`)
      throw error
    } finally {
      this.busy = false
    }
  }
  private async connect(): Promise<void> {
    if (this.transport) throw Error('Disconnect the Pitot before reconnecting')
    this.state = { ...initialPitot(), status: 'connecting' }
    const candidates = (await (this.options.listPorts ?? listSerialPorts)()).filter(isPitotPort)
    if (candidates.length !== 1) {
      this.state.status = 'disconnected'
      throw Error(
        candidates.length
          ? 'Multiple CH340 devices: identify the Pitot before connecting'
          : 'No Pitot USB controller found',
      )
    }
    const path = candidates[0]!.path
    const transport = this.options.transportFactory?.() ?? new SerialPitotTransport()
    this.transport = transport
    this.state.path = path
    this.buffer = ''
    this.verified = false
    const generation = ++this.generation
    try {
      await transport.open(
        { path, baudRate: 115200 },
        {
          data: (chunk) => {
            if (this.transport === transport) this.receive(chunk)
          },
          error: (error) => {
            if (this.transport === transport) this.lost(error)
          },
          close: () => {
            if (this.transport === transport) this.lost(Error('Pitot USB disconnected'))
          },
        },
      )
      await wait(this.options.startupDelayMs ?? 2500)
      this.assertGeneration(generation)
      const identity = (await this.command('M115')).join('\n')
      if (
        !identity.includes('FIRMWARE_NAME:Marlin') ||
        !identity.includes('MACHINE_TYPE:Pitot Mechanism ') ||
        !identity.includes(`UUID:${PITOT_UUID}`) ||
        !identity.includes('Cap:EMERGENCY_PARSER:1')
      )
        throw Error('Controller identity or emergency parser did not match; no homing requested')
      this.verified = true
      await this.home()
    } catch (error) {
      if (this.motionPossible) await this.stop().catch(() => {})
      await this.closeTransport()
      throw error
    }
  }
  private async configure(): Promise<void> {
    // Restore the original values captured BEFORE commissioning; RAM only, never M500.
    for (const command of [
      'G21',
      'G90',
      'M203 X500 Y500',
      'M201 X500 Y500',
      'M204 P500 T1000',
      'M211 S1',
      // Set the inactivity timeout to zero, retaining motor holding torque while connected.
      // With S present, M84 sets a timeout; it does not disable the motors. RAM only.
      'M84 S0',
    ])
      await this.command(command)
    const settings = (await this.command('M503')).join('\n')
    if (
      !/M203 X500\.00 Y500\.00/.test(settings) ||
      !/M201 X500\.00 Y500\.00/.test(settings) ||
      !/M204 P500\.00 R[\d.]+ T1000\.00/.test(settings) ||
      !/M92 X80\.00 Y80\.00/.test(settings) ||
      !/M206 X0\.00 Y0\.00/.test(settings)
    )
      throw Error('Pitot motion settings differ from the inspected controller')
    const limits = (await this.command('M211')).join('\n')
    if (
      !/M211 S1/.test(limits) ||
      !/Min:\s+X0\.00 Y0\.00/.test(limits) ||
      !/Max:\s+X360\.00 Y400\.00/.test(limits)
    )
      throw Error('Pitot software endstops are not confirmed')
    const switches = (await this.command('M119')).join('\n')
    if (!/x_min:\s*(open|TRIGGERED)/.test(switches) || !/y_min:\s*(open|TRIGGERED)/.test(switches))
      throw Error('Both Pitot home switches must be reported')
  }
  private async home(): Promise<void> {
    this.state.homed = false
    this.state.position = null
    this.state.error = null
    this.state.status = 'homing'
    await this.configure()
    this.motionPossible = true
    // Explicit XY only. Bare G28 could seek the unused Z axis indefinitely.
    await this.command('G28 X', this.options.homingTimeoutMs ?? 15000)
    await this.command('G28 Y', this.options.homingTimeoutMs ?? 15000)
    await this.command('M400')
    await this.readPosition(0, 0)
    this.motionPossible = false
    this.state.homed = true
    this.state.status = 'ready'
    this.diagnostic(
      'Pitot X/Y homing completed; Marlin reports zero. Native homing speed restored.',
    )
  }
  private async move(x: number, y: number): Promise<void> {
    const from = this.state.position
    if (!from) throw Error('Home the Pitot before moving')
    const moves = planPitotMove(from, { x, y }, PITOT_LIMITS_MM)
    if (!moves.length) return
    this.state.status = 'moving'
    this.motionPossible = true
    // LabVIEW omitted F and inherited Marlin's feedrate. Make the upstream 4000 mm/min
    // default explicit so a previous commissioning F60 cannot silently persist.
    await this.command('G90')
    for (const move of moves) {
      await this.command(`G1 X${move.x.toFixed(2)} Y${move.y.toFixed(2)} F${move.feedMmMin}`)
      await this.command('M400', move.timeoutMs)
      await this.readPosition(move.x, move.y)
    }
    this.motionPossible = false
    this.state.status = 'ready'
  }
  private async readPosition(x: number, y: number): Promise<void> {
    const lines = await this.command('M114')
    const match = lines
      .map((line) => /^X:([-\d.]+) Y:([-\d.]+) Z:([-\d.]+)/.exec(line))
      .find(Boolean)
    const reported = match
      ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
      : null
    if (
      !reported ||
      !Object.values(reported).every(Number.isFinite) ||
      reported.x < 0 ||
      reported.x > PITOT_LIMITS_MM.x ||
      reported.y < 0 ||
      reported.y > PITOT_LIMITS_MM.y ||
      Math.abs(reported.x - x) > 0.02 ||
      Math.abs(reported.y - y) > 0.02 ||
      reported.z !== 0
    )
      throw Error('Marlin did not report the expected completed X/Y position')
    this.state.position = { x: reported.x, y: reported.y }
  }
  private assertGeneration(generation: number): void {
    if (!this.transport || this.generation !== generation || this.state.status === 'fault')
      throw Error('Pitot operation was stopped or connection changed')
  }
  private async command(
    text: string,
    timeout = this.options.commandTimeoutMs ?? 3000,
  ): Promise<string[]> {
    if (this.pending) throw Error('Pitot command already pending')
    const transport = this.transport
    const generation = this.generation
    this.assertGeneration(generation)
    let pending!: NonNullable<PitotService['pending']>
    const reply = new Promise<string[]>((resolve, reject) => {
      pending = {
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pending === pending) {
            this.pending = null
            reject(Error(`${text}: acknowledgment timeout`))
          }
        }, timeout),
      }
      this.pending = pending
    })
    // Install the receiver before writing: replies may arrive before drain resolves.
    this.log('tx', text)
    try {
      const [lines] = await Promise.all([reply, transport!.write(utf8(text + '\n'))])
      this.assertGeneration(generation)
      return lines
    } finally {
      clearTimeout(pending.timer)
      if (this.pending === pending) this.pending = null
    }
  }
  private receive(chunk: Uint8Array): void {
    this.buffer += textOf(chunk)
    if (this.buffer.length > 32768) {
      this.lost(Error('Pitot response exceeded buffer limit'))
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      this.log('rx', line)
      if (line === 'start' && !this.verified && !this.pending && this.state.status === 'connecting')
        continue
      if (
        /^start$|^(?:Error:|!!|Resend:)|Homing failed|Printer halted|Unknown command/i.test(line)
      ) {
        this.lost(Error(`Pitot controller: ${line}`))
        continue
      }
      const pending = this.pending
      if (!pending) continue
      pending.lines.push(line)
      if (pending.lines.length > 300) {
        this.lost(Error('Too many Pitot response lines'))
        return
      }
      if (/^ok(?:\s|$)/i.test(line)) {
        this.pending = null
        clearTimeout(pending.timer)
        pending.resolve(pending.lines)
      }
    }
  }
  private log(direction: 'rx' | 'tx', text: string): void {
    this.state.transcript = [
      ...this.state.transcript.slice(-119),
      { at: Date.now(), direction, text: text.slice(0, 2000) },
    ]
  }
  private lost(error: Error): void {
    ++this.generation
    this.state.status = 'fault'
    this.state.homed = false
    this.state.position = null
    this.state.error = error.message
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
    if (this.motionPossible) void this.stop().catch(() => {})
  }
  async stop(): Promise<void> {
    ++this.generation
    this.state.homed = false
    this.state.position = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(Error('Pitot stopped'))
      this.pending = null
    }
    if (!this.transport || !this.verified) return
    this.state.status = 'fault'
    this.state.error =
      'Pitot emergency stop requested. Power-cycle the controller, then reconnect and home.'
    this.motionPossible = false
    this.log('tx', 'M112')
    // Emergency parser is verified before motion. Bypass the normal command/ack path.
    await this.transport.write(utf8('M112\n'))
  }
  private async closeTransport(): Promise<void> {
    ++this.generation
    const transport = this.transport
    this.transport = null
    this.verified = false
    this.state.homed = false
    this.state.position = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(Error('Pitot disconnected'))
      this.pending = null
    }
    await transport?.close()
  }
  async disconnect(): Promise<void> {
    try {
      if (this.motionPossible) await this.stop()
    } finally {
      await this.closeTransport()
      this.state.status = 'disconnected'
    }
  }
}
