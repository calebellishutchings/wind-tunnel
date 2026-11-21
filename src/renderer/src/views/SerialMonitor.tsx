import { useState } from 'react'
import type { Snapshot } from '../../../shared/model'
import { Panel } from '../components/ui'

export function SerialMonitor({ snapshot }: { snapshot: Snapshot }) {
  const [view, setView] = useState<'text' | 'hex'>('text')
  return (
    <Panel
      title="Raw serial monitor"
      subtitle="Latest 80 chunks · newest first · previews limited to 512 bytes; recording retains complete chunks"
      action={
        <select
          aria-label="Serial monitor format"
          value={view}
          onChange={(e) => setView(e.target.value as 'text' | 'hex')}
        >
          <option value="text">Text</option>
          <option value="hex">Hex</option>
        </select>
      }
    >
      <div className="serial-monitor" aria-label="Raw serial output">
        {snapshot.daq.wireLog.length === 0 ? (
          <p className="panel-note">Connect a DAQ to display actual received bytes here.</p>
        ) : (
          [...snapshot.daq.wireLog].reverse().map((entry) => (
            <div className={`serial-entry ${entry.direction}`} key={entry.id}>
              <div>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <strong>{entry.direction.toUpperCase()}</strong>
                <span>
                  {entry.bytes} bytes{entry.truncated ? ' · preview truncated' : ''}
                </span>
              </div>
              <pre>{view === 'text' ? entry.text : entry.hex}</pre>
            </div>
          ))
        )}
      </div>
    </Panel>
  )
}
