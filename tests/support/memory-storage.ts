import type { RecordingStorage, SessionSummary } from '../../src/shared/storage'
export class MemoryRecordingStorage implements RecordingStorage {
  sessions = new Map<string, SessionSummary>()
  data = new Map<string, string[]>()
  failWrites = false
  failFinalization = false
  async create(session: SessionSummary) {
    if (this.sessions.has(session.id)) throw Error('Duplicate run')
    this.sessions.set(session.id, { ...session })
    this.data.set(session.id, [])
  }
  async append(session: SessionSummary, index: number, text: string) {
    if (this.failWrites) throw Error('Storage quota exceeded')
    const chunks = this.data.get(session.id)!
    if (index !== chunks.length) throw Error('Non-append write')
    chunks.push(text)
    this.sessions.set(session.id, { ...session })
  }
  async finalize(session: SessionSummary) {
    if (this.failFinalization) throw Error('Finalization failed')
    this.sessions.set(session.id, { ...session })
  }
  async list() {
    return [...this.sessions.values()].reverse()
  }
  async *chunks(id: string) {
    for (const text of this.data.get(id) ?? []) yield text
  }
}
