import type { OperatorSettings, PitotTarget } from '../../../shared/operator'
import type { Action, Snapshot } from '../../../shared/model'
import { fanMillivolts } from '../../../domain/fan'
import { Panel } from '../components/ui'
import { PITOT_LIMITS_MM, type PitotAction } from '../../../shared/pitot'

export function SpeedDial({
  settings,
  onChange,
  snapshot,
  act,
  pending,
}: {
  settings: OperatorSettings
  onChange: (percent: number) => void
  snapshot: Snapshot
  act: (action: Action) => unknown
  pending: boolean
}) {
  const max = 100
  const value = settings.requestedPercent
  const connected = snapshot.daq.state === 'connected'
  const fan = snapshot.fan
  const controlsDisabled =
    pending ||
    snapshot.disconnecting ||
    !connected ||
    snapshot.emergencyStopped ||
    fan.status !== 'confirmed'
  const angle = -130 + (value / max) * 260
  const select = (event: React.PointerEvent<SVGSVGElement>) => {
    if (controlsDisabled) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * 240 - 120
    const y = ((event.clientY - box.top) / box.height) * 210 - 110
    const a = Math.max(-130, Math.min(130, (Math.atan2(x, -y) * 180) / Math.PI))
    const displayed = ((a + 130) / 260) * max
    onChange(Math.round(displayed * 10) / 10)
  }
  return (
    <Panel title="Fan output" subtitle="Manual reference · 0–100% = 0–3.000 V DAC">
      <fieldset
        className="fan-adjustments"
        disabled={controlsDisabled}
        aria-label="Fan adjustments"
      >
        <svg
          className="speed-dial"
          viewBox="0 0 240 210"
          aria-label="Fan percentage dial"
          aria-disabled={controlsDisabled}
          onPointerDown={(e) => {
            if (controlsDisabled) return
            e.currentTarget.setPointerCapture(e.pointerId)
            select(e)
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) select(e)
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        >
          <circle cx="120" cy="110" r="80" className="dial-track" />
          {Array.from({ length: 11 }, (_, i) => {
            const a = ((-130 + (i * 260) / 10) * Math.PI) / 180
            return (
              <g key={i}>
                <line
                  x1={120 + Math.sin(a) * 71}
                  x2={120 + Math.sin(a) * 80}
                  y1={110 - Math.cos(a) * 71}
                  y2={110 - Math.cos(a) * 80}
                />
                <text x={120 + Math.sin(a) * 97} y={114 - Math.cos(a) * 97} textAnchor="middle">
                  {i * 10}
                </text>
              </g>
            )
          })}
          <circle cx="120" cy="110" r="59" className="dial-face" />
          <g transform={`rotate(${angle} 120 110)`}>
            <line className="dial-needle" x1="120" y1="110" x2="120" y2="58" />
          </g>
          <circle cx="120" cy="110" r="6" className="dial-hub" />
          <text className="dial-readout" x="120" y="183" textAnchor="middle">
            {value.toFixed(1)} %
          </text>
        </svg>
        <input
          className="dial-slider"
          aria-label="Fan percentage"
          type="range"
          min="0"
          max={max}
          step="0.1"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <label className="field inline-field">
          Requested output (%)
          <input
            aria-label="Fan percentage value"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(Math.max(0, Math.min(100, n)))
            }}
          />
        </label>
        <p className="preview-label">
          Requested DAC: {(fanMillivolts(value) / 1000).toFixed(3)} V · click Apply to send
        </p>
      </fieldset>
      <div className="button-pair">
        <button
          className="primary"
          disabled={controlsDisabled}
          onClick={() => act({ type: 'fan-output', percent: value })}
        >
          Apply {value.toFixed(1)}%
        </button>
        <button
          className="stop-button"
          disabled={!connected}
          onClick={() => {
            onChange(0)
            act({ type: 'fan-output', percent: 0 })
          }}
        >
          Stop fan (0%)
        </button>
      </div>
      <div className="detail-line">
        <span>Board-confirmed DAC</span>
        <strong data-testid="fan-confirmed">
          {fan.status === 'confirmed' && fan.confirmedMillivolts !== null
            ? `${(fan.confirmedMillivolts / 30).toFixed(1)}% · ${(fan.confirmedMillivolts / 1000).toFixed(3)} V`
            : fan.status}
        </strong>
      </div>
      {fan.error && <p className="help-text">{fan.error}</p>}
      <p className="help-text">
        Voltage before the amplifier; 100% is nominally 9 V at the VFD input. This is not a
        calibrated airspeed. Use the VFD's normal Run/Stop controls.
      </p>
      <p className="help-text">Physically tested: 0–5%. Higher settings await commissioning.</p>
    </Panel>
  )
}

