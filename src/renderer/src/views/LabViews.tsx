import { useState } from 'react'
import { CHANNELS, type Snapshot } from '../../../shared/model'
import type { OperatorSettings } from '../../../shared/operator'
import type { TrendPoint } from '../TrendChart'
import { snapshotAirspeed, airspeedStatus, speedIn } from '../../../domain/measurements'
import { Panel, format } from '../components/ui'
import { PitotControls } from './OperatorControls'
import { SensorPlots } from './SensorPlots'
import type { PitotAction } from '../../../shared/pitot'
export function PitotPage({
  snapshot: s,
  settings,
  onSettings,
  history,
  pitotAct,
  pitotPending,
}: {
  snapshot: Snapshot
  settings: OperatorSettings
  onSettings: (s: OperatorSettings) => void
  history: Record<string, TrendPoint[]>
  pitotAct: (action: PitotAction) => unknown
  pitotPending: boolean
}) {
  const result = snapshotAirspeed(s, settings.sources.pitot)
  return (
    <>
      <div className="two-columns">
        <PitotControls
          snapshot={s}
          act={pitotAct}
          pending={pitotPending}
          target={settings.target}
          onChange={(target) => onSettings({ ...settings, target })}
        />
        <Panel
          title="Pitot measurement"
          subtitle={`Source ${settings.sources.pitot} · verify physical tubing`}
        >
          <div className="airspeed-value">
            {format(result ? speedIn(result.speed, settings.unit) : null)}{' '}
            <span>{settings.unit}</span>
          </div>
          <p className="panel-note">
            Marlin position is shown after the controller completes its move. There is no encoder
            feedback; verify the physical probe and tubing remain clear.
          </p>
          <p className="help-text">{airspeedStatus(s, settings.sources.pitot)}</p>
          <div className="detail-line">
            <span>Current pressure</span>
            <strong>
              {s.measurements[settings.sources.pitot]?.rawSpecial ??
                format(s.measurements[settings.sources.pitot]?.value)}{' '}
              Pa
            </strong>
          </div>
        </Panel>
      </div>
      <SensorPlots
        key={settings.sources.pitot}
        channels={CHANNELS.filter((c) => c.id === settings.sources.pitot)}
        history={history}
        snapshot={s}
        initiallyAll
        title="Raw Pitot pressure"
      />
    </>
  )
}
export function ForceBalancePage({
  snapshot: s,
  history,
}: {
  snapshot: Snapshot
  history: Record<string, TrendPoint[]>
}) {
  const [normal, setNormal] = useState('strain2'),
    [axial, setAxial] = useState('strain3')
  return (
    <>
      <div className="two-columns">
        {[
          { name: 'Normal', id: normal, set: setNormal },
          { name: 'Axial', id: axial, set: setAxial },
        ].map((axis) => {
          const m = s.measurements[axis.id]
          return (
            <Panel
              key={axis.name}
              title={`${axis.name} force`}
              subtitle="Axis assignment requires a directional-load test"
            >
              <label className="field">
                Bridge channel
                <select
                  aria-label={`${axis.name} force source`}
                  value={axis.id}
                  onChange={(e) => axis.set(e.target.value)}
                >
                  {CHANNELS.filter((c) => c.bank === 2).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="airspeed-value">
                {format(m?.quality === 'good' && m.unit === 'N' ? m.value : null)} <span>N</span>
              </div>
              <p className="help-text">
                Raw: {format(m?.raw, 1)} counts. Apply a valid N calibration in Calibration before
                using this force reading. Archived source and manual disagree about normal/axial
                wiring.
              </p>
            </Panel>
          )
        })}
      </div>
      <SensorPlots
        channels={CHANNELS.filter((c) => c.bank === 2)}
        history={history}
        snapshot={s}
        initiallyAll
        title="Raw bridge readings"
      />
    </>
  )
}
