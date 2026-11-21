import { expect, test } from '@playwright/test'
import { fixtureBrowser, connectDaq } from './fixtures'

test.beforeEach(async ({ page }) => {
  await fixtureBrowser(page)
  await page.goto('./')
  await expect(
    page.getByRole('heading', { name: 'Wind tunnel control', exact: true }),
  ).toBeVisible()
})

test('all channels, original UI workflows, durable recording, CSV and acknowledged Disconnect', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  expect(
    await page.evaluate(() =>
      window.tunnel.snapshot().then((s) => Object.keys(s.measurements).length),
    ),
  ).toBe(0)
  await expect(page.getByRole('button', { name: 'Record session', exact: true })).toBeDisabled()
  await connectDaq(page)
  await expect
    .poll(() =>
      page.evaluate(() => window.tunnel.snapshot().then((s) => Object.keys(s.measurements).length)),
    )
    .toBe(37)
  await page.getByRole('button', { name: 'Main', exact: true }).click()
  await page.getByLabel('Fan percentage value').fill('5')
  await page.getByRole('button', { name: 'Apply 5.0%', exact: true }).click()
  await expect(page.getByTestId('fan-confirmed')).toContainText('5.0% · 0.150 V')
  await expect(page.getByTestId('pitot-airspeed')).not.toContainText('—')
  await page.getByLabel('Wind speed unit').selectOption('m/s')
  await expect(page.getByTestId('pitot-airspeed')).toContainText('m/s')
  await expect(page.getByLabel('Fan percentage value')).toHaveValue('5')
  await page.screenshot({ path: 'test-results/web-live-main.png', fullPage: true })
  await page.getByRole('button', { name: 'Pressure graphs', exact: true }).click()
  await page.getByRole('button', { name: 'All sensors', exact: true }).click()
  await expect(page.locator('.sensor-picker input:checked')).toHaveCount(29)
  await expect(page.locator('.sensor-plot')).toHaveCount(2)
  await page.getByRole('button', { name: 'Pressure array', exact: true }).click()
  await expect(page.locator('.sensor-picker input:checked')).toHaveCount(24)
  await page.getByRole('button', { name: 'Data Viewer', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(37)
  await expect(page.locator('tbody tr').filter({ hasText: 'temp1' })).toContainText('NaN')
  await page.getByRole('button', { name: 'Record session', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.recording.rows)))
    .toBeGreaterThan(37)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.getByText('Recording hardware measurements', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Recordings finalized')
  expect(
    await page.evaluate(() =>
      window.fixture.writes
        .filter((w) => w.kind === 'daq')
        .slice(-2)
        .map((w) => w.command),
    ),
  ).toEqual(['210000', '00'])
  expect(await page.evaluate(() => window.fixture.closes.daq)).toBe(1)
  expect(await page.evaluate(() => window.tunnel.snapshot().then((s) => s.recording.active))).toBe(
    false,
  )
  await page.getByRole('button', { name: 'Save run log (JSONL)', exact: true }).click()
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
  const files = await page.evaluate(() => window.fixture.files)
  const jsonl = Object.entries(files).find(([name]) => name.endsWith('.jsonl'))![1]
  const csv = Object.entries(files).find(([name]) => name.endsWith('.csv'))![1]
  expect(JSON.parse(jsonl.split('\n')[0]!)).toMatchObject({ schemaVersion: 1, mode: 'hardware' })
  expect(csv).toContain('"hardware"')
  expect(csv.split('\n')[0]).toContain('calibrationVersion')
  const rows = await page.evaluate(() => window.tunnel.snapshot().then((s) => s.recording.rows))
  await page.reload()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('.saved-run')).toHaveCount(1)
  expect(await page.evaluate(() => window.tunnel.snapshot().then((s) => s.recording.rows))).toBe(
    rows,
  )
  await page.screenshot({ path: 'test-results/web-sessions.png', fullPage: true })
  expect(errors).toEqual([])
})

