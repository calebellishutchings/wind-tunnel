import { expect, it } from 'vitest'
import { fanMillivolts } from '../src/domain/fan'
import { FanOutput } from '../src/main/fan-output'
import { actionSchema } from '../src/shared/validation'

it('maps percentages to integer millivolts with strict 3 V bounds', () => {
  expect([0, 5, 50, 100].map(fanMillivolts)).toEqual([0, 150, 1500, 3000])
  expect(fanMillivolts(12.34)).toBe(370)
  for (const percent of [-1, 100.01, NaN, Infinity]) {
    expect(() => fanMillivolts(percent)).toThrow()
    expect(actionSchema.safeParse({ type: 'fan-output', percent }).success).toBe(false)
  }
})
it('requires acknowledged zero, exact DAC acknowledgments, and resets its trust on disconnect', async () => {
  const writes: string[] = []
  const fan = new FanOutput(async (command) => {
    writes.push(command.toString('hex'))
    fan.message(`DAC output set to ${command.readUInt16BE(1)} mV`)
  }, 30)
  await expect(fan.setPercent(5)).rejects.toThrow('Verify zero')
  expect(writes).toEqual([])
  await fan.setPercent(0)
  await fan.setPercent(100)
  expect(writes).toEqual(['210000', '210bb8'])
  expect(fan.snapshot()).toMatchObject({ status: 'confirmed', confirmedMillivolts: 3000 })
  fan.reset()
  expect(fan.snapshot().confirmedMillivolts).toBeNull()
  await expect(fan.setPercent(5)).rejects.toThrow('Verify zero')
})
it('does not treat a successful serial write or mismatched message as an acknowledged DAC value', async () => {
  const fan = new FanOutput(async () => {
    fan.message('DAC output set to 999 mV')
  }, 10)
  await expect(fan.setPercent(0)).rejects.toThrow('No board acknowledgment')
  expect(fan.snapshot()).toMatchObject({ status: 'error', confirmedMillivolts: null })
})
it('rejects firmware DAC failures and permits a subsequent zero retry', async () => {
  let fail = true
  const fan = new FanOutput(
    async () => fan.message(fail ? 'DAC init failed' : 'DAC output set to 0 mV'),
    10,
  )
  await expect(fan.setPercent(0)).rejects.toThrow('DAC init failed')
  fail = false
  await fan.setPercent(0)
  expect(fan.snapshot().confirmedMillivolts).toBe(0)
})
it('cannot restore a confirmed state from an in-flight request after USB loss', async () => {
  const fan = new FanOutput(async () => {
    fan.reset('USB lost')
  }, 10)
  await expect(fan.setPercent(0)).rejects.toThrow('USB lost')
  expect(fan.snapshot()).toMatchObject({ status: 'unverified', confirmedMillivolts: null })
})
