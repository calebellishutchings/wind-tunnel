import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

test('binary board-only desktop: disconnected state, captured acquisition, recording and reconnect', async () => {
  const directory = resolve('.test-data', `binary-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.WT_DATA_DIR = directory
  env.WT_DISABLE_PITOT_DISCOVERY = '1'
  delete env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.WT_TEST_EXECUTABLE
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ['.'],
    cwd: process.cwd(),
    env,
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ ipcMain, dialog }) => {
      dialog.showErrorBox = () => {}
      ipcMain.removeHandler('tunnel:ports')
      ipcMain.handle('tunnel:ports', () => ({ ok: true, value: [] }))
    })
    await page.getByRole('button', { name: 'Hardware', exact: true }).click()
    await page.getByRole('button', { name: 'Scan ports' }).click()
    await expect(page.getByRole('button', { name: 'Connect and read DAQ' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeDisabled()
    await expect(page.getByText(/simulation/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Traverse', exact: true })).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(
          async () => Object.keys((await window.tunnel.snapshot()).measurements).length,
        ),
      )
      .toBe(0)
    await page.getByRole('button', { name: 'Main', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Start acquisition', exact: true }),
    ).toBeDisabled()
    expect(await page.evaluate(async () => window.tunnel.startRecording())).toMatchObject({
      ok: false,
    })
    const rows = (
      await readFile('docs/captures/2026-11-05T15-57-56.627Z-COM10-115200-all.jsonl', 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { direction?: string; hex?: string })
    // Preserve original complete wire packets. Inject fixture DAC replies only at packet
    // boundaries, as real firmware does, never in the middle of a split float32.
    const captured = Buffer.concat(
      rows.filter((row) => row.direction === 'rx').map((row) => Buffer.from(row.hex!, 'hex')),
    )
    const hex: string[] = []
    const sizes: Record<number, number> = { 2: 21, 3: 21, 4: 9, 5: 21, 6: 101 }
    let offset = 0
    while (offset < captured.length) {
      const id = captured[offset]!
      let length = sizes[id] ?? 0
      if ([0xd0, 0xe0, 0xe1].includes(id)) {
        const end = captured.indexOf(id, offset + 1)
        if (end < 0) break // A capture may close mid-diagnostic.
        length = end - offset + 1
      }
      if (!length) throw Error('Unknown capture frame')
      if (offset + length > captured.length) break
      hex.push(captured.subarray(offset, offset + length).toString('hex'))
      offset += length
    }
    // Inject only a transport fixture; production service, decoder, IPC, recorder and UI stay real.
    await app.evaluate(({ app, ipcMain }, hex) => {
      const load = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const { service } = load('./out/main/index.js')
      service.options.transportFactory = () => {
        let callbacks: { data: (data: Buffer) => void }
        let timer: ReturnType<typeof setInterval> | undefined
        return {
          async open(_options: unknown, events: typeof callbacks) {
            callbacks = events
          },
          async write(data: Buffer) {
            if (data[0] === 0x21) {
              callbacks.data(
                Buffer.from(`\xd0DAC output set to ${data.readUInt16BE(1)} mV\xd0`, 'latin1'),
              )
              return
            }
            if (timer) clearInterval(timer)
            if (data[0] === 1) {
              let index = 0
              timer = setInterval(() => {
                if (index < hex.length) callbacks.data(Buffer.from(hex[index++]!, 'hex'))
                else clearInterval(timer)
              }, 40)
            }
          },
          async close() {
            if (timer) clearInterval(timer)
          },
        }
      }
      ipcMain.removeHandler('tunnel:ports')
      ipcMain.handle('tunnel:ports', () => ({
        ok: true,
        value: [
          { path: 'COM10', vendorId: '2E8A', productId: 'F00F' },
          { path: 'COM11', vendorId: '1A86', productId: '7523' },
        ],
      }))
    }, hex)
    await page.getByRole('button', { name: 'Hardware', exact: true }).click()
    await page.getByRole('button', { name: 'Scan ports' }).click()
    await expect(page.getByLabel('DAQ serial port')).toHaveValue('COM10')
    await expect(page.locator('#daq-ports option[value="COM11"]')).toHaveCount(0)
    await expect(page.getByLabel('DAQ response format')).toHaveCount(0)
    await page.getByRole('button', { name: 'Connect and read DAQ' }).click()
    await expect
      .poll(async () =>
        page.evaluate(
          async () => Object.keys((await window.tunnel.snapshot()).measurements).length,
        ),
      )
      .toBe(37)
    await page.getByRole('button', { name: 'Main', exact: true }).click()
    await expect(page.getByLabel('Fan percentage', { exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Apply 0.0%', exact: true })).toBeEnabled()
    expect(await page.evaluate(async () => (await window.tunnel.snapshot()).daq.state)).toBe(
      'connected',
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /Rev Run|Enable fan controls|lock controls/ }),
    ).toHaveCount(0)
    const sentBeforePreview = await page.evaluate(
      async () => (await window.tunnel.snapshot()).daq.sentBytes,
    )
    await page.getByLabel('Fan percentage', { exact: true }).fill('5')
    await page.getByLabel('Pitot X target').fill('42')
    await page.getByLabel('Pitot Y target').fill('73')
    expect(await page.evaluate(async () => (await window.tunnel.snapshot()).daq.sentBytes)).toBe(
      sentBeforePreview,
    )
    await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Apply 5.0%', exact: true }).click()
    await expect(page.getByTestId('fan-confirmed')).toContainText('5.0% · 0.150 V')
    expect(
      await page.evaluate(
        async () =>
          (await window.tunnel.snapshot()).daq.wireLog.filter((r) => r.direction === 'tx').at(-1)
            ?.hex,
      ),
    ).toBe('21 00 96')
    await expect(page.getByTestId('atmospheric-pressure')).toContainText('kPa')
    await expect(page.getByTestId('pitot-airspeed')).not.toContainText('—')
    await page.getByLabel('ring pressure source').selectOption('press1')
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const p = document.querySelector('[data-testid="pitot-airspeed"]')?.textContent
          const r = document.querySelector('[data-testid="ring-airspeed"]')?.textContent
          return p === r
        }),
      )
      .toBe(true)
    await page.getByLabel('ring pressure source').selectOption('press2')
    await page.getByLabel('Wind speed unit').selectOption('m/s')
    await expect(page.getByLabel('Fan percentage value')).toHaveValue('5')
    await expect(page.getByTestId('pitot-airspeed')).toContainText('m/s')
    await page.getByLabel('Wind speed unit').selectOption('mph')
    await page.getByRole('button', { name: 'Stop fan (0%)', exact: true }).click()
    await expect(page.getByTestId('fan-confirmed')).toContainText('0.0% · 0.000 V')
    await expect(page.getByLabel('Fan percentage', { exact: true })).toBeEnabled()
    expect(await page.evaluate(async () => (await window.tunnel.snapshot()).daq.state)).toBe(
      'connected',
    )
    await page.getByRole('button', { name: 'Pitot', exact: true }).click()
    await expect(page.getByLabel('Pitot X target')).toHaveValue('42')
    await expect(page.getByRole('button', { name: 'Home Pitot', exact: true })).toBeDisabled()
    await page.screenshot({ path: 'docs/pitot-preview.png', fullPage: true })
    await page.getByRole('button', { name: 'Pressure graphs', exact: true }).click()
    await page.getByRole('button', { name: 'All sensors', exact: true }).click()
    await expect(page.locator('.sensor-picker input:checked')).toHaveCount(29)
    await expect(page.locator('.sensor-plot')).toHaveCount(2)
    await page.screenshot({ path: 'docs/pressure-graphs-preview.png', fullPage: true })
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await page.getByLabel('Plot press1', { exact: true }).check()
    await page.getByLabel('Plot press2', { exact: true }).check()
    await page.getByLabel('Graph layout').selectOption('separate')
    await expect(page.locator('.sensor-plot')).toHaveCount(2)
    await page.getByRole('button', { name: 'Pressure array', exact: true }).click()
    await expect(page.locator('.sensor-picker input:checked')).toHaveCount(24)
    await page.getByRole('button', { name: 'Data Viewer', exact: true }).click()
    await expect(page.locator('tbody tr')).toHaveCount(37)
    await expect(page.locator('tbody tr').filter({ hasText: 'temp1' })).toContainText('NaN')
    await app.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: folder + '/binary.jsonl' })
    }, directory)
    await page.getByRole('button', { name: 'Record session', exact: true }).click()
    await expect
      .poll(async () => page.evaluate(async () => (await window.tunnel.snapshot()).recording.rows))
      .toBeGreaterThan(37)
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: folder + '/binary.csv' })
    }, directory)
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('CSV saved')
    expect(await readFile(join(directory, 'binary.csv'), 'utf8')).toContain('"hardware"')
    await page.getByRole('button', { name: 'Hardware', exact: true }).click()
    await page.getByRole('button', { name: 'Disconnect DAQ', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeDisabled()
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.tunnel.snapshot()).measurements.strain1?.quality),
      )
      .toBe('stale')
    await page.getByRole('button', { name: 'Connect and read DAQ' }).click()
    await expect
      .poll(async () => page.evaluate(async () => (await window.tunnel.snapshot()).frameCount))
      .toBeGreaterThan(5)
    await page.getByRole('button', { name: 'Main', exact: true }).click()
    await expect(page.getByLabel('Fan percentage', { exact: true })).toBeEnabled()
    await expect(page.getByTestId('pitot-airspeed')).not.toContainText('—')
    await expect(page.getByTestId('ring-airspeed')).not.toContainText('—')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: 'docs/binary-board-preview.png', fullPage: true })
    const sentBeforeStop = await page.evaluate(
      async () => (await window.tunnel.snapshot()).daq.sentBytes,
    )
    await page.getByRole('button', { name: 'Emergency Stop', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('NONZERO OUTPUT BLOCKED')
    await expect(page.getByTestId('fan-confirmed')).toContainText('0.0% · 0.000 V')
    await expect(page.getByRole('button', { name: 'Stop acquisition', exact: true })).toBeDisabled()
    expect(
      await page.evaluate(async () =>
        window.tunnel.act({ type: 'acquisition', running: false, periodMs: 100 }),
      ),
    ).toMatchObject({ ok: false })
    expect(await page.evaluate(async () => (await window.tunnel.snapshot()).daq.sentBytes)).toBe(
      sentBeforeStop + 3,
    )
    await page.getByRole('button', { name: 'Reset command block', exact: true }).click()
    expect(await page.evaluate(async () => (await window.tunnel.snapshot()).daq.sentBytes)).toBe(
      sentBeforeStop + 3,
    )
    expect(errors).toEqual([])
  } catch (error) {
    const page = await app.firstWindow()
    console.error(
      'Desktop state on failure:',
      JSON.stringify(await page.evaluate(async () => window.tunnel.snapshot())),
    )
    throw error
  } finally {
    await app.close()
  }
})

test('Pitot connection homes automatically, Home repeats homing, and movement/stop use validated IPC', async () => {
  const directory = resolve('.test-data', `pitot-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.WT_DATA_DIR = directory
  env.WT_DISABLE_PITOT_DISCOVERY = '1'
  const executablePath = process.env.WT_TEST_EXECUTABLE
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : ['.'],
    cwd: process.cwd(),
    env,
  })
  try {
    const page = await app.firstWindow()
    const rows = (
      await readFile('docs/captures/2026-11-19T16-52-57.766Z-pitot-inspection.jsonl', 'utf8')
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { direction?: string; text?: string })
    const responses: Record<string, string> = {}
    let current = ''
    for (const row of rows) {
      if (row.direction === 'tx') current = row.text!.trim()
      if (row.direction === 'rx') responses[current] = (responses[current] ?? '') + row.text
    }
    await app.evaluate(({ app }, responses) => {
      const load = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json')
      const { service } = load('./out/main/index.js')
      service.pitot.options.startupDelayMs = 0
      service.pitot.options.listPorts = async () => [
        { path: 'COM14', vendorId: '1A86', productId: '7523' },
      ]
      service.pitot.options.transportFactory = () => {
        let events: { data: (chunk: Buffer) => void }
        let x = 0,
          y = 0
        return {
          async open(_options: unknown, callbacks: typeof events) {
            events = callbacks
          },
          async write(data: Buffer) {
            const command = data.toString().trim()
            if (command === 'M112') return
            if (command === 'G28 X') x = 0
            if (command === 'G28 Y') y = 0
            if (command.startsWith('G1 ')) {
              x = Number(/X([\d.]+)/.exec(command)![1])
              y = Number(/Y([\d.]+)/.exec(command)![1])
            }
            const response =
              command === 'M114'
                ? `X:${x.toFixed(2)} Y:${y.toFixed(2)} Z:0.00 E:0.00 Count X:0 Y:0 Z:0\nok\n`
                : (responses[command] ?? 'ok\n')
            if (command.startsWith('G28')) await new Promise((resolve) => setTimeout(resolve, 60))
            events.data(Buffer.from(response))
          },
          async close() {},
        }
      }
    }, responses)
    await page.getByRole('button', { name: 'Pitot', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Connect and home Pitot', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeEnabled()
    let state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.homed).toBe(true)
    expect(
      state.transcript
        .filter((r) => r.direction === 'tx')
        .map((r) => r.text)
        .slice(-4),
    ).toEqual(['G28 X', 'G28 Y', 'M400', 'M114'])
    const before = state.transcript.filter((r) => r.direction === 'tx').length
    await page.getByLabel('Pitot X target').fill('360')
    await page.getByLabel('Pitot Y target').fill('360')
    state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.transcript.filter((r) => r.direction === 'tx')).toHaveLength(before)
    await page.getByRole('button', { name: 'Move Pitot', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.tunnel.snapshot()).pitot.position?.x),
      )
      .toBe(360)
    state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.position).toEqual({ x: 360, y: 360 })
    expect(
      state.transcript
        .filter((r) => r.direction === 'tx' && r.text.startsWith('G1 '))
        .map((r) => r.text),
    ).toEqual(['G1 X5.00 Y5.00 F300', 'G1 X355.00 Y355.00 F4000', 'G1 X360.00 Y360.00 F300'])
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Main', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'Pitot', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeEnabled()
    }
    state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.homed).toBe(true)
    expect(state.transcript.filter((r) => r.direction === 'tx' && r.text === 'G28 X')).toHaveLength(
      1,
    )
    expect(
      await page.evaluate(async () => window.tunnel.pitotAct({ type: 'move', x: 360.01, y: 0 })),
    ).toMatchObject({ ok: false })
    await page.getByRole('button', { name: 'Home Pitot', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.tunnel.snapshot()).pitot.position?.x),
      )
      .toBe(0)
    state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.transcript.filter((r) => r.direction === 'tx' && r.text === 'G28 X')).toHaveLength(
      2,
    )
    await page.screenshot({ path: 'docs/pitot-controller-preview.png', fullPage: true })
    await page.getByRole('button', { name: 'Emergency Stop', exact: true }).click()
    await expect
      .poll(async () => page.evaluate(async () => (await window.tunnel.snapshot()).pitot.status))
      .toBe('fault')
    state = await page.evaluate(async () => (await window.tunnel.snapshot()).pitot)
    expect(state.transcript.filter((r) => r.direction === 'tx').at(-1)?.text).toBe('M112')
    expect(state.homed).toBe(false)
    await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeDisabled()
  } finally {
    await app.close()
  }
})
