#!/usr/bin/env node
// Bounded sensor-acquisition probe. Deliberately sends no DAC or motion commands.
const { SerialPort } = require('serialport')
const { mkdirSync, createWriteStream } = require('node:fs')
const { join } = require('node:path')
const { finished } = require('node:stream/promises')

const args = process.argv.slice(2)
const argument = (name, fallback) => args[args.indexOf(name) + 1] ?? fallback
const path = args.includes('--port') ? argument('--port') : 'COM9'
const baudRate = args.includes('--baud') ? Number(argument('--baud')) : 115200
const plan = args.includes('--plan') ? argument('--plan') : 'all'
const seconds = args.includes('--seconds') ? Number(argument('--seconds')) : 2
if (
  !['listen', 'all', 'banks', 'short'].includes(plan) ||
  !/^COM\d+$/i.test(path) ||
  ![9600, 115200].includes(baudRate) ||
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 30
) {
  throw new Error(
    'Usage: node scripts/probe-daq.cjs --port COM10 --baud 115200 --plan listen|all|banks|short [--seconds 1..30]',
  )
}
mkdirSync(join(__dirname, '../docs/captures'), { recursive: true })
const destination = join(
  __dirname,
  '../docs/captures',
  `${new Date().toISOString().replaceAll(':', '-')}-${path}-${baudRate}-${plan}.jsonl`,
)
const log = createWriteStream(destination, { flags: 'wx' })
log.on('error', (error) => {
  console.error('Capture error:', error.message)
  process.exitCode = 1
})
let stage = 'open'
let total = 0
let shown = 0
const record = (data) =>
  log.write(JSON.stringify({ at: new Date().toISOString(), stage, ...data }) + '\n')
const serial = new SerialPort({
  path,
  baudRate,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false,
  xon: false,
  xoff: false,
  autoOpen: false,
})
serial.on('data', (chunk) => {
  total += chunk.length
  record({ direction: 'rx', bytes: chunk.length, hex: chunk.toString('hex') })
  if (shown++ < 5)
    console.log(
      'RX',
      stage,
      chunk.length,
      chunk.subarray(0, 240).toString('hex'),
      JSON.stringify(
        chunk
          .subarray(0, 240)
          .toString('latin1')
          .replace(/[^\x20-\x7e\r\n]/g, '.'),
      ),
    )
})
serial.on('error', (error) => {
  record({ error: error.message })
  console.error('Serial error:', error.message)
})
serial.on('close', () => record({ event: 'close' }))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const operation = (invoke) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serial operation timed out')), 3000)
    invoke((error) => {
      clearTimeout(timer)
      error ? reject(error) : resolve()
    })
  })
async function send(hex) {
  const data = Buffer.from(hex, 'hex')
  record({ direction: 'tx', hex: data.toString('hex') })
  console.log('TX', stage, data.toString('hex'))
  await operation((done) => serial.write(data, done))
  await operation((done) => serial.drain(done))
}
async function run() {
  console.log('Probe', path, baudRate, plan, 'capture:', destination)
  const ports = await SerialPort.list()
  const selected = ports.find((port) => port.path.toUpperCase() === path.toUpperCase())
  if (
    selected?.vendorId?.toUpperCase() !== '2E8A' ||
    selected?.productId?.toUpperCase() !== 'F00F'
  ) {
    log.end()
    throw new Error(
      'Probe restricted to the identified RP2350 DAQ (2E8A:F00F); no port was opened.',
    )
  }
  record({ event: 'session', path, baudRate, plan, seconds, ports })
  try {
    await operation((done) => serial.open(done))
    console.log('Port open')
    stage = 'passive-after-open'
    await delay(1000)
    stage = 'DTR-RTS-asserted'
    await operation((done) => serial.set({ dtr: true, rts: true }, done))
    await delay(1500)
    if (plan !== 'listen') {
      stage = 'stop-before-probe'
      await send('00')
      await delay(300)
      const commands =
        plan === 'all'
          ? ['01000186a0']
          : plan === 'short'
            ? ['01']
            : ['04000186a0', '03000186a0', '05000186a0', '06000186a0', '02000186a0']
      for (const hex of commands) {
        stage = `command-${hex}`
        shown = 0
        const before = total
        await send(hex)
        await delay(seconds * 1000)
        console.log('Stage received', total - before, 'bytes')
        stage = 'stop-between-probes'
        await send('00')
        await delay(300)
      }
    }
  } finally {
    stage = 'cleanup'
    if (serial.isOpen) {
      if (plan !== 'listen') await send('00').catch((error) => console.error(error.message))
      await operation((done) => serial.close(done))
    }
    record({ event: 'summary', receivedBytes: total })
    log.end()
    await finished(log)
    console.log('Total received:', total, 'bytes; capture:', destination)
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
