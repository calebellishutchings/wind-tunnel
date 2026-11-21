import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import type { Measurement, DataMode } from '../shared/model'

/** Append-only run log. Calibration metadata is stored before affected samples. */
export class Recorder {
  private stream: WriteStream | null = null
  private closing: Promise<void> | null = null
  private blocked = false
  path: string | null = null
  rows = 0
  error: string | null = null
  private mode: DataMode = 'hardware'
  get active(): boolean {
    return this.stream !== null && this.error === null && this.closing === null
  }
  async start(path: string, metadata: unknown, mode: DataMode = 'hardware'): Promise<void> {
    // An I/O failure stops the run but must not strand the session permanently.
    if (this.stream && this.error) await this.stop().catch(() => {})
    if (this.stream || this.closing) throw new Error('A recording is already open')
    const stream = createWriteStream(path, { flags: 'wx', encoding: 'utf8' })
    stream.on('error', (error) => {
      this.error = error.message
    })
    try {
      await once(stream, 'open')
    } catch (error) {
      stream.destroy()
      throw error
    }
    this.stream = stream
    this.path = path
    this.rows = 0
    this.error = null
    this.blocked = false
    this.mode = mode
    stream.on('drain', () => {
      this.blocked = false
    })
    this.append({
      type: 'session',
      schemaVersion: 1,
      mode,
      startedAt: new Date().toISOString(),
      metadata,
    })
  }
  append(record: unknown): boolean {
    if (!this.active) return false
    if (this.blocked) {
      this.error =
        'Recording disk cannot keep up. Recording stopped before memory could grow without bound.'
      this.stream?.end()
      return false
    }
    this.blocked = !this.stream!.write(JSON.stringify(record) + '\n')
    return true
  }
  measurement(measurement: Measurement): void {
    if (this.append({ type: 'measurement', mode: this.mode, ...measurement })) this.rows++
  }
  async stop(): Promise<void> {
    if (this.closing) return this.closing
    const stream = this.stream
    if (!stream) return
    this.closing = (async () => {
      stream.end()
      try {
        await finished(stream)
      } finally {
        this.stream = null
        this.closing = null
      }
      if (this.error) throw new Error(this.error)
    })()
    return this.closing
  }
}
const COLUMNS = [
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
function cell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return '"' + text.replaceAll('"', '""') + '"'
}
/** Stream from a completed log so long runs never need to fit in memory. */
export async function exportRecordingCsv(source: string, target: string): Promise<void> {
  const input = createReadStream(source, { encoding: 'utf8' })
  const output = createWriteStream(target, { flags: 'wx', encoding: 'utf8' })
  let writeError: Error | null = null
  output.on('error', (error) => {
    writeError = error
    input.destroy(error)
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    output.write(COLUMNS.join(',') + '\n')
    for await (const line of lines) {
      if (writeError) throw writeError
      const record = JSON.parse(line) as Record<string, unknown>
      if (record.type !== 'measurement') continue
      const row = { ...record, mode: record.mode ?? 'hardware' }
      if (!output.write(COLUMNS.map((key) => cell(row[key as keyof typeof row])).join(',') + '\n'))
        await once(output, 'drain')
    }
    output.end()
    await finished(output)
  } catch (error) {
    output.destroy()
    throw error
  } finally {
    lines.close()
    input.destroy()
  }
}
