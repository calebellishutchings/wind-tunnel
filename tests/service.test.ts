import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Recorder, exportRecordingCsv } from './support/node-recording'
describe('board recording storage', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ens-recording-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  it('records hardware source, NaN identity and zeros in CSV', async () => {
    const recorder = new Recorder()
    const path = join(directory, 'run.jsonl')
    await recorder.start(path, {})
    for (const [raw, rawSpecial] of [
      [0, undefined],
      [null, 'NaN'],
    ] as const)
      recorder.measurement({
        channelId: 'press1',
        raw,
        rawSpecial,
        value: raw,
        unit: 'Pa',
        quality: raw === null ? 'invalid' : 'good',
        deviceMicros: 100,
        elapsedMicros: 0,
        receivedAt: 1000,
        sequence: 1,
        calibrationVersion: 0,
      })
    await recorder.stop()
    const lines = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ mode: 'hardware', schemaVersion: 1 })
    await exportRecordingCsv(path, join(directory, 'run.csv'))
    const csv = await readFile(join(directory, 'run.csv'), 'utf8')
    expect(csv).toContain('"hardware","press1","0"')
    expect(csv).toContain('"NaN"')
    await expect(exportRecordingCsv(path, join(directory, 'run.csv'))).rejects.toThrow()
    await expect(recorder.start(path, {})).rejects.toThrow()
  })
  it('reports invalid destinations and recovers from bounded backpressure', async () => {
    const recorder = new Recorder()
    await expect(recorder.start(join(directory, 'missing', 'run.jsonl'), {})).rejects.toThrow()
    await recorder.start(join(directory, 'slow.jsonl'), {})
    expect(recorder.append({ payload: 'x'.repeat(2_000_000) })).toBe(true)
    expect(recorder.append({ type: 'next' })).toBe(false)
    expect(recorder.error).toContain('cannot keep up')
    await recorder.start(join(directory, 'recovered.jsonl'), {})
    expect(recorder.active).toBe(true)
    await recorder.stop()
  })
})
