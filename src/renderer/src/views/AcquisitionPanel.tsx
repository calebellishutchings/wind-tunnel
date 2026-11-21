import { useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { Action, Snapshot } from '../../../shared/model'
import { Panel } from '../components/ui'
export function AcquisitionPanel({
  snapshot: s,
  act,
  pending,
}: {
  snapshot: Snapshot
  act: (action: Action) => unknown
  pending: boolean
}) {
  const [period, setPeriod] = useState(s.samplePeriodMs)
  const [temperature, setTemperature] = useState(s.roomTemperatureC)
  const running = s.acquisition === 'running'
  const blocked = pending || s.emergencyStopped || s.daq.state !== 'connected'
  return (
    <Panel
      title="Data acquisition"
      subtitle={
        s.emergencyStopped
          ? 'Outgoing commands blocked'
          : `${s.daq.state} · ${s.frameCount.toLocaleString()} bank frames`
      }
    >
      <label className="field">
        Requested sample period
        <select
          aria-label="Sample period"
          value={period}
          disabled={running || blocked}
          onChange={(e) => setPeriod(Number(e.target.value))}
        >
          <option value="100">100 ms · 10 Hz</option>
          <option value="200">200 ms · 5 Hz</option>
          <option value="500">500 ms · 2 Hz</option>
          <option value="1000">1 s · 1 Hz</option>
        </select>
      </label>
      <button
        className={running ? 'full stop-button' : 'primary full'}
        disabled={blocked}
        onClick={() => act({ type: 'acquisition', running: !running, periodMs: period })}
      >
        {running ? <Square size={15} /> : <Play size={15} />}{' '}
        {running ? 'Stop acquisition' : 'Start acquisition'}
      </button>
      <label className="field inline-field">
        Room temperature
        <span>
          <input
            aria-label="Room temperature"
            type="number"
            min="-20"
            max="60"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />{' '}
          °C
        </span>
      </label>
      <button
        className="text-button temperature-apply"
        disabled={blocked || temperature === s.roomTemperatureC}
        onClick={() => act({ type: 'temperature', celsius: temperature })}
      >
        Apply temperature
      </button>
      <div className="detail-line">
        <span>Atmospheric pressure</span>
        <strong data-testid="atmospheric-pressure">
          {s.airspeedAtmosphere
            ? `${s.airspeedAtmosphere.value?.toFixed(3)} kPa`
            : 'Unavailable (no valid sample within 2 s)'}
        </strong>
      </div>
      <p className="help-text">
        Density input:{' '}
        {s.airspeedAtmosphere
          ? `${s.airspeedAtmosphere.value?.toFixed(3)} kPa · ${((s.at - s.airspeedAtmosphere.receivedAt) / 1000).toFixed(1)} s old`
          : 'No valid sample within 2 s'}
        . Latest raw input:{' '}
        {s.measurements.abs_pressure?.rawSpecial ??
          s.measurements.abs_pressure?.raw?.toFixed(3) ??
          'unavailable'}
        . Original values are preserved in raw graphs and recordings.
      </p>
    </Panel>
  )
}
