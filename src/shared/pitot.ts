import { z } from 'zod'

// Operator-selected conservative envelope while the larger physical axis is being checked.
// Axis order is unchanged: app X/Y map directly to Marlin X/Y.
export const PITOT_LIMITS_MM = { x: 360, y: 360 } as const
export const PITOT_FEED_MM_MIN = 4000
export const PITOT_UUID = 'cede2a2f-41a2-4748-9b12-c55c62f367ff'
export interface PitotState {
  status: 'disconnected' | 'connecting' | 'homing' | 'ready' | 'moving' | 'fault'
  path: string | null
  homed: boolean
  position: { x: number; y: number } | null
  error: string | null
  transcript: { at: number; direction: 'rx' | 'tx'; text: string }[]
}
export const initialPitot = (): PitotState => ({
  status: 'disconnected',
  path: null,
  homed: false,
  position: null,
  error: null,
  transcript: [],
})
export function isPitotPort(port: { vendorId?: string; productId?: string }): boolean {
  return port.vendorId?.toUpperCase() === '1A86' && port.productId?.toUpperCase() === '7523'
}
export const pitotActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect') }).strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('home') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z
    .object({
      type: z.literal('move'),
      x: z
        .number()
        .finite()
        .min(0)
        .max(PITOT_LIMITS_MM.x)
        .transform((n) => Math.round(n * 100) / 100),
      y: z
        .number()
        .finite()
        .min(0)
        .max(PITOT_LIMITS_MM.y)
        .transform((n) => Math.round(n * 100) / 100),
    })
    .strict(),
])
export type PitotAction = z.infer<typeof pitotActionSchema>
