#!/usr/bin/env node
// Independent, offline wire-format audit. Reads capture files; never opens serial ports.
const { readFileSync, writeFileSync } = require('node:fs')
const sizes = { 2: 4, 3: 4, 4: 1, 5: 4, 6: 24 }
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : null
}
function audit(file) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  let buffer = Buffer.alloc(0)
  const frames = [],
    messages = [],
    unknown = []
  for (const row of rows.filter((r) => r.direction === 'rx')) {
    buffer = Buffer.concat([buffer, Buffer.from(row.hex, 'hex')])
    while (buffer.length) {
      const bank = buffer[0]
      if ([0xd0, 0xe0, 0xe1].includes(bank)) {
        const end = buffer.indexOf(bank, 1)
        if (end < 0) break
        messages.push(buffer.subarray(1, end).toString('utf8').trim())
        buffer = buffer.subarray(end + 1)
      } else if (sizes[bank]) {
        const count = sizes[bank],
          length = 5 + count * 4
        if (buffer.length < length) break
        frames.push({
          bank,
          stage: row.stage,
          at: typeof row.receivedAt === 'number' ? row.receivedAt : Date.parse(row.at),
          micros: buffer.readUInt32LE(1 + count * 4),
          values: Array.from({ length: count }, (_, i) => buffer.readFloatLE(1 + i * 4)),
        })
        buffer = buffer.subarray(length)
      } else {
        unknown.push(buffer[0])
        buffer = buffer.subarray(1)
      }
    }
  }
  const banks = {}
  for (const bank of Object.keys(sizes)) {
    const selected = frames.filter((f) => f.bank === Number(bank))
    const intervals = selected
      .slice(1)
      .map((f, i) => ((f.micros - selected[i].micros) >>> 0) / 1000)
    const channelStats = Array.from({ length: sizes[bank] }, (_, i) => {
      const values = selected.map((f) => f.values[i]),
        finite = values.filter(Number.isFinite)
      const validAt = selected.filter((f) => Number.isFinite(f.values[i])).map((f) => f.at)
      return {
        slot: i + 1,
        valid: finite.length,
        invalid: values.length - finite.length,
        first: finite.slice(0, 8),
        min: finite.length ? Math.min(...finite) : null,
        max: finite.length ? Math.max(...finite) : null,
        median: quantile(finite, 0.5),
        validArrivalGapMedianMs: quantile(
          validAt.slice(1).map((t, i) => t - validAt[i]),
          0.5,
        ),
        validArrivalGapMaxMs:
          validAt.length > 1 ? Math.max(...validAt.slice(1).map((t, i) => t - validAt[i])) : null,
      }
    })
    banks[bank] = {
      frames: selected.length,
      deviceIntervalMs: {
        min: intervals.length ? Math.min(...intervals) : null,
        median: quantile(intervals, 0.5),
        p95: quantile(intervals, 0.95),
        max: intervals.length ? Math.max(...intervals) : null,
      },
      channels: channelStats,
    }
  }
  return {
    file,
    rxBytes: rows.filter((r) => r.direction === 'rx').reduce((s, r) => s + r.hex.length / 2, 0),
    frames: frames.length,
    unknownBytes: unknown.length,
    trailingBytes: buffer.length,
    messages,
    banks,
  }
}
const files = process.argv.slice(2)
if (!files.length) throw Error('Usage: node scripts/analyze-daq-capture.cjs capture.jsonl [...]')
for (const file of files) {
  const result = audit(file)
  const destination = file.replace(/\.jsonl$/i, '') + '-analysis.json'
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
