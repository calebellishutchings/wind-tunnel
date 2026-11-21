import type { RecordingStorage, SessionSummary } from '../shared/storage'

/** Each chunk and its progress marker commit atomically; no run lives only in RAM. */
export class BrowserRecordingStorage implements RecordingStorage {
  private database: Promise<IDBDatabase> | null = null
  constructor(private readonly name = 'ens-wind-tunnel-recordings') {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('sessions', { keyPath: 'id' })
        request.result.createObjectStore('chunks')
      }
      request.onerror = () => reject(request.error ?? Error('Browser storage could not be opened'))
      request.onblocked = () =>
        reject(Error('Close other wind tunnel tabs to open recording storage'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          this.database = null
        }
        resolve(db)
      }
    }).catch((error: unknown) => {
      this.database = null
      throw error
    })
    return this.database
  }
  private async write(operation: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite', { durability: 'strict' })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? Error('Browser storage transaction aborted'))
      tx.onerror = () => reject(tx.error ?? Error('Browser storage write failed'))
      try {
        operation(tx)
      } catch (error) {
        tx.abort()
        reject(error)
      }
    })
  }
  create(session: SessionSummary): Promise<void> {
    return this.write((tx) => {
      tx.objectStore('sessions').add(session)
    })
  }
  append(session: SessionSummary, index: number, text: string): Promise<void> {
    return this.write((tx) => {
      tx.objectStore('chunks').add(text, [session.id, index])
      tx.objectStore('sessions').put(session)
    })
  }
  finalize(session: SessionSummary): Promise<void> {
    return this.write((tx) => {
      tx.objectStore('sessions').put(session)
    })
  }
  async list(): Promise<SessionSummary[]> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').getAll()
      request.onsuccess = () =>
        resolve(
          (request.result as SessionSummary[]).sort((a, b) =>
            b.startedAt.localeCompare(a.startedAt),
          ),
        )
      request.onerror = () => reject(request.error)
    })
  }
  async *chunks(id: string): AsyncIterable<string> {
    const db = await this.open()
    // One committed chunk at a time: long recordings never have to fit in memory.
    for (let index = 0; ; index++) {
      const chunk = await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction('chunks').objectStore('chunks').get([id, index])
        request.onsuccess = () => resolve(request.result as string | undefined)
        request.onerror = () => reject(request.error)
      })
      if (chunk === undefined) return
      yield chunk
    }
  }
}
