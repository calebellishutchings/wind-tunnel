// Read-only Marlin inspection. No homing, motion, reset, EEPROM writes or firmware upload.
const { SerialPort } = require('serialport')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const requested = process.argv[2]
  if (!/^COM[1-9]\d*$/i.test(requested || ''))
    throw Error('Usage: node scripts/inspect-pitot.cjs COM14')
  const device = (await SerialPort.list()).find(
    (p) => p.path.toUpperCase() === requested.toUpperCase(),
  )
  if (device?.vendorId?.toUpperCase() !== '1A86' || device?.productId?.toUpperCase() !== '7523')
    throw Error('Not the expected CH340 controller; no port opened')
  const directory = path.resolve('docs/captures')
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(
    directory,
    `${new Date().toISOString().replaceAll(':', '-')}-pitot-inspection.jsonl`,
  )
  const log = (row) => {
    const entry = { at: new Date().toISOString(), ...row }
    fs.appendFileSync(filename, JSON.stringify(entry) + '\n')
    console.log(JSON.stringify(entry))
  }
  log({
    kind: 'device',
    device,
    baudRate: 115200,
    purpose: 'Read-only inspection; no motion commands',
  })
  const port = new SerialPort({ path: requested, baudRate: 115200, autoOpen: false, rtscts: false })
  let pending = null
  let buffer = ''
  let fatal = null
  port.on('error', (error) => {
    fatal = error
    pending?.reject(error)
  })
  port.on('data', (chunk) => {
    log({ direction: 'rx', text: chunk.toString('utf8'), hex: chunk.toString('hex') })
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (/^(?:Error:|!!|Resend:)/i.test(line)) pending?.reject(Error(line))
      else if (/^ok(?:\s|$)/i.test(line)) pending?.resolve()
    }
    if (buffer.length > 65536) {
      fatal = Error('Unexpected serial data')
      pending?.reject(fatal)
    }
  })
  try {
    await new Promise((resolve, reject) =>
      port.open((error) => (error ? reject(error) : resolve())),
    )
    // Opening serial can reset some printer controllers. Allow startup to settle.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    for (const command of ['M115', 'M503', 'M119', 'M114', 'M211']) {
      if (fatal) throw fatal
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`${command}: no acknowledgment within 5 seconds`)),
          5000,
        )
        pending = {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        }
        log({ direction: 'tx', text: command + '\n' })
        port.write(command + '\n', (error) => {
          if (error) pending?.reject(error)
        })
      })
      pending = null
    }
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
