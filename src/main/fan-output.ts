import type { FanState } from '../shared/model'
import { fanMillivolts, FanRequestSupersededError } from '../domain/fan'
import { dacCommand } from '../domain/protocol'

/** Serial acknowledgment means DAC write accepted, not measured fan speed or voltage. */
export class FanOutput {
  private state: FanState = this.initial()
  private zeroEstablished = false
  private generation = 0
  private pending: {
    millivolts: number
    resolve: () => void
    reject: (error: Error) => void
  } | null = null
  constructor(
    private readonly send: (command: Uint8Array) => Promise<void>,
    private readonly timeoutMs = 1800,
  ) {}
  private initial(): FanState {
    return { status: 'unverified', requestedMillivolts: 0, confirmedMillivolts: null, error: null }
  }
  snapshot(): FanState {
    return { ...this.state }
  }
  reset(reason = 'DAQ disconnected; output cannot be verified'): void {
    this.generation++
    this.pending?.reject(new Error(reason))
    this.zeroEstablished = false
    this.state = this.initial()
  }
  message(message: string): void {
    const pending = this.pending
    if (!pending) return
    if (message.trim() === `DAC output set to ${pending.millivolts} mV`) pending.resolve()
    else if (/DAC.*(?:failed|unavailable)|Advanced command not implemented/i.test(message))
      pending.reject(new Error(message.trim()))
  }
  async setPercent(percent: number): Promise<void> {
    const millivolts = fanMillivolts(percent)
    if (this.pending) throw new Error('A DAC command is already pending')
    if (millivolts > 0 && !this.zeroEstablished)
      throw new Error('Verify zero output before applying a nonzero fan percentage')
    const previous = this.state
    const generation = this.generation
    this.state = { ...this.state, status: 'sending', requestedMillivolts: millivolts, error: null }
    let timer: ReturnType<typeof setTimeout> | undefined
    const acknowledgment = new Promise<void>((resolve, reject) => {
      this.pending = { millivolts, resolve, reject }
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `No board acknowledgment for DAC ${millivolts} mV. Use the physical VFD Stop.`,
            ),
          ),
        this.timeoutMs,
      )
    })
    const result = acknowledgment.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      // Listen before writing: a real or fixture board may respond immediately.
      // Finish the transport write before another command can be queued after a timeout.
      await this.send(dacCommand(millivolts))
      const error = await result
      if (error) throw error
      if (generation !== this.generation)
        throw new Error('DAQ connection changed during DAC request')
      this.zeroEstablished = true
      this.state = {
        status: 'confirmed',
        requestedMillivolts: millivolts,
        confirmedMillivolts: millivolts,
        error: null,
      }
    } catch (error) {
      if (generation !== this.generation) throw error
      if (error instanceof FanRequestSupersededError) {
        this.state = previous
        throw error
      }
      this.zeroEstablished = false
      this.state = {
        ...this.state,
        status: 'error',
        confirmedMillivolts: null,
        error: String(error),
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.pending = null
    }
  }
}
