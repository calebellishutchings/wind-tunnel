import type { Measurement, DataMode } from '../shared/model'
import type { RecordingStorage, SessionRecorder, SessionSummary } from '../shared/storage'
import { BrowserRecordingStorage } from './browser-storage'

/** Append-only, bounded queue. Completed IndexedDB transactions survive page reloads. */
export class Recorder implements SessionRecorder {
  private session: SessionSummary | null = null
  private queue: string[] = []
  private queuedBytes = 0
  private writing: Promise<void> = Promise.resolve()
  private closing: Promise<void> | null = null
  private accepting = false
  private finalizationError: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private mode: DataMode = 'hardware'
  path: string | null = null
  rows = 0
  error: string | null = null
  constructor(
    readonly storage: RecordingStorage = new BrowserRecordingStorage(),
    private readonly maxQueuedBytes = 1_048_576,
  ) {}
  get active(): boolean {
    return this.accepting && this.error === null && this.closing === null
  }
  get id(): string | null {
    return this.session?.id ?? null
  }
  async restore(): Promise<void> {
    const latest = (await this.storage.list())[0]
    if (latest) {
      this.session = latest
      this.path = latest.name
      this.rows = latest.rows
    }
  }
  async start(name: string, metadata: unknown, mode: DataMode = 'hardware'): Promise<void> {
    if (this.active || this.closing) throw Error('A recording is already open')
    if (this.session && this.error) await this.stop().catch(() => {})
    const session: SessionSummary = {
      id: crypto.randomUUID(),
      name,
      startedAt: new Date().toISOString(),
      rows: 0,
      chunks: 0,
      status: 'recording',
      error: null,
    }
    await this.storage.create(session)
    this.session = session
    this.path = name
    this.rows = 0
    this.error = null
    this.finalizationError = null
    this.mode = mode
    this.queue = []
    this.queuedBytes = 0
    this.writing = Promise.resolve()
    this.accepting = true
    this.append({ type: 'session', schemaVersion: 1, mode, startedAt: session.startedAt, metadata })
    this.flush()
    await this.writing
    if (this.error) throw Error(this.error)
  }
  append(record: unknown): boolean {
    if (!this.active) return false
    const line = JSON.stringify(record) + '\n'
    const size = new TextEncoder().encode(line).byteLength
    if (this.queuedBytes + size > this.maxQueuedBytes) {
      this.error =
        'Browser storage cannot keep up. Recording stopped before memory could grow without bound.'
      this.accepting = false
      this.flush()
      return false
    }
    this.queue.push(line)
    this.queuedBytes += size
    if (this.queuedBytes >= 65536) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 100)
    return true
  }
  measurement(measurement: Measurement): void {
    this.rows++
    if (!this.append({ type: 'measurement', mode: this.mode, ...measurement })) this.rows--
  }
  private flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.queue.length || !this.session) return
    const text = this.queue.join('')
    const size = new TextEncoder().encode(text).byteLength
    const rows = this.rows
    const session = this.session
    this.queue = []
    this.writing = this.writing.then(async () => {
      if (!session.error) {
        try {
          const progress = { ...session, rows, chunks: session.chunks + 1 }
          await this.storage.append(progress, session.chunks, text)
          Object.assign(session, progress)
        } catch (error) {
          this.error = `Recording failed: ${String(error)}. Previously committed chunks remain available.`
          session.error = this.error
          this.accepting = false
        }
      }
      this.queuedBytes -= size
    })
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing
    const retryFinalization = this.finalizationError !== null
    if (retryFinalization && this.session) {
      this.error = this.session.error
      this.finalizationError = null
    }
    if (
      !this.session ||
      (!retryFinalization && !this.accepting && !this.queue.length && !this.timer && !this.error)
    )
      return this.writing
    this.accepting = false
    this.flush()
    const session = this.session
    this.closing = (async () => {
      await this.writing
      session.status = this.error ? 'error' : 'complete'
      session.error = this.error
      // Use committed rows; a storage failure may have rejected the final batch.
      try {
        await this.storage.finalize({ ...session })
      } catch (error) {
        this.finalizationError = `Recording finalization failed: ${String(error)}. Committed data remains available; retry Disconnect.`
        this.error = this.finalizationError
        throw Error(this.error)
      }
      if (this.error) throw Error(this.error)
    })().finally(() => {
      this.closing = null
    })
    return this.closing
  }
}
export const CSV_COLUMNS = [
  'mode',
  'channelId',
  'raw',
  'rawSpecial',
  'value',
  'unit',
  'quality',
  'deviceMicros',
  'elapsedMicros',
  'receivedAt',
  'sequence',
  'calibrationVersion',
] as const
const cell = (value: unknown): string =>
  '"' + (value == null ? '' : String(value)).replaceAll('"', '""') + '"'

export async function* recordingCsv(chunks: AsyncIterable<string>): AsyncIterable<string> {
  yield CSV_COLUMNS.join(',') + '\n'
  for await (const chunk of chunks) {
    const rows: string[] = []
    for (const line of chunk.split('\n')) {
      if (!line) continue
      const record = JSON.parse(line) as Record<string, unknown>
      if (record.type !== 'measurement') continue
      const row = { ...record, mode: record.mode ?? 'hardware' }
      rows.push(CSV_COLUMNS.map((key) => cell(row[key as keyof typeof row])).join(',') + '\n')
    }
    if (rows.length) yield rows.join('')
  }
}
