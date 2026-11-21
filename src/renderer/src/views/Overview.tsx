import { CHANNELS, type Action, type Snapshot } from '../../../shared/model'
import type { OperatorSettings } from '../../../shared/operator'
import { snapshotAirspeed, airspeedStatus, speedIn } from '../../../domain/measurements'
import { Panel, format } from '../components/ui'
import { MultiTrendChart } from '../MultiTrendChart'
import type { TrendPoint } from '../TrendChart'
import { SpeedDial, PitotControls } from './OperatorControls'
import { AcquisitionPanel } from './AcquisitionPanel'
import type { PitotAction } from '../../../shared/pitot'

export function Overview({
  snapshot: s,
  settings,
  onSettings,
  act,
  pending,
  speedHistory,
  onOpenPitot,
  pitotAct,
  pitotPending,
}: {
  snapshot: Snapshot
  settings: OperatorSettings
  onSettings: (next: OperatorSettings) => void
  act: (action: Action) => unknown
  pending: boolean
  speedHistory: Record<'pitot' | 'ring', TrendPoint[]>
  onOpenPitot: () => void
  pitotAct: (action: PitotAction) => unknown
  pitotPending: boolean
}) {
  const differential = CHANNELS.filter((c) => c.unit === 'Pa')
  return (
    <>
      <div className="operator-heading">
        <div>
          <h2>Live wind speed</h2>
          <p>
            Pressure-derived estimates · Bernoulli · manually entered room temperature{' '}
            {s.roomTemperatureC.toFixed(1)} °C
          </p>
        </div>
        <label>
          Display unit{' '}
          <select
            aria-label="Wind speed unit"
            value={settings.unit}
            onChange={(e) =>
              onSettings({ ...settings, unit: e.target.value as OperatorSettings['unit'] })
            }
          >
            <option value="mph">mph</option>
            <option value="m/s">m/s</option>
          </select>
        </label>
      </div>
      <div className="speed-station">
        {(['ring', 'pitot'] as const).map((kind) => {
          const id = settings.sources[kind],
            pressure = s.measurements[id]
          const result = snapshotAirspeed(s, id)
          return (
            <Panel
              key={kind}
              title={kind === 'ring' ? 'Central ring airspeed' : 'Pitot airspeed'}
              subtitle={`${id} · pressure in Pa · mapping to verify`}
            >
              <div className={`airspeed-value ${kind}`} data-testid={`${kind}-airspeed`}>
                {format(result ? speedIn(result.speed, settings.unit) : null)}{' '}
                <span>{settings.unit}</span>
              </div>
              <div className="speed-meter">
                <span style={{ width: `${Math.min(100, ((result?.speed ?? 0) / 32) * 100)}%` }} />
              </div>
              <div className="detail-line">
                <span>Differential pressure</span>
                <strong>{pressure?.rawSpecial ?? format(pressure?.value)} Pa</strong>
              </div>
              <div className="detail-line">
                <span>Air density</span>
                <strong>{format(result?.density, 3)} kg/m³</strong>
              </div>
              <p className="help-text">{airspeedStatus(s, id)}</p>
            </Panel>
          )
        })}
        <SpeedDial
          settings={settings}
          onChange={(requestedPercent) => onSettings({ ...settings, requestedPercent })}
          snapshot={s}
          act={act}
          pending={pending}
        />
      </div>
      <div className="lab-main-grid">
        <div className="primary-column">
          <Panel
            title="Pitot and central ring speed history"
            subtitle="Stored display estimates · original pressure samples recorded separately"
          >
            <MultiTrendChart
              unit={settings.unit}
              series={(['pitot', 'ring'] as const).map((kind) => ({
                id: kind,
                label: kind === 'pitot' ? 'Pitot' : 'Central ring',
                color: kind === 'pitot' ? '#087f75' : '#bf8240',
                points: speedHistory[kind].map((point) => ({
                  ...point,
                  value: point.value === null ? null : speedIn(point.value, settings.unit),
                })),
              }))}
            />
          </Panel>
          <Panel
            title="Pressure source mapping"
            subtitle="Archived defaults: Pitot = differential 1; central ring = differential 2. Verify the actual tubing."
          >
            <div className="mapping-fields">
              {(['pitot', 'ring'] as const).map((kind) => (
                <label className="field" key={kind}>
                  {kind === 'pitot' ? 'Pitot pressure source' : 'Central ring pressure source'}
                  <select
                    aria-label={`${kind} pressure source`}
                    value={settings.sources[kind]}
                    onChange={(e) =>
                      onSettings({
                        ...settings,
                        sources: { ...settings.sources, [kind]: e.target.value },
                      })
                    }
                  >
                    {differential.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.id})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="help-text">
              v = √(2 Δp / ρ), ρ = Pabs / [287.05 × (T + 273.15)]. Both estimates use the selected
              pressure input without an unverified static-ring area correction. Invalid or stale
              differential inputs produce a blank speed. Differential pressures from −3 Pa to 0 Pa
              are treated as zero for airspeed; values below −3 Pa remain flagged. Density may use
              the last valid measured atmospheric pressure for up to 2 seconds, with its age shown
              in Data acquisition.
            </p>
          </Panel>
        </div>
        <div className="secondary-column">
          <AcquisitionPanel snapshot={s} act={act} pending={pending} />
          <PitotControls
            snapshot={s}
            act={pitotAct}
            pending={pitotPending}
            target={settings.target}
            onChange={(target) => onSettings({ ...settings, target })}
            compact
          />
          <button className="text-button" onClick={onOpenPitot}>
            Open full Pitot panel →
          </button>
        </div>
      </div>
    </>
  )
}
