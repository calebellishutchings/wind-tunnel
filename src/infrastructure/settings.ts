import type { Calibration } from '../shared/model'
import type { CalibrationStore } from '../shared/storage'
import { calibrationSchema } from '../shared/calibration'

/** Validated calibration scoped to this website and browser profile. */
export class SettingsStore implements CalibrationStore {
  constructor(
    private readonly key = 'ens-wind-tunnel:hardware-calibrations',
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  ) {}
  async load(): Promise<Record<string, Calibration>> {
    const text = this.storage.getItem(this.key)
    return text ? calibrationSchema.parse(JSON.parse(text)) : {}
  }
  async save(calibrations: Record<string, Calibration>): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(calibrationSchema.parse(calibrations)))
  }
}
