import { useState } from 'react'
import type { Channel, Snapshot } from '../../../shared/model'
import type { TrendPoint } from '../TrendChart'
import { MultiTrendChart, seriesColor } from '../MultiTrendChart'
import { Panel, format } from '../components/ui'

export function SensorPlots({
  channels,
  history,
  snapshot,
  title = 'Raw sensor graphs',
  initiallyAll = false,
}: {
  channels: Channel[]
  history: Record<string, TrendPoint[]>
  snapshot: Snapshot
  title?: string
  initiallyAll?: boolean
}) {
  const [selected, setSelected] = useState<string[]>(
    initiallyAll ? channels.map((c) => c.id) : channels.slice(0, 2).map((c) => c.id),
  )
  const [layout, setLayout] = useState<'overlay' | 'separate'>('overlay')
  const chosen = channels.filter((c) => selected.includes(c.id))
  const groups =
    layout === 'separate'
      ? chosen.map((c) => [c])
      : Object.values(
          chosen.reduce<Record<string, Channel[]>>((out, c) => {
            ;(out[c.unit] ??= []).push(c)
            return out
          }, {}),
        )
  const toggle = (id: string) =>
    setSelected((old) => (old.includes(id) ? old.filter((s) => s !== id) : [...old, id]))
  return (
    <Panel
      title={title}
      subtitle="Original board values · last 120 display updates · NaNs remain gaps; different units use different axes"
      action={
        <select
          aria-label="Graph layout"
          value={layout}
          onChange={(e) => setLayout(e.target.value as 'overlay' | 'separate')}
        >
          <option value="overlay">Overlay by unit</option>
          <option value="separate">One plot per sensor</option>
        </select>
      }
    >
      <div className="sensor-toolbar">
        <button onClick={() => setSelected(channels.map((c) => c.id))}>All sensors</button>
        <button onClick={() => setSelected([])}>Clear selection</button>
        <span>
          {selected.length} of {channels.length} selected
        </span>
      </div>
      <div className="sensor-picker">
        {channels.map((c, i) => {
          const m = snapshot.measurements[c.id]
          return (
            <label key={c.id} className={selected.includes(c.id) ? 'selected' : ''}>
              <input
                type="checkbox"
                aria-label={`Plot ${c.id}`}
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <i style={{ background: seriesColor(i) }} />
              <span>
                {c.name}
                <small>{c.id}</small>
              </span>
              <strong>
                {m?.rawSpecial ?? format(m?.raw, 1)} <small>{c.unit}</small>
              </strong>
            </label>
          )
        })}
      </div>
      {groups.length === 0 ? (
        <p className="panel-note">Select sensors to display their raw readings.</p>
      ) : (
        groups.map((group) => (
          <div className="sensor-plot" key={group.map((c) => c.id).join(',')}>
            <h3>{layout === 'separate' ? group[0]!.name : `${group[0]!.unit} channels`}</h3>
            <MultiTrendChart
              unit={group[0]!.unit}
              series={group.map((c) => ({
                id: c.id,
                label: c.id,
                color: seriesColor(channels.indexOf(c)),
                points: history[c.id] ?? [],
              }))}
            />
          </div>
        ))
      )}
    </Panel>
  )
}
