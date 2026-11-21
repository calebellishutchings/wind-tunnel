import type { ReactNode } from 'react'
import type { Measurement } from '../../../shared/model'

export function format(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits)
}
export function valid(measurement: Measurement | undefined, expectedUnit?: string): number | null {
  return measurement?.quality === 'good' && (!expectedUnit || measurement.unit === expectedUnit)
    ? measurement.value
    : null
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
export function QualityBadge({ quality }: { quality: string }) {
  return (
    <span className={`quality ${quality}`}>
      <span />
      {quality}
    </span>
  )
}

export function Metric({
  label,
  value,
  unit,
  detail,
  icon,
  featured = false,
}: {
  label: string
  value: string
  unit: string
  detail: string
  icon: ReactNode
  featured?: boolean
}) {
  return (
    <div className={`metric ${featured ? 'featured' : ''}`}>
      <div className="metric-label">
        {label}
        <span>{icon}</span>
      </div>
      <div className="metric-value">
        {value}
        <span>{unit}</span>
      </div>
      <p>{detail}</p>
    </div>
  )
}
