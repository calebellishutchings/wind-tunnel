import { describe, expect, it } from 'vitest'
import { Recorder, recordingCsv } from '../src/infrastructure/recording'
import { MemoryRecordingStorage } from './support/memory-storage'
import type { Measurement } from '../src/shared/model'

const sample = (raw: number | null): Measurement => ({
  channelId: 'press1',
  raw,
  ...(raw === null ? { rawSpecial: 'NaN' as const } : {}),
  value: raw,
  unit: 'Pa',
  quality: raw === null ? 'invalid' : 'good',
  deviceMicros: 100,
  elapsedMicros: 0,
  receivedAt: 1000,
  sequence: 1,
  calibrationVersion: 0,
})

describe('persistent browser recorder', () => {
  it('commits raw metadata and samples, restores after reload, and streams compatible CSV', async () => {
    const store = new MemoryRecordingStorage()
    const recorder = new Recorder(store)
    await recorder.start('run.jsonl', { description: 'saved board data' })
    recorder.measurement(sample(0))
    recorder.measurement(sample(null))
    await recorder.stop()
    const [saved] = await store.list()
    expect(saved).toMatchObject({ rows: 2, status: 'complete', error: null })
    const restored = new Recorder(store)
    await restored.restore()
    expect(restored.active).toBe(false)
    expect(restored.path).toBe('run.jsonl')
    let csv = ''
    for await (const chunk of recordingCsv(store.chunks(restored.id!))) csv += chunk
    expect(csv.trim().split('\n')).toHaveLength(3)
    expect(csv).toContain('"hardware","press1","0"')
    expect(csv).toContain('"NaN"')
    await recorder.start('run.jsonl', {}) // distinct run ID, never replaces an earlier run
    await recorder.stop()
    expect(await store.list()).toHaveLength(2)
  })
  it('stops visibly at the queue limit, drains accepted records, and can begin a new run', async () => {
    const store = new MemoryRecordingStorage()
    const recorder = new Recorder(store, 512)
    await recorder.start('bounded.jsonl', {})
    expect(recorder.append({ data: 'a'.repeat(300) })).toBe(true)
    expect(recorder.append({ data: 'b'.repeat(300) })).toBe(false)
    expect(recorder.active).toBe(false)
    await expect(recorder.stop()).rejects.toThrow('cannot keep up')
    expect((await store.list())[0]?.status).toBe('error')
    expect(store.data.get(recorder.id!)?.join('')).toContain('a'.repeat(300))
    await recorder.start('recovered.jsonl', {})
    expect(recorder.active).toBe(true)
    await recorder.stop()
  })
  it('reports quota failure without claiming uncommitted samples or deleting earlier chunks', async () => {
    const store = new MemoryRecordingStorage()
    const recorder = new Recorder(store)
    await recorder.start('quota.jsonl', {})
    store.failWrites = true
    recorder.measurement(sample(10))
    await expect(recorder.stop()).rejects.toThrow('quota')
    expect((await store.list())[0]).toMatchObject({ rows: 0, status: 'error', chunks: 1 })
    expect(store.data.get(recorder.id!)).toHaveLength(1)
  })
})
