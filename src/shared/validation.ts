import { z } from 'zod'
import { CHANNELS, allowedCalibrationUnits } from './model'
const channelId = z.string().refine((id) => CHANNELS.some((c) => c.id === id), 'Unknown channel')
const finite = z.number().finite()
export const actionSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('fan-output'), percent: finite.min(0).max(100) }).strict(),
    z.object({ type: z.literal('emergency-stop') }).strict(),
    z.object({ type: z.literal('emergency-reset') }).strict(),
    z
      .object({
        type: z.literal('daq-connect'),
        path: z.string().regex(/^COM[1-9]\d{0,3}$/i),
        baudRate: z.union([z.literal(115200), z.literal(9600)]),
      })
      .strict(),
    z.object({ type: z.literal('daq-disconnect') }).strict(),
    z
      .object({
        type: z.literal('acquisition'),
        running: z.boolean(),
        periodMs: finite.int().min(100).max(10000),
      })
      .strict(),
    z.object({ type: z.literal('temperature'), celsius: finite.min(-20).max(60) }).strict(),
    z.object({ type: z.literal('tare'), channelId }).strict(),
    z.object({ type: z.literal('reset-calibration'), channelId }).strict(),
    z
      .object({
        type: z.literal('calibrate'),
        channelId,
        points: z
          .array(z.object({ raw: finite, reference: finite }).strict())
          .min(2)
          .max(100),
        unit: z.enum(['N', 'Pa', 'kPa', '°C', 'raw']),
      })
      .strict(),
  ])
  .refine(
    (action) =>
      action.type !== 'calibrate' ||
      allowedCalibrationUnits(action.channelId).includes(action.unit),
    'Calibration must retain the channel’s canonical unit; bridges support raw or N.',
  )
