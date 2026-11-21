#!/usr/bin/env node
// Supervised commissioning only. Fixed 0/50/100/150/0 mV DAC test, no Pitot access.
// Hardware run/stop remains with the operator. A serial/process failure cannot guarantee zero.
const { SerialPort } = require('serialport')
const { createWriteStream, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')
const { finished } = require('node:stream/promises')
const directory = join(__dirname, '../docs/captures')
mkdirSync(directory, { recursive: true })
const destination = join(
  directory,
  `${new Date().toISOString().replaceAll(':', '-')}-fan-check.jsonl`,
)
const log = createWriteStream(destination, { flags: 'wx' })
const record = (data) => log.write(JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ports = () => SerialPort.list()
let serial,
  buffer = Buffer.alloc(0),
  textBuffer = '',
  command = null,
  aborted = false
log.on('error', (error) => {
  aborted = true
  console.error('Capture failed; aborting test:', error.message)
  command?.reject(error)
})
const sizes = { 2: 4, 3: 4, 4: 1, 5: 4, 6: 24 }
function receive(chunk) {
  record({ direction: 'rx', hex: chunk.toString('hex') })
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length) {
    const id = buffer[0]
    if ([0xd0, 0xe0, 0xe1].includes(id)) {
      const end = buffer.indexOf(id, 1)
      if (end < 0) return
      const message = buffer.subarray(1, end).toString('utf8').trim()
      console.log('BOARD:', message)
      textBuffer += message + '\n'
      if (command && message === `DAC output set to ${command.mv} mV`) command.resolve()
      if (command && /DAC.*(failed|unavailable)|not implemented/i.test(message))
        command.reject(Error(message))
      buffer = buffer.subarray(end + 1)
    } else if (sizes[id]) {
      const length = 5 + 4 * sizes[id]
      if (buffer.length < length) return
      buffer = buffer.subarray(length)
    } else {
      aborted = true
      if (command) command.reject(Error('Unrecognized data; refusing further nonzero commands'))
      console.error('Unexpected framing byte:', id)
      buffer = buffer.subarray(1)
    }
  }
}
function operation(invoke) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Serial operation timed out')), 2000)
    invoke((error) => {
      clearTimeout(timer)
      error ? reject(error) : resolve()
    })
  })
}
async function send(hex) {
  if (!serial?.isOpen) throw Error('DAQ is not open')
  record({ direction: 'tx', hex })
  await operation((done) => serial.write(Buffer.from(hex, 'hex'), done))
  await operation((done) => serial.drain(done))
}
async function setDac(mv) {
  if (![0, 50, 100, 150].includes(mv) || (aborted && mv !== 0)) throw Error('Output refused')
  let timer
  const acknowledged = new Promise((resolve, reject) => {
    command = { mv, resolve, reject }
    timer = setTimeout(() => reject(Error(`No firmware acknowledgment for ${mv} mV`)), 1500)
  })
  // Attach rejection handling before the serial write yields.
  const completion = Promise.all([acknowledged, send('21' + mv.toString(16).padStart(4, '0'))])
  try {
    await completion
  } finally {
    clearTimeout(timer)
    command = null
  }
  console.log(
    `CONFIRMED DAC ${mv} mV (nominal amplified reference ${((mv * 3) / 1000).toFixed(2)} V)`,
  )
}
const input = readline.createInterface({ input: process.stdin, output: process.stdout })
async function run() {
  const matches = (await ports()).filter(
    (p) => p.vendorId?.toUpperCase() === '2E8A' && p.productId?.toUpperCase() === 'F00F',
  )
  if (matches.length !== 1) throw Error('Exactly one identified RP2350 DAQ is required')
  record({ event: 'supervised-test', ports: matches, capMillivolts: 150, stepSeconds: 3 })
  console.log('Capture:', destination)
  serial = new SerialPort({ path: matches[0].path, baudRate: 115200, autoOpen: false })
  serial.on('data', receive)
  serial.on('error', (error) => {
    aborted = true
    console.error(error.message)
    record({ error: error.message })
    command?.reject(error)
  })
  serial.on('close', () => {
    aborted = true
    command?.reject(Error('USB closed'))
    console.error('DAQ serial port closed')
  })
  await operation((done) => serial.open(done))
  await operation((done) => serial.set({ dtr: true, rts: true }, done))
  await delay(1500)
  await send('00')
  await delay(350)
  await setDac(0)
  // No nonzero command can be sent until this exact token arrives on stdin.
  console.log(
    'ZERO_CONFIRMED. Waiting for operator readiness. Send RUN within 90 seconds, or ABORT. Keep physical stop available.',
  )
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('ABORT'), 90000)
    input.once('line', (line) => {
      clearTimeout(timer)
      resolve(line.trim())
    })
  })
  if (answer !== 'RUN' || aborted) throw Error('Test not armed; retaining zero output')
  input.on('line', () => {
    aborted = true
  })
  // Sensor commands spaced apart; firmware consumes all pending bytes as one command.
  await send('05000186a0')
  await delay(350)
  await send('04000186a0')
  await delay(350)
  try {
    for (const mv of [50, 100, 150]) {
      if (aborted) throw Error('Test aborted')
      await setDac(mv)
      for (let i = 0; i < 30; i++) {
        await delay(100)
        if (aborted) throw Error('Test aborted')
      }
    }
  } finally {
    await setDac(0)
  }
  console.log(
    'TEST_COMPLETE_ZERO_CONFIRMED. Physically stop the VFD now; no motion commands were sent.',
  )
  await delay(2000)
}
async function cleanup() {
  input.close()
  if (serial?.isOpen) {
    // Retry zero if any failure occurred. A missing acknowledgment is reported, never assumed safe.
    await setDac(0).catch((error) =>
      console.error('ZERO NOT VERIFIED; USE PHYSICAL STOP:', error.message),
    )
    await delay(350)
    await send('00').catch(() => {})
    await operation((done) => serial.close(done)).catch(() => {})
  }
  record({ event: 'finished', aborted })
  log.end()
  await finished(log)
}
process.on('SIGINT', () => {
  aborted = true
  command?.reject(Error('Interrupted'))
})
run()
  .catch((error) => {
    aborted = true
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(cleanup)
