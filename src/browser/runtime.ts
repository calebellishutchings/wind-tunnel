import type { Result, Snapshot, TunnelApi } from '../shared/model'
import type { SaveFileHandle } from '../shared/browser'
import { CHANNELS } from '../shared/model'
import { isPitotPort } from '../shared/pitot'
import { TunnelService } from '../main/tunnel-service'
import { SettingsStore } from '../infrastructure/settings'
import { Recorder, recordingCsv } from '../infrastructure/recording'
import { BrowserRecordingStorage } from '../infrastructure/browser-storage'
import { serialRegistry, SerialDaqTransport } from '../infrastructure/serial'
import { SerialPitotTransport } from '../infrastructure/pitot-serial'

const canceled = (error: unknown) =>
  error instanceof DOMException && ['AbortError', 'NotFoundError'].includes(error.name)

/** A single browser tab owns control; viewing another tab never duplicates hardware owners. */
export class HardwareLock {
  private release: (() => void) | null = null
  private acquiring: Promise<void> | null = null
  constructor(private readonly name: string) {}
  acquire(): Promise<void> {
    if (this.acquiring) return this.acquiring
    if (this.release) return Promise.resolve()
    this.acquiring = new Promise<void>((resolve, reject) => {
      if (!navigator.locks) {
        reject(Error('This browser does not support exclusive USB control'))
        return
      }
      void navigator.locks
        .request(this.name, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            reject(Error('Another wind tunnel tab owns USB control. Disconnect it first.'))
            return
          }
          const held = new Promise<void>((release) => {
            this.release = release
          })
          resolve()
          await held
        })
        .catch(reject)
    }).finally(() => {
      this.acquiring = null
    })
    return this.acquiring
  }
  unlock(): void {
    this.release?.()
    this.release = null
  }
}

