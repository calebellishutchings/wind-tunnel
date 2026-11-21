import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TunnelService } from './tunnel-service'
import { SettingsStore } from '../infrastructure/settings'
import { listSerialPorts } from '../infrastructure/serial'
import { exportRecordingCsv } from '../infrastructure/recording'
import { CHANNELS } from '../shared/model'

if (process.env.WT_DATA_DIR) app.setPath('userData', resolve(process.env.WT_DATA_DIR))
// Main-process export permits transport injection in desktop integration tests;
// it is never exposed to renderer JavaScript or through preload.
export const service = new TunnelService(
  new SettingsStore(join(app.getPath('userData'), 'hardware-calibrations.json')),
)
let window: BrowserWindow | null = null
let publishTimer: ReturnType<typeof setInterval> | undefined
let quitting = false
let fileOperation = false
const rendererFile = join(__dirname, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

function publish(): void {
  if (window && !window.isDestroyed())
    window.webContents.send('tunnel:snapshot', service.snapshot())
}
function handle(channel: string, operation: (input: unknown) => unknown): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Untrusted IPC sender')
    const expectedUrl = developmentUrl ?? pathToFileURL(rendererFile).href
    if (new URL(event.senderFrame.url).href !== new URL(expectedUrl).href)
      throw new Error('Untrusted IPC origin')
    try {
      return { ok: true, value: await operation(input) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      service.diagnostic('error', message)
      return { ok: false, error: message }
    } finally {
      publish()
    }
  })
}
async function withFileLock<T>(operation: () => Promise<T>): Promise<T> {
  if (fileOperation) throw new Error('Finish the current file operation first')
  fileOperation = true
  try {
    return await operation()
  } finally {
    fileOperation = false
  }
}

app
  .whenReady()
  .then(async () => {
    await service.initialize()
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1080,
      minHeight: 740,
      backgroundColor: '#f4f6f8',
      title: 'ENS Wind Tunnel',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'fileMenu' },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
            ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
          ],
        },
      ]),
    )
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.once('ready-to-show', () => window?.show())
    handle('tunnel:get', () => service.snapshot())
    handle('tunnel:act', (input) => service.act(input))
    handle('tunnel:pitot-act', (input) => service.actPitot(input))
    handle('tunnel:ports', () => listSerialPorts())
    handle('tunnel:record-start', () =>
      withFileLock(async () => {
        if (service.recorder.active) throw new Error('Recording is already active')
        const session = service.snapshot()
        if (session.daq.state !== 'connected') throw new Error('Connect a DAQ before recording')
        const result = await dialog.showSaveDialog(window!, {
          title: 'Create DAQ run log',
          defaultPath: `ENS-${service.snapshot().mode}-${new Date().toISOString().replaceAll(':', '-')}.jsonl`,
          filters: [{ name: 'Wind tunnel run log', extensions: ['jsonl'] }],
        })
        if (result.canceled || !result.filePath) return null
        if (
          service.snapshot().daq.state !== 'connected' ||
          service.snapshot().sourceVersion !== session.sourceVersion
        )
          throw new Error('DAQ connection changed while choosing a recording file')
        await service.recorder.start(
          result.filePath,
          {
            channels: CHANNELS,
            settings: {
              samplePeriodMs: session.samplePeriodMs,
              roomTemperatureC: session.roomTemperatureC,
              calibrations: session.calibrations,
              fan: session.fan,
              daq: { path: session.daq.path, baudRate: session.daq.baudRate, format: 'binary' },
            },
            note: 'Live binary DAQ capture. Sensor values may be invalid or uncalibrated.',
          },
          service.snapshot().mode,
        )
        return result.filePath
      }),
    )
    handle('tunnel:record-stop', () => withFileLock(() => service.recorder.stop()))
    handle('tunnel:export', () =>
      withFileLock(async () => {
        if (service.recorder.active)
          throw new Error('Stop recording before exporting a completed run')
        await service.recorder.stop()
        if (service.recorder.error)
          throw new Error('Recording failed; inspect the run log before exporting')
        const source = service.recorder.path
        if (!source) throw new Error('Record a run before exporting')
        const result = await dialog.showSaveDialog(window!, {
          title: 'Export DAQ CSV',
          defaultPath: source.replace(/\.jsonl$/i, '') + '.csv',
          filters: [{ name: 'CSV data', extensions: ['csv'] }],
        })
        if (result.canceled || !result.filePath) return null
        await exportRecordingCsv(source, result.filePath)
        return result.filePath
      }),
    )
    // Faster than the measured ~120 ms bank interval; recordings still ingest every packet.
    publishTimer = setInterval(publish, 100)
    if (developmentUrl) await window.loadURL(developmentUrl)
    else await window.loadFile(rendererFile)
    // Startup motion is intentional: this verified controller must home before any target.
    // Offline automation explicitly disables discovery so test runs never open hardware.
    if (process.env.WT_DISABLE_PITOT_DISCOVERY !== '1')
      void service
        .actPitot({ type: 'connect' })
        .catch((error) => service.diagnostic('warning', String(error)))
  })
  .catch((error) => {
    dialog.showErrorBox('Wind tunnel startup failed', String(error))
    app.quit()
  })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  if (publishTimer) clearInterval(publishTimer)
  void service
    .dispose()
    .catch((error) => dialog.showErrorBox('Recording could not be finalized', String(error)))
    .finally(() => app.quit())
})