export function PitotControls({
  target,
  onChange,
  snapshot,
  act,
  pending,
  compact = false,
}: {
  target: PitotTarget
  onChange: (target: PitotTarget) => void
  snapshot: Snapshot
  act: (action: PitotAction) => unknown
  pending: boolean
  compact?: boolean
}) {
  const pitot = snapshot.pitot
  const busy = pending || ['connecting', 'homing', 'moving'].includes(pitot.status)
  const disabled = busy || snapshot.disconnecting || snapshot.emergencyStopped
  const limit = (axis: 'x' | 'y', n: number) =>
    Math.max(0, Math.min(PITOT_LIMITS_MM[axis], Number.isFinite(n) ? n : 0))
  return (
    <Panel
      title="Pitot controller"
      subtitle={`X horizontal · Y vertical · ${pitot.path ?? 'USB not connected'} · ${pitot.status}`}
    >
      {!compact && (
        <div className="pitot-preview">
          <svg viewBox="0 0 480 250" role="img" aria-label="Pitot requested position preview">
            <defs>
              <pattern
                id="traverse-preview-grid"
                width="24"
                height="24"
                patternUnits="userSpaceOnUse"
              >
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#dfE8ed" strokeWidth="1" />
              </pattern>
            </defs>
            <rect
              x="20"
              y="10"
              width="440"
              height="205"
              fill="url(#traverse-preview-grid)"
              stroke="#c9dbe2"
            />
            <line x1="20" y1="215" x2="460" y2="215" stroke="#7898a5" />
            <line x1="20" y1="10" x2="20" y2="215" stroke="#7898a5" />
            {(() => {
              const x = 20 + (limit('x', target.x) / PITOT_LIMITS_MM.x) * 440,
                y = 215 - (limit('y', target.y) / PITOT_LIMITS_MM.y) * 205
              return (
                <g stroke="#b07d33" strokeWidth="2">
                  <circle cx={x} cy={y} r="7" fill="#fff6e3" />
                  <path d={`M ${x - 12} ${y} h 24 M ${x} ${y - 12} v 24`} />
                  <text x="240" y="244" textAnchor="middle" stroke="none" fill="#8198a6">
                    X 0–{PITOT_LIMITS_MM.x} mm · Y 0–{PITOT_LIMITS_MM.y} mm
                  </text>
                </g>
              )
            })()}
          </svg>
        </div>
      )}
      <div className="coordinate-fields">
        <label className="field">
          X target (mm)
          <input
            aria-label="Pitot X target"
            type="number"
            min="0"
            max={PITOT_LIMITS_MM.x}
            step="0.5"
            disabled={disabled}
            value={target.x}
            onChange={(e) => onChange({ ...target, x: limit('x', Number(e.target.value)) })}
          />
        </label>
        <label className="field">
          Y target (mm)
          <input
            aria-label="Pitot Y target"
            type="number"
            min="0"
            max={PITOT_LIMITS_MM.y}
            step="0.5"
            disabled={disabled}
            value={target.y}
            onChange={(e) => onChange({ ...target, y: limit('y', Number(e.target.value)) })}
          />
        </label>
      </div>
      <div className="pitot-jog">
        {[
          ['X −', -0.5, 0],
          ['Y +', 0, 0.5],
          ['Y −', 0, -0.5],
          ['X +', 0.5, 0],
        ].map(([label, dx, dy]) => (
          <button
            key={label}
            disabled={disabled}
            onClick={() =>
              onChange({
                x: limit('x', target.x + Number(dx)),
                y: limit('y', target.y + Number(dy)),
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <div className="button-pair">
        <button
          disabled={disabled || pitot.status !== 'ready'}
          onClick={() => {
            onChange({ x: 0, y: 0 })
            void act({ type: 'home' })
          }}
        >
          Home Pitot
        </button>
        <button
          disabled={disabled || !pitot.homed || pitot.status !== 'ready'}
          onClick={() => void act({ type: 'move', ...target })}
        >
          Move Pitot
        </button>
      </div>
      <div className="button-pair">
        {!pitot.path || pitot.status === 'disconnected' ? (
          <button disabled={disabled} onClick={() => void act({ type: 'connect' })}>
            Connect and home Pitot
          </button>
        ) : (
          <button
            disabled={busy && pitot.status !== 'fault'}
            onClick={() => void act({ type: 'disconnect' })}
          >
            Disconnect Pitot
          </button>
        )}
        <button
          className="danger"
          disabled={!pitot.path || pitot.status === 'disconnected'}
          onClick={() => void act({ type: 'stop' })}
        >
          Stop Pitot
        </button>
      </div>
      {pitot.error && (
        <p className="help-text" role="status">
          {pitot.error}
        </p>
      )}
      <p className="help-text">
        Marlin position:{' '}
        {pitot.position
          ? `${pitot.position.x.toFixed(2)} / ${pitot.position.y.toFixed(2)} mm`
          : 'unavailable'}{' '}
        · {pitot.homed ? 'homed' : 'homing required'}. Open-loop position, not an encoder
        measurement.
      </p>
      <p className="help-text">
        Connect automatically homes both axes at native controller speed. Keep both paths clear.
        Targets and arrows edit locally; Move sends the target. X and Y are each limited to 0–360 mm
        while the larger rail is verified. Travel slows within 5 mm of either end. Homing stays
        valid while connected, including across tabs and idle time.
      </p>
      {!compact && (
        <details>
          <summary>Pitot serial transcript</summary>
          <pre className="pitot-transcript">
            {pitot.transcript
              .map((row) => `${row.direction.toUpperCase()} ${row.text}`)
              .join('\n') || 'No serial traffic'}
          </pre>
        </details>
      )}
    </Panel>
  )
}