test('Pitot permission, homing, full travel, persistent homing, and disconnect during motion', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Pitot', exact: true }).click()
  await page.getByRole('button', { name: 'Connect and home Pitot', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move Pitot', exact: true })).toBeEnabled({
    timeout: 10000,
  })
  await page.getByLabel('Pitot X target').fill('360')
  await page.getByLabel('Pitot Y target').fill('360')
  await page.getByRole('button', { name: 'Move Pitot', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.pitot.position?.x)))
    .toBe(360)
  expect(
    await page.evaluate(() =>
      window.fixture.writes
        .filter((w) => w.kind === 'pitot' && w.command.startsWith('G1 '))
        .map((w) => w.command),
    ),
  ).toEqual(['G1 X5.00 Y5.00 F300', 'G1 X355.00 Y355.00 F4000', 'G1 X360.00 Y360.00 F300'])
  await page.getByRole('button', { name: 'Main', exact: true }).click()
  await page.getByRole('button', { name: 'Pitot', exact: true }).click()
  expect(
    await page.evaluate(() => window.fixture.writes.filter((w) => w.command === 'G28 X').length),
  ).toBe(1)
  await page.evaluate(() => {
    window.fixture.hold = 'M400'
  })
  await page.getByLabel('Pitot X target').fill('0')
  await page.getByLabel('Pitot Y target').fill('0')
  await page.getByRole('button', { name: 'Move Pitot', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.pitot.status)))
    .toBe('moving')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.fixture.closes.pitot)).toBe(1)
  expect(
    await page.evaluate(
      () => window.fixture.writes.filter((w) => w.kind === 'pitot').at(-1)?.command,
    ),
  ).toBe('M112')
  await expect(
    page.getByRole('button', { name: 'Connect and home Pitot', exact: true }),
  ).toBeEnabled()
})

test('missing zero acknowledgment finalizes recording and keeps USB available for retry', async ({
  page,
}) => {
  await connectDaq(page)
  await page.getByRole('button', { name: 'Record session', exact: true }).click()
  await page.evaluate(() => {
    window.fixture.dropDac = true
  })
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('kept connected', { timeout: 10000 })
  const snapshot = await page.evaluate(() => window.tunnel.snapshot())
  expect(snapshot.daq.state).toBe('connected')
  expect(snapshot.recording.active).toBe(false)
  expect(await page.evaluate(() => window.fixture.closes.daq)).toBe(0)
  await page.evaluate(() => {
    window.fixture.dropDac = false
  })
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Recordings finalized')
})

test('USB loss invalidates readings, stops recording, and preserves committed data', async ({
  page,
}) => {
  await connectDaq(page)
  await page.getByRole('button', { name: 'Record session', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.recording.rows)))
    .toBeGreaterThan(37)
  await page.evaluate(() => window.fixture.loseDaq())
  await expect
    .poll(() => page.evaluate(() => window.tunnel.snapshot().then((s) => s.daq.state)))
    .toBe('error')
  const snapshot = await page.evaluate(() => window.tunnel.snapshot())
  expect(snapshot.recording.active).toBe(false)
  expect(snapshot.measurements.press1?.quality).toBe('stale')
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Save run log (JSONL)', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Object.keys(window.fixture.files).length)).toBe(1)
})

test('imports existing Electron calibration JSON, applies it, exports it, and preserves it on reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Calibration', exact: true }).click()
  await page.evaluate(() => {
    window.fixture.calibration = JSON.stringify({
      strain2: {
        channelId: 'strain2',
        scale: 0.01,
        offset: 4,
        version: 7,
        unit: 'N',
      },
    })
  })
  await page.getByRole('button', { name: 'Import calibration JSON', exact: true }).click()
  await expect(page.getByText('strain2 · version 7', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Export calibration JSON', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.fixture.files['hardware-calibrations.json']))
    .toContain('0.01')
  await page.reload()
  expect((await page.evaluate(() => window.tunnel.snapshot())).calibrations.strain2).toMatchObject({
    scale: 0.01,
    version: 7,
    unit: 'N',
  })
})

test('second tab cannot take USB ownership and offline shell opens without a server', async ({
  page,
  context,
}) => {
  await connectDaq(page)
  const second = await context.newPage()
  await fixtureBrowser(second)
  await second.goto('./')
  await second.getByRole('button', { name: 'Hardware', exact: true }).click()
  await second.getByRole('button', { name: 'Connect and read DAQ', exact: true }).click()
  await expect(second.getByRole('alert')).toContainText('Another wind tunnel tab')
  expect(await second.evaluate(() => window.fixture.opens.daq)).toBe(0)
  await second.close()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Wind tunnel control', exact: true }),
  ).toBeVisible()
  await context.setOffline(false)
  await page.screenshot({ path: 'test-results/web-main.png', fullPage: true })
})

