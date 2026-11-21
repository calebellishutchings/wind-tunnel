import { useState } from 'react'
import { CHANNELS, type Snapshot } from '../../../shared/model'
import { Panel, QualityBadge, format, valid } from '../components/ui'

export function PressureGrid({
  snapshot,
  compact = false,
}: {
  snapshot: Snapshot
  compact?: boolean
}) {
  return (
    <div className={`pressure-grid ${compact ? 'compact' : ''}`}>
      {CHANNELS.filter((c) => c.bank === 6).map((channel) => {
        const measurement = snapshot.measurements[channel.id]
        const value = valid(measurement)
        return (
          <div
            key={channel.id}
            className={`pressure-cell ${value === null ? 'unavailable' : value < 0 ? 'negative' : 'positive'}`}
          >
            <span>{String(channel.index + 1).padStart(2, '0')}</span>
            <strong>{format(value, 1)}</strong>
            {!compact && (
              <>
                <small>{measurement?.unit ?? 'Pa'}</small>
                <QualityBadge quality={measurement?.quality ?? 'missing'} />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
export function ChannelTable({ snapshot }: { snapshot: Snapshot }) {
  const [search, setSearch] = useState('')
  const channels = CHANNELS.filter((c) =>
    `${c.name} ${c.id} ${c.group}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <Panel
      title="All measurement channels"
      subtitle="Raw values are unchanged. Atmospheric display bridges invalid packets for at most 2 s, labeled held."
      action={
        <input
          className="search"
          aria-label="Filter channels"
          placeholder="Filter channels…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Group</th>
              <th>Raw value</th>
              <th>Value</th>
              <th>Unit</th>
              <th>Quality</th>
              <th>Cal.</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const m = snapshot.measurements[c.id]
              const displayed = c.id === 'abs_pressure' ? snapshot.airspeedAtmosphere : m
              const held =
                c.id === 'abs_pressure' && displayed && displayed.sequence !== m?.sequence
              return (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    <small>{c.id}</small>
                  </td>
                  <td>{c.group}</td>
                  <td className="numeric">{m?.rawSpecial ?? format(m?.raw, 3)}</td>
                  <td className="numeric">
                    {c.id === 'abs_pressure'
                      ? format(displayed?.value, 3)
                      : (m?.rawSpecial ?? format(m?.value, 3))}
                    {held && (
                      <small>
                        held {((snapshot.at - displayed.receivedAt) / 1000).toFixed(1)} s
                      </small>
                    )}
                  </td>
                  <td>{m?.unit ?? c.unit}</td>
                  <td>
                    <QualityBadge quality={held ? 'held' : (displayed?.quality ?? 'missing')} />
                  </td>
                  <td>v{m?.calibrationVersion ?? 0}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!channels.length && <p className="panel-note">No channels match this filter.</p>}
      </div>
    </Panel>
  )
}
