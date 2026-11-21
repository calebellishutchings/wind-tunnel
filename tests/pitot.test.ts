import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PitotService } from '../src/main/pitot-service'
import { PITOT_UUID, pitotActionSchema } from '../src/shared/pitot'
import type { DaqTransport } from '../src/infrastructure/serial'

const identity = `FIRMWARE_NAME:Marlin bugfix-2.1.x MACHINE_TYPE:Pitot Mechanism KINEMATICS:Cartesian UUID:${PITOT_UUID}\nCap:EMERGENCY_PARSER:1\nok\n`
const settings =
  'echo: M92 X80.00 Y80.00 Z400.00 E93.00\necho: M203 X500.00 Y500.00 Z500.00 E500.00\necho: M201 X500.00 Y500.00 Z100.00 E1000.00\necho: M204 P500.00 R500.00 T1000.00\necho: M206 X0.00 Y0.00 Z0.00\nok\n'
const limits = 'M211 S1 ; ON\n Min:  X0.00 Y0.00 Z0.00   Max:  X360.00 Y400.00 Z250.00\nok\n'
class MarlinFixture implements DaqTransport {
  events!: Parameters<DaqTransport['open']>[1]
  writes: string[] = []
  overrides: Record<string, string> = {}
  hold: string | null = null
  closed = false
  x = 0
  y = 0
  async open(_o: unknown, events: typeof this.events) {
    this.events = events
  }
  emit(text: string) {
    this.events.data(Buffer.from(text))
  }
  async write(bytes: Uint8Array) {
    const command = Buffer.from(bytes).toString().trim()
    this.writes.push(command)
    if (command === this.hold || command === 'M112') return
    if (command === 'G28 X') this.x = 0
    if (command === 'G28 Y') this.y = 0
    if (command.startsWith('G1 ')) {
      this.x = Number(/X([\d.]+)/.exec(command)![1])
      this.y = Number(/Y([\d.]+)/.exec(command)![1])
    }
    const response =
      this.overrides[command] ??
      (
        {
          M115: identity,
          M503: settings,
          M211: limits,
          M119: 'x_min: open\ny_min: open\nz_min: TRIGGERED\nok\n',
          M114: `X:${this.x.toFixed(2)} Y:${this.y.toFixed(2)} Z:0.00 E:0.00 Count X:0 Y:0 Z:0\nok\n`,
        } as Record<string, string>
      )[command] ??
      'ok\n'
    // Exercise framing independently of USB chunk boundaries.
    for (let i = 0; i < response.length; i += 7) this.emit(response.slice(i, i + 7))
  }
  async close() {
    this.closed = true
  }
}
describe('Pitot motion ownership', () => {
  let service: PitotService
  afterEach(async () => {
    await service?.disconnect()
  })
  function setup() {
    const fixture = new MarlinFixture()
    service = new PitotService({
      transportFactory: () => fixture,
      listPorts: async () => [{ path: 'COM14', vendorId: '1A86', productId: '7523' }],
      startupDelayMs: 0,
      commandTimeoutMs: 30,
      homingTimeoutMs: 40,
    })
    return fixture
  }
  it('homes only X/Y on every connection, restoring original runtime limits before motion', async () => {
    const fixture = setup()
    await service.act({ type: 'connect' })
    expect(service.snapshot()).toMatchObject({
      status: 'ready',
      homed: true,
      position: { x: 0, y: 0 },
    })
    expect(fixture.writes).toEqual([
      'M115',
      'G21',
      'G90',
      'M203 X500 Y500',
      'M201 X500 Y500',
      'M204 P500 T1000',
      'M211 S1',
      'M84 S0',
      'M503',
      'M211',
      'M119',
      'G28 X',
      'G28 Y',
      'M400',
      'M114',
    ])
    await service.act({ type: 'disconnect' })
    expect(service.snapshot().homed).toBe(false)
    fixture.closed = false
    await service.act({ type: 'connect' })
    expect(fixture.writes.filter((c) => c === 'G28 X')).toHaveLength(2)
    expect(fixture.writes.some((c) => /M500|M502|M999|G92|G28$|G28 Z|^M84$/.test(c))).toBe(false)
  })
  it('uses the captured original identity/settings without executing the M503 report as commands', async () => {
    const fixture = setup()
    const rows = (
      await readFile('docs/captures/2026-11-19T16-52-57.766Z-pitot-inspection.jsonl', 'utf8')
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { direction?: string; text?: string })
    let current = ''
    const responses: Record<string, string> = {}
    for (const row of rows) {
      if (row.direction === 'tx') current = row.text!.trim()
      if (row.direction === 'rx') responses[current] = (responses[current] ?? '') + row.text
    }
    fixture.overrides = {
      M115: responses.M115!,
      M503: responses.M503!,
      M211: responses.M211!,
      M119: responses.M119!,
      M114: responses.M114!,
    }
    await service.act({ type: 'connect' })
    expect(service.snapshot().homed).toBe(true)
    // Reports include heater settings; host must never send those settings back.
    expect(fixture.writes.some((c) => /^M10[49]|^M140|^M190/.test(c))).toBe(false)
  })
  it.each([
    'wrong identity',
    'no emergency parser',
    'wrong settings',
    'wrong limits',
    'missing switch',
  ])('does not home with %s', async (kind) => {
    const fixture = setup()
    if (kind === 'wrong identity') fixture.overrides.M115 = identity.replace(PITOT_UUID, 'other')
    if (kind === 'no emergency parser')
      fixture.overrides.M115 = identity.replace('PARSER:1', 'PARSER:0')
    if (kind === 'wrong settings') fixture.overrides.M503 = settings.replace('X80.00', 'X100.00')
    if (kind === 'wrong limits') fixture.overrides.M211 = limits.replace('M211 S1', 'M211 S0')
    if (kind === 'missing switch') fixture.overrides.M119 = 'x_min: open\nok\n'
    await expect(service.act({ type: 'connect' })).rejects.toThrow()
    expect(fixture.writes.some((c) => c.startsWith('G28') || c.startsWith('G1 '))).toBe(false)
    expect(fixture.closed).toBe(true)
  })
  it('retains homing across idle time and snapshots, and rejects arbitrary/out-of-range moves', async () => {
    const fixture = setup()
    await service.act({ type: 'connect' })
    await service.act({ type: 'move', x: 2, y: 1 })
    expect(fixture.writes.slice(-4)).toEqual(['G90', 'G1 X2.00 Y1.00 F300', 'M400', 'M114'])
    for (const action of [
      { type: 'move', x: 360.001, y: 0 },
      { type: 'move', x: 0, y: 360.001 },
      { type: 'move', x: -1, y: 0 },
      { type: 'move', x: NaN, y: 0 },
      { type: 'gcode', text: 'G28 Z' },
      { type: 'move', x: 0, y: 0, raw: 'G92 X0' },
    ])
      expect(pitotActionSchema.safeParse(action).success).toBe(false)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000)
    try {
      for (let i = 0; i < 20; i++) expect(service.snapshot().homed).toBe(true)
    } finally {
      clock.mockRestore()
    }
    await service.act({ type: 'move', x: 360, y: 360 })
    expect(service.snapshot().position).toEqual({ x: 360, y: 360 })
    expect(fixture.writes.filter((c) => c === 'G28 X')).toHaveLength(1)
    expect(service.snapshot().homed).toBe(true)
  })
  it.each([
    { ports: [] },
    { ports: [{ path: 'COM10', vendorId: '2E8A', productId: 'F00F' }] },
    {
      ports: [
        { path: 'COM14', vendorId: '1A86', productId: '7523' },
        { path: 'COM15', vendorId: '1A86', productId: '7523' },
      ],
    },
  ])('opens no transport for absent/ambiguous Pitot inventory $ports', async ({ ports }) => {
    let opened = false
    service = new PitotService({
      listPorts: async () => ports,
      transportFactory: () => {
        opened = true
        return new MarlinFixture()
      },
    })
    await expect(service.act({ type: 'connect' })).rejects.toThrow()
    expect(opened).toBe(false)
  })
  it('faults and requests stop when completed position disagrees with the target', async () => {
    const fixture = setup()
    await service.act({ type: 'connect' })
    fixture.overrides.M114 = 'X:0.00 Y:0.00 Z:0.00\nok\n'
    await expect(service.act({ type: 'move', x: 2, y: 0 })).rejects.toThrow('expected')
    expect(fixture.writes.at(-1)).toBe('M112')
    expect(service.snapshot().homed).toBe(false)
  })
  it.each(['X:- Y:0.00 Z:0.00\nok\n', 'X:360.01 Y:0.00 Z:0.00\nok\n'])(
    'rejects malformed or out-of-range controller positions %s',
    async (response) => {
      const fixture = setup()
      await service.act({ type: 'connect' })
      fixture.overrides.M114 = response
      await expect(service.act({ type: 'move', x: 360, y: 0 })).rejects.toThrow('expected')
      expect(service.snapshot()).toMatchObject({ homed: false, position: null, status: 'fault' })
      expect(fixture.writes.at(-1)).toBe('M112')
      expect(fixture.writes.filter((c) => c.startsWith('G1 '))).toHaveLength(1)
    },
  )
  it('USB loss during X homing cannot queue a Y move or leave a trusted position', async () => {
    const fixture = setup()
    fixture.hold = 'G28 X'
    const pending = service.act({ type: 'connect' })
    const rejected = expect(pending).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    fixture.events.close()
    await rejected
    expect(fixture.writes).not.toContain('G28 Y')
    expect(service.snapshot()).toMatchObject({ homed: false, position: null, status: 'fault' })
  })
  it('does not label a move complete on G1 ok, rejects overlapping requests, and interrupts M400 immediately', async () => {
    const fixture = setup()
    await service.act({ type: 'connect' })
    fixture.hold = 'M400'
    const moving = service.act({ type: 'move', x: 360, y: 360 })
    const rejected = expect(moving).rejects.toThrow('stopped')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(service.snapshot().status).toBe('moving')
    await expect(service.act({ type: 'home' })).rejects.toThrow('busy')
    await service.act({ type: 'stop' })
    await rejected
    expect(fixture.writes.at(-1)).toBe('M112')
    expect(fixture.writes.filter((c) => c.startsWith('G1 '))).toEqual(['G1 X5.00 Y5.00 F300'])
    expect(service.snapshot()).toMatchObject({ status: 'fault', homed: false, position: null })
  })
  it('does not send a Y home after emergency stop interrupts X homing', async () => {
    const fixture = setup()
    fixture.hold = 'G28 X'
    const connecting = service.act({ type: 'connect' })
    const rejected = expect(connecting).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await service.stop()
    await rejected
    expect(fixture.writes).toContain('M112')
    expect(fixture.writes).not.toContain('G28 Y')
  })
  it('busy messages cannot extend a fixed homing timeout', async () => {
    const fixture = setup()
    fixture.hold = 'G28 X'
    const pending = service.act({ type: 'connect' })
    const rejected = expect(pending).rejects.toThrow('timeout')
    const timer = setInterval(() => fixture.emit('echo:busy: processing\n'), 3)
    try {
      await rejected
    } finally {
      clearInterval(timer)
    }
    expect(fixture.writes).toContain('M112')
    expect(service.snapshot().homed).toBe(false)
  })
  it.each(['start\n', 'Error:Printer halted\n'])(
    'invalidates homing after controller reset/error %s',
    async (line) => {
      const fixture = setup()
      await service.act({ type: 'connect' })
      fixture.emit(line)
      expect(service.snapshot()).toMatchObject({ status: 'fault', homed: false, position: null })
      const count = fixture.writes.length
      await expect(service.act({ type: 'move', x: 0, y: 0 })).rejects.toThrow('Connect')
      expect(fixture.writes).toHaveLength(count)
    },
  )
})