test('fan preview, acquisition stop/start, force calibration, emergency stop and reset preserve semantics', async ({
  page,
}) => {
  await connectDaq(page)
  await page.getByRole('button', { name: 'Main', exact: true }).click()
  const before = await page.evaluate(() => window.fixture.writes.length)
  await page.getByLabel('Fan percentage value').fill('5')
  await page.getByLabel('Pitot X target').fill('20')
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(before)
  await page.getByRole('button', { name: 'Apply 5.0%', exact: true }).click()
  await expect(page.getByTestId('fan-confirmed')).toContainText('0.150 V')
  await page.getByRole('button', { name: 'Stop acquisition', exact: true }).click()
  await expect(page.getByTestId('fan-confirmed')).toContainText('0.150 V')
  await page.getByLabel('Sample period').selectOption('200')
  await page.getByRole('button', { name: 'Start acquisition', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.fixture.writes.at(-1)?.command))
    .toBe('0100030d40')
  await page.getByRole('button', { name: 'Calibration', exact: true }).click()
  await page.getByLabel('Calibration points').fill('0,0\n100,10')
  await page.getByRole('button', { name: 'Fit and save calibration', exact: true }).click()
  await expect(page.getByText('strain2 · version 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Tare current reading', exact: true }).click()
  await expect(page.getByText('strain2 · version 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Force Balance', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Normal force', exact: true })).toBeVisible()
  await expect(page.locator('.airspeed-value').first()).not.toContainText('—')
  await page.getByRole('button', { name: 'Emergency Stop', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('NONZERO OUTPUT BLOCKED')
  const tx = await page.evaluate(() => window.fixture.writes.length)
  await page.getByRole('button', { name: 'Reset command block', exact: true }).click()
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(tx)
  await page.getByRole('button', { name: 'Main', exact: true }).click()
  await expect(page.getByLabel('Fan percentage value')).toHaveValue('0')
  await expect(page.getByTestId('fan-confirmed')).toContainText('0.000 V')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
})

test('chooser cancellation and a connection racing Disconnect never open or command a device', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Hardware', exact: true }).click()
  await page.evaluate(() => {
    window.fixture.cancelChooser = true
  })
  await page.getByRole('button', { name: 'Choose DAQ device', exact: true }).click()
  expect(await page.evaluate(() => window.fixture.opens.daq)).toBe(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(() => {
    window.fixture.cancelChooser = false
  })
  await page.getByRole('button', { name: 'Choose DAQ device', exact: true }).click()
  const results = await page.evaluate(async () => {
    const ports = await window.tunnel.listPorts()
    if (!ports.ok) throw Error(ports.error)
    const connecting = window.tunnel.act({
      type: 'daq-connect',
      path: ports.value[0]!.path,
      baudRate: 115200,
    })
    const disconnecting = window.tunnel.disconnect()
    return Promise.all([connecting, disconnecting])
  })
  expect(results[0]?.ok).toBe(false)
  expect(results[1]?.ok).toBe(true)
  expect(await page.evaluate(() => window.fixture.opens.daq)).toBe(0)
  expect(await page.evaluate(() => window.fixture.writes)).toEqual([])
})

test('warns before reload and recovers committed chunks after an interrupted recording', async ({
  page,
}) => {
  await connectDaq(page)
  await page.getByRole('button', { name: 'Record session', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const runs = await window.tunnel.listRecordings()
        return runs.ok ? (runs.value[0]?.rows ?? 0) : 0
      }),
    )
    .toBeGreaterThan(37)
  let warning = false
  page.once('dialog', async (dialog) => {
    warning = dialog.type() === 'beforeunload'
    await dialog.accept()
  })
  await page.reload()
  expect(warning).toBe(true)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('.saved-run')).toContainText('unfinalized')
  await page.getByRole('button', { name: 'Save run log (JSONL)', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => Object.values(window.fixture.files).join('')))
    .toContain('"type":"measurement"')
})
