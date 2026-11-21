// Supervised, single-phase commissioning. Never uploads firmware or writes EEPROM.
// Each invocation performs ONE explicitly selected axis phase and then exits.
const { SerialPort } = require('serialport')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const [requested, phase] = process.argv.slice(2)
  if (!/^COM[1-9]\d*$/i.test(requested || '') || !['home-x', 'home-y', 'test-x'].includes(phase))
    throw Error('Usage: node scripts/commission-pitot.cjs COM14 home-x|home-y|test-x')
  const device = (await SerialPort.list()).find(
    (p) => p.path.toUpperCase() === requested.toUpperCase(),
  )
  if (device?.vendorId?.toUpperCase() !== '1A86' || device?.productId?.toUpperCase() !== '7523')
    throw Error('Not the expected CH340 controller; no port opened')
  const filename = path.resolve(
    'docs/captures',
    `${new Date().toISOString().replaceAll(':', '-')}-pitot-${phase}.jsonl`,
  )
  const log = (row) => {
    const entry = { at: new Date().toISOString(), ...row }
    fs.appendFileSync(filename, JSON.stringify(entry) + '\n')
    console.log(JSON.stringify(entry))
  }
  log({ kind: 'device', device, phase, speedCapMmPerSec: 1, accelerationCapMmPerSec2: 10 })
  const port = new SerialPort({ path: requested, baudRate: 115200, autoOpen: false, rtscts: false })
  let pending = null,
    buffer = '',
    failed = null,
    motionStarted = false
  port.on('error', (e) => {
    failed = e
    pending?.reject(e)
  })
  port.on('data', (chunk) => {
    log({ direction: 'rx', text: chunk.toString('utf8'), hex: chunk.toString('hex') })
    buffer += chunk.toString('utf8')
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      pending?.lines.push(line)
      if (/^(?:Error:|!!|Resend:)|Homing failed|Printer halted|Unknown command/i.test(line)) {
        failed = Error(line)
        pending?.reject(failed)
      } else if (/^ok(?:\s|$)/i.test(line)) pending?.resolve()
    }
  })
  const command = async (text, timeout = 5000) => {
    if (failed) throw failed
    const lines = []
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`${text}: acknowledgment timeout`)), timeout)
      pending = {
        lines,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      log({ direction: 'tx', text: text + '\n' })
      port.write(text + '\n', (e) => {
        if (e) pending?.reject(e)
      })
    })
    pending = null
    return lines.join('\n')
  }
  try {
    await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const identity = await command('M115')
    if (
      !/FIRMWARE_NAME:Marlin/.test(identity) ||
      !/MACHINE_TYPE:Pitot Mechanism/.test(identity) ||
      !/Cap:EMERGENCY_PARSER:1/.test(identity)
    )
      throw Error('Unexpected controller or no emergency parser; no movement requested')
    const endstops = await command('M119')
    if (
      phase !== 'test-x' &&
      (!/x_min:\s*TRIGGERED/.test(endstops) || !/y_min:\s*TRIGGERED/.test(endstops))
    )
      throw Error('Commissioning requires both axes physically at their confirmed home switches')
    if (
      phase === 'test-x' &&
      (!/x_min:\s*(?:TRIGGERED|open)/.test(endstops) ||
        !/y_min:\s*(?:TRIGGERED|open)/.test(endstops))
    )
      throw Error('Both home-switch reports are required')
    await command('G21')
    await command('G90')
    await command('M203 X1 Y1')
    await command('M201 X10 Y10')
    await command('M204 P10 T10')
    await command('M211 S1')
    const settings = await command('M503')
    if (!/M203 X1\.00 Y1\.00/.test(settings) || !/M201 X10\.00 Y10\.00/.test(settings))
      throw Error('Slow motion caps not confirmed; no movement requested')
    if (phase === 'test-x') {
      // The operator confirmed both axes' homing and that both remain near home.
      // Re-home in THIS connection rather than trusting old position/capture files.
      motionStarted = true
      await command('G28 X', 20000)
      await command('G28 Y', 20000)
      await command('M400')
      const zero = await command('M114')
      if (!/^X:0\.00 Y:0\.00/m.test(zero)) throw Error('Zero position not confirmed')
      await command('G1 X2.00 Y0.00 F60')
      await command('M400', 8000)
      const position = await command('M114')
      if (!/^X:2\.00 Y:0\.00/m.test(position)) throw Error('Test target not confirmed')
      await command('M119')
      motionStarted = false
      log({
        kind: 'phase-complete',
        phase,
        note: 'Stopped at X2/Y0. Await physical observation; no further movement.',
      })
      return
    }
    motionStarted = true
    await command(phase === 'home-x' ? 'G28 X' : 'G28 Y', 20000)
    await command('M400')
    await command('M114')
    await command('M119')
    motionStarted = false
    log({
      kind: 'phase-complete',
      phase,
      note: 'No further motion requested. Motors are not deliberately disabled.',
    })
  } catch (error) {
    if (motionStarted && port.isOpen) {
      log({ direction: 'tx', text: 'M112\n', reason: String(error) })
      await new Promise((resolve) => port.write('M112\n', () => port.drain(() => resolve())))
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw error
  } finally {
    pending = null
    if (port.isOpen) await new Promise((resolve) => port.close(() => resolve()))
    log({ kind: 'closed', filename })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
