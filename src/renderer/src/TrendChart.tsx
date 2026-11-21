export interface TrendPoint {
  at: number
  value: number | null
}
export function TrendChart({ points, unit }: { points: TrendPoint[]; unit: string }) {
  const values = points.flatMap((p) => (p.value !== null ? [p.value] : []))
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 10
  const span = Math.max(max - min, Math.abs(max) * 0.000001, 0.01)
  const low = min - span * 0.1
  const high = max + span * 0.15
  const first = points[0]?.at ?? 0
  const last = points.at(-1)?.at ?? first + 1
  const x = (at: number) => 95 + ((at - first) / (last - first || 1)) * 750
  const y = (value: number) => 224 - ((value - low) / (high - low)) * 202
  let penDown = false
  const path = points
    .map((point) => {
      if (point.value === null) {
        penDown = false
        return ''
      }
      const segment = `${penDown ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`
      penDown = true
      return segment
    })
    .join(' ')
  return (
    <div className="chart-wrap">
      <svg
        className="trend-chart"
        viewBox="0 0 870 270"
        role="img"
        aria-label={`Live trend in ${unit}, ${points.length} display updates`}
      >
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = low + ((high - low) * tick) / 4
          return (
            <g key={tick}>
              <line x1="95" x2="845" y1={y(value)} y2={y(value)} className="grid-line" />
              <text x="85" y={y(value) + 4} textAnchor="end">
                {value.toFixed(1)}
              </text>
            </g>
          )
        })}
        <path d={path} className="trend-line" />
        {[0, 1, 2, 3, 4].map((tick) => (
          <text key={tick} x={95 + tick * 187.5} y="252" textAnchor="middle">
            {Math.round(((last - first) / 1000) * (1 - tick / 4))}s ago
          </text>
        ))}
        {!values.length && (
          <text x="440" y="125" textAnchor="middle" className="chart-empty">
            Start acquisition to see the live trend
          </text>
        )}
      </svg>
    </div>
  )
}
