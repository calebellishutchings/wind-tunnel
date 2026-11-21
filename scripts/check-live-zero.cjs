#!/usr/bin/env node
// Opt-in live integration check. Every DAC command is zero; no motion endpoint is opened.
const { _electron: electron } = require('@playwright/test')
const { mkdir, writeFile } = require('node:fs/promises')
const { resolve } = require('node:path')
async function run() {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const folder = resolve('docs/captures')
  const data = resolve('.test-data', `live-zero-${stamp}`)
  await mkdir(data, { recursive: true })
  await mkdir(folder, { recursive: true })
  const env = { ...process.env, WT_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
  const logPath = `${folder}/${stamp}-app-zero-check.jsonl`
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.tunnel)
    const result = await page.evaluate(async () => {
      const ports = await window.tunnel.listPorts()
      if (!ports.ok) throw Error(ports.error)
      const matches = ports.value.filter(
        (p) => p.vendorId?.toUpperCase() === '2E8A' && p.productId?.toUpperCase() === 'F00F',
      )
      if (matches.length !== 1) throw Error('Exactly one RP2350 DAQ required')
      return window.tunnel.act({ type: 'daq-connect', path: matches[0].path, baudRate: 115200 })
    })
    if (!result.ok) throw Error(result.error)
    const initial = await page.evaluate(() => window.tunnel.snapshot())
    if (initial.fan.confirmedMillivolts !== 0) throw Error('Initial DAC zero was not acknowledged')
    await app.evaluate(({ app }, path) => {
      const load = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      return load('./out/main/index.js').service.recorder.start(
        path,
        { purpose: 'Production app, zero DAC only; no Pitot I/O' },
        'hardware',
      )
    }, logPath)
    const snapshots = []
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      snapshots.push(await page.evaluate(() => window.tunnel.snapshot()))
    }
    const last = snapshots.at(-1)
    const tx = last.daq.wireLog.filter((r) => r.direction === 'tx')
    if (tx.some((r) => r.hex.startsWith('21 ') && r.hex !== '21 00 00'))
      throw Error('Unexpected nonzero DAC command')
    const summary = {
      at: new Date().toISOString(),
      logPath,
      initial,
      samples: snapshots.length,
      rawAtmosphericNaNSnapshots: snapshots.filter(
        (s) => s.measurements.abs_pressure?.rawSpecial === 'NaN',
      ).length,
      effectiveAtmosphereAvailableSnapshots: snapshots.filter((s) => s.airspeedAtmosphere !== null)
        .length,
      final: last,
    }
    await writeFile(
      `${folder}/${stamp}-app-zero-check-summary.json`,
      JSON.stringify(summary, null, 2) + '\n',
    )
    console.log(
      JSON.stringify(
        {
          samples: summary.samples,
          rawNaNSnapshots: summary.rawAtmosphericNaNSnapshots,
          effectiveAvailable: summary.effectiveAtmosphereAvailableSnapshots,
          frames: last.frameCount,
          fan: last.fan,
          logPath,
        },
        null,
        2,
      ),
    )
    const stopped = await page.evaluate(() => window.tunnel.act({ type: 'daq-disconnect' }))
    if (!stopped.ok) throw Error(stopped.error)
  } finally {
    await app.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