export async function createBrowserRuntime(): Promise<TunnelApi> {
  const scope = import.meta.env.BASE_URL
  const recorder = new Recorder(new BrowserRecordingStorage(`ens-wind-tunnel:${scope}:recordings`))
  const settings = new SettingsStore(`ens-wind-tunnel:${scope}:hardware-calibrations`)
  const service = new TunnelService(settings, {
    recorder,
    transportFactory: () => new SerialDaqTransport(serialRegistry),
    pitotOptions: {
      listPorts: async () => serialRegistry.pitotPorts(),
      transportFactory: () => new SerialPitotTransport(serialRegistry),
    },
  })
  const hardwareLock = new HardwareLock(`ens-wind-tunnel:${scope}:usb-owner`)
  const subscribers = new Set<(snapshot: Snapshot) => void>()
  let fileOperation = false
  let fileCompletion: Promise<unknown> | null = null
  let shuttingDown = false
  let connectionRevision = 0
  let hardwareRequests = 0
  let shutdown: Promise<Result> | null = null
  const currentSnapshot = () => {
    const snapshot = service.snapshot()
    snapshot.disconnecting ||= shuttingDown
    return snapshot
  }
  const publish = () => {
    const snapshot = currentSnapshot()
    for (const callback of subscribers) callback(snapshot)
  }
  const ownsHardware = () => {
    const s = service.snapshot()
    return s.daq.state !== 'disconnected' || s.pitot.status !== 'disconnected'
  }
  const releaseIfIdle = () => {
    if (!hardwareRequests && !ownsHardware()) hardwareLock.unlock()
  }
  async function result<T>(operation: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      service.diagnostic('error', message)
      return { ok: false, error: message }
    } finally {
      publish()
      releaseIfIdle()
    }
  }
  function files<T>(operation: () => Promise<T>): Promise<T> {
    if (fileOperation) return Promise.reject(Error('Finish the current file operation first'))
    if (shuttingDown) return Promise.reject(Error('Disconnect is in progress'))
    fileOperation = true
    // Invoke now: file/USB choosers must be reached in the original click's activation.
    const completion = operation().finally(() => {
      fileOperation = false
      fileCompletion = null
    })
    fileCompletion = completion
    return completion
  }
  function chooseFile(name: string, extension: 'csv' | 'jsonl' | 'json'): Promise<SaveFileHandle> {
    if (!window.showSaveFilePicker) throw Error('Saving files requires desktop Edge or Chrome')
    return window.showSaveFilePicker({
      suggestedName: name,
      types: [
        {
          description: extension.toUpperCase(),
          accept: { 'text/plain': [`.${extension}`] },
        },
      ],
    })
  }
  async function save(handle: SaveFileHandle, chunks: AsyncIterable<string>): Promise<void> {
    if ((await handle.getFile()).size > 0)
      throw Error('Choose a new, empty file; existing data will not be overwritten')
    const output = await handle.createWritable()
    try {
      for await (const chunk of chunks) await output.write(chunk)
      await output.close()
    } catch (error) {
      await output.abort().catch(() => {})
      throw error
    }
  }
  function saveRecording(
    id: string | null,
    format: 'jsonl' | 'csv',
  ): Promise<Result<string | null>> {
    return result(() =>
      files(async () => {
        const selected = id ?? recorder.id
        if (!selected) throw Error('Record a run before exporting')
        if (selected === recorder.id && recorder.active)
          throw Error('Stop recording before exporting a completed run')
        // No storage await before the native picker; validation continues after it resolves.
        const name =
          id && id !== recorder.id
            ? `ENS-${id}.${format}`
            : (recorder.path ?? 'ENS-run.jsonl').replace(/\.jsonl$/i, '') + `.${format}`
        let handle: SaveFileHandle
        try {
          handle = await chooseFile(name, format)
        } catch (error) {
          if (canceled(error)) return null
          throw error
        }
        const session = (await recorder.storage.list()).find((s) => s.id === selected)
        if (!session) throw Error('The selected recording is unavailable')
        if (session.status === 'recording')
          service.diagnostic(
            'warning',
            'Exporting committed chunks of an unfinalized recording; its final samples may be missing.',
          )
        const chunks = recorder.storage.chunks(selected)
        await save(handle, format === 'csv' ? recordingCsv(chunks) : chunks)
        return name
      }),
    )
  }
  const api: TunnelApi = {
    snapshot: async () => currentSnapshot(),
    subscribe(callback) {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    act(action) {
      const requestedRevision = connectionRevision
      return result(async () => {
        if (
          shuttingDown &&
          action.type !== 'emergency-stop' &&
          !(action.type === 'fan-output' && action.percent === 0)
        )
          throw Error('Disconnect is in progress')
        const connecting = action.type === 'daq-connect'
        if (connecting) hardwareRequests++
        try {
          if (connecting) {
            await hardwareLock.acquire()
            if (shuttingDown || requestedRevision !== connectionRevision)
              throw Error('Connection canceled by Disconnect')
          }
          await service.act(action)
        } finally {
          if (connecting) hardwareRequests--
        }
      })
    },
    pitotAct(action) {
      const requestedRevision = connectionRevision
      return result(async () => {
        if (shuttingDown && !['stop', 'disconnect'].includes(action.type))
          throw Error('Disconnect is in progress')
        const connecting = action.type === 'connect'
        if (connecting) hardwareRequests++
        try {
          if (connecting) {
            if (serialRegistry.pitotPorts().length !== 1) await serialRegistry.request('pitot')
            await hardwareLock.acquire()
            if (shuttingDown || requestedRevision !== connectionRevision)
              throw Error('Connection canceled by Disconnect')
          }
          await service.actPitot(action)
        } finally {
          if (connecting) hardwareRequests--
        }
      })
    },
    requestPort(kind) {
      return result(async () => {
        if (shuttingDown) throw Error('Disconnect is in progress')
        try {
          return await serialRegistry.request(kind)
        } catch (error) {
          if (canceled(error)) return null
          throw error
        }
      })
    },
    listPorts: () => result(() => serialRegistry.refresh()),
    startRecording: () =>
      result(() =>
        files(async () => {
          const session = service.snapshot()
          if (session.daq.state !== 'connected') throw Error('Connect a DAQ before recording')
          const name = `ENS-hardware-${new Date().toISOString().replaceAll(':', '-')}.jsonl`
          await recorder.start(name, {
            channels: CHANNELS,
            settings: {
              samplePeriodMs: session.samplePeriodMs,
              roomTemperatureC: session.roomTemperatureC,
              calibrations: session.calibrations,
              fan: session.fan,
              daq: { path: session.daq.path, baudRate: session.daq.baudRate, format: 'binary' },
            },
            note: 'Live binary DAQ capture; recorded in this browser profile.',
          })
          if (
            shuttingDown ||
            service.snapshot().sourceVersion !== session.sourceVersion ||
            service.snapshot().daq.state !== 'connected'
          ) {
            await recorder.stop()
            throw Error('DAQ connection changed while starting recording')
          }
          // Persistent storage is requested without blocking acquisition if the browser declines.
          void navigator.storage?.persist?.().catch(() => false)
          return name
        }),
      ),
    stopRecording: () => result(() => files(() => recorder.stop())),
    exportCsv: () => saveRecording(null, 'csv'),
    saveRecording,
    listRecordings: () => result(() => recorder.storage.list()),
    disconnect() {
      if (shutdown) return shutdown
      shuttingDown = true
      connectionRevision++
      // Service blocks/supersedes commands synchronously, before awaiting a file chooser.
      const disconnecting = service.disconnectAll()
      shutdown = result(async () => {
        const results = await Promise.allSettled([disconnecting, fileCompletion])
        await recorder.stop()
        const failure = results.find((r) => r.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }).finally(() => {
        shuttingDown = false
        shutdown = null
        publish()
      })
      publish()
      return shutdown
    },
    importCalibrations: () =>
      result(() =>
        files(async () => {
          if (service.snapshot().daq.state !== 'disconnected')
            throw Error('Disconnect the DAQ before importing calibrations')
          if (!window.showOpenFilePicker) throw Error('Import requires desktop Edge or Chrome')
          let handles: { getFile(): Promise<File> }[]
          try {
            handles = await window.showOpenFilePicker({
              multiple: false,
              types: [
                { description: 'Hardware calibrations', accept: { 'application/json': ['.json'] } },
              ],
            })
          } catch (error) {
            if (canceled(error)) return
            throw error
          }
          const file = await handles[0]?.getFile()
          if (!file || file.size > 1_048_576)
            throw Error('Choose a calibration JSON file smaller than 1 MiB')
          await service.importCalibrations(JSON.parse(await file.text()))
        }),
      ),
    exportCalibrations: () =>
      result(() =>
        files(async () => {
          let handle: SaveFileHandle
          try {
            handle = await chooseFile('hardware-calibrations.json', 'json')
          } catch (error) {
            if (canceled(error)) return null
            throw error
          }
          async function* data() {
            yield JSON.stringify(service.snapshot().calibrations, null, 2) + '\n'
          }
          await save(handle, data())
          return 'hardware-calibrations.json'
        }),
      ),
  }
  await service.initialize()
  try {
    await recorder.restore()
  } catch (error) {
    service.diagnostic('error', `Recordings unavailable: ${String(error)}`)
  }
  let authorized = false
  try {
    await serialRegistry.refresh()
    authorized = true
  } catch (error) {
    service.diagnostic('warning', String(error))
  }
  setInterval(publish, 100)
  window.addEventListener('beforeunload', (event) => {
    if (ownsHardware() || recorder.active || service.snapshot().disconnecting || fileOperation) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  // Grant-free listing only. First-time access is always an explicit browser prompt.
  if (authorized && serialRegistry.list().filter(isPitotPort).length === 1)
    void api.pitotAct({ type: 'connect' })
  return api
}
