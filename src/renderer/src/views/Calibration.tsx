import { useState } from 'react'
import { Check, Info } from 'lucide-react'
import {
  CHANNELS,
  allowedCalibrationUnits,
  type Action,
  type Snapshot,
} from '../../../shared/model'
import { fitCalibration } from '../../../domain/measurements'
import { Panel, QualityBadge, format } from '../components/ui'

export function CalibrationPage({
  snapshot,
  act,
  pending,
  reportError,
}: {
  snapshot: Snapshot
  act: (action: Action) => unknown
  pending: boolean
  reportError: (message: string) => void
}) {
  const [channelId, setChannelId] = useState('strain2')
  const [unit, setUnit] = useState('N')
  const [pointsText, setPointsText] = useState('')
  const measurement = snapshot.measurements[channelId]
  const calibration = snapshot.calibrations[channelId]
  const files = async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await operation().catch((error: unknown) => ({
      ok: false,
      error: String(error),
    }))
    if (!result.ok) reportError(result.error ?? 'Calibration file operation failed')
  }
  const save = () => {
    try {
      const points = pointsText
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const parts = line.split(',').map((part) => part.trim())
          if (
            parts.length !== 2 ||
            parts.some((part) => part === '' || !Number.isFinite(Number(part)))
          )
            throw new Error('Enter one raw,reference pair per line, with two finite numbers.')
          return { raw: Number(parts[0]), reference: Number(parts[1]) }
        })
      fitCalibration(points)
      act({ type: 'calibrate', channelId, unit, points })
    } catch (e) {
      reportError(String(e))
    }
  }
  return (
    <>
      <div className="calibration-file-actions">
        <p>
          Calibration is saved in this browser. Import the Electron app's hardware-calibrations.json
          to carry existing settings over.
        </p>
        <button
          disabled={pending || snapshot.daq.state !== 'disconnected'}
          onClick={() => void files(() => window.tunnel.importCalibrations())}
        >
          Import calibration JSON
        </button>
        <button
          disabled={pending}
          onClick={() => void files(() => window.tunnel.exportCalibrations())}
        >
          Export calibration JSON
        </button>
      </div>
      <div className="two-columns">
        <Panel
          title="Linear calibration"
          subtitle="Reference = raw × scale + offset. Changes apply to future samples."
        >
          <label className="field">
            Channel
            <select
              value={channelId}
              aria-label="Calibration channel"
              onChange={(e) => {
                const c = CHANNELS.find((c) => c.id === e.target.value)!
                setChannelId(c.id)
                setUnit(c.group === 'Bridge' ? 'N' : c.unit)
                setPointsText('')
              }}
            >
              {CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.id})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Reference unit
            <select
              aria-label="Reference unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            >
              {allowedCalibrationUnits(channelId).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Calibration pairs (raw, reference)
            <textarea
              aria-label="Calibration points"
              rows={7}
              value={pointsText}
              placeholder={'1000, 0\n2000, 9.81'}
              onChange={(e) => setPointsText(e.target.value)}
            />
          </label>
          <p className="help-text">
            Use two or more measured pairs. For force in N, convert calibration mass in kg with mass
            × 9.81 before entering the reference.
          </p>
          <button
            className="primary"
            disabled={pending || snapshot.daq.state !== 'connected' || !pointsText.trim()}
            onClick={save}
          >
            <Check size={16} />
            Fit and save calibration
          </button>
        </Panel>
        <div className="secondary-column">
          <Panel
            title="Current calibration"
            subtitle={`${channelId} · version ${calibration?.version ?? 0}`}
          >
            <div className="calibration-equation">
              y = {format(calibration?.scale ?? 1, 5)} x + {format(calibration?.offset ?? 0, 5)}
            </div>
            <div className="detail-line">
              <span>Latest raw</span>
              <strong>{format(measurement?.raw, 4)}</strong>
            </div>
            <div className="detail-line">
              <span>Latest value</span>
              <strong>
                {format(measurement?.value, 4)} {measurement?.unit ?? 'raw'}
              </strong>
            </div>
            <div className="detail-line">
              <span>Quality</span>
              <QualityBadge quality={measurement?.quality ?? 'missing'} />
            </div>
            <div className="button-pair">
              <button
                disabled={
                  pending || snapshot.daq.state !== 'connected' || measurement?.quality !== 'good'
                }
                onClick={() => act({ type: 'tare', channelId })}
              >
                Tare current reading
              </button>
              <button
                disabled={pending || snapshot.daq.state !== 'connected'}
                onClick={() => act({ type: 'reset-calibration', channelId })}
              >
                Reset to raw
              </button>
            </div>
            <p className="help-text">
              Tare uses one fresh reading. It never runs automatically at startup.
            </p>
          </Panel>
          <div className="info-card">
            <Info size={18} />
            <p>
              Calibration is saved locally for future board readings. Archived LabVIEW values
              require physical verification.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
