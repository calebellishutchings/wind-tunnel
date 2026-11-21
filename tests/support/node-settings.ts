import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { CHANNELS, allowedCalibrationUnits, type Calibration } from '../../src/shared/model'
const calibration = z
  .object({
    channelId: z.string(),
    scale: z.number().finite(),
    offset: z.number().finite(),
    unit: z.enum(['N', 'Pa', 'kPa', '°C', 'raw']),
    version: z.number().int().nonnegative(),
    points: z
      .array(z.object({ raw: z.number().finite(), reference: z.number().finite() }))
      .optional(),
  })
  .strict()
const schema = z
  .record(z.string(), calibration)
  .refine((value) =>
    Object.entries(value).every(
      ([id, entry]) =>
        id === entry.channelId &&
        CHANNELS.some((c) => c.id === id) &&
        allowedCalibrationUnits(id).includes(entry.unit),
    ),
  )
export class SettingsStore {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  async load(): Promise<Record<string, Calibration>> {
    try {
      return schema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  save(calibrations: Record<string, Calibration>): Promise<void> {
    const data = JSON.stringify(schema.parse(calibrations), null, 2)
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(this.path + '.tmp', data, 'utf8')
        await rename(this.path + '.tmp', this.path)
      })
    this.queue = operation
    return operation
  }
}
