import type { TrendPoint } from './TrendChart'
export interface PlotSeries {
  id: string
  label: string
  color: string
  points: TrendPoint[]
}
export const seriesColor = (index: number): string =>
  `hsl(${(index * 137.508 + 165) % 360} 64% 38%)`
export function MultiTrendChart({ series, unit }: { series: PlotSeries[]; unit: string }) {
  const points = series.flatMap((s) => s.points)
  const values = points.flatMap((p) =>
    p.value !== null && Number.isFinite(p.value) ? [p.value] : [],
  )
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 10
  const span = Math.max(max - min, Math.abs(max) * 0.000001, 0.01)
  const low = min - span * 0.1,
    high = max + span * 0.15
  const first = points.length ? Math.min(...points.map((p) => p.at)) : 0
  const last = points.length ? Math.max(...points.map((p) => p.at)) : 1
  const x = (at: number) => 95 + ((at - first) / (last - first || 1)) * 750
  const y = (value: number) => 224 - ((value - low) / (high - low)) * 202
  const path = (data: TrendPoint[]) => {
    let pen = false
    return data
      .map((p) => {
        if (p.value === null) {
          pen = false
          return ''
        }
        const v = `${pen ? 'L' : 'M'}${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`
        pen = true
        return v
      })
      .join(' ')
  }
  return (
    <div className="chart-wrap">
      <svg
        className="trend-chart"
        viewBox="0 0 870 270"
        role="img"
        aria-label={`${series.length} sensor trends in ${unit}`}
      >
        {[0, 1, 2, 3, 4].map((t) => {
          const v = low + ((high - low) * t) / 4
          return (
            <g key={t}>
              <line x1="95" x2="845" y1={y(v)} y2={y(v)} className="grid-line" />
              <text x="85" y={y(v) + 4} textAnchor="end">
                {Math.abs(v) > 1e7 ? v.toExponential(2) : v.toFixed(1)}
              </text>
            </g>
          )
        })}
        {series.map((s) => (
          <path
            key={s.id}
            d={path(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ))}
        {[0, 1, 2, 3, 4].map((t) => (
          <text key={t} x={95 + t * 187.5} y="252" textAnchor="middle">
            {(((last - first) / 1000) * (1 - t / 4)).toFixed(1)}s ago
          </text>
        ))}
        {!values.length && (
          <text x="440" y="125" textAnchor="middle">
            Waiting for selected sensor data
          </text>
        )}
      </svg>
      <div className="plot-legend">
        {series.map((s) => (
          <span key={s.id}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
