import { z } from 'zod'
import { CHANNELS, allowedCalibrationUnits } from './model'

export const calibrationSchema = z
  .record(
    z.string(),
    z
      .object({
        channelId: z.string(),
        scale: z.number().finite(),
        offset: z.number().finite(),
        unit: z.enum(['N', 'Pa', 'kPa', '°C', 'raw']),
        version: z.number().int().nonnegative(),
        points: z
          .array(z.object({ raw: z.number().finite(), reference: z.number().finite() }).strict())
          .max(100)
          .optional(),
      })
      .strict(),
  )
  .refine((value) =>
    Object.entries(value).every(
      ([id, entry]) =>
        id === entry.channelId &&
        CHANNELS.some((c) => c.id === id) &&
        allowedCalibrationUnits(id).includes(entry.unit),
    ),
  )
