import { Check } from 'lucide-react'
import type { Snapshot } from '../../../shared/model'
import { Panel } from '../components/ui'

export function Sessions({ snapshot: s }: { snapshot: Snapshot }) {
  return (
    <>
      <div className="two-columns">
        <Panel title="Append-only run log" subtitle="Streaming JSONL · schema version 1">
          <div className="session-status">
            <span className={s.recording.active ? 'record-dot' : 'muted-dot'} />
            {s.recording.active ? `Recording ${s.mode} measurements` : 'Ready to record'}
          </div>
          <div className="big-stat">
            {s.recording.rows.toLocaleString()} <span>channel samples</span>
          </div>
          <p className="file-path">
            {s.recording.path ?? 'Choose a destination with Record session.'}
          </p>
          <p className="help-text">
            Records transport bytes, original values, calibrated values, device microseconds, host
            arrival time, quality, calibration versions, and diagnostics. Nonfinite raw values
            retain their NaN / Infinity identity.
          </p>
          <p className="help-text">
            Stop recording before CSV export. New recordings use new files so earlier runs cannot be
            overwritten.
          </p>
        </Panel>
        <Panel title="Data conventions" subtitle="Designed for reproducible analysis">
          <ul className="convention-list">
            <li>
              <Check size={16} />
              Every exported row contains board data with a hardware source label.
            </li>
            <li>
              <Check size={16} />
              One row per channel sample, with explicit units.
            </li>
            <li>
              <Check size={16} />
              Bank timestamps are preserved independently.
            </li>
            <li>
              <Check size={16} />
              Calibration changes affect future samples.
            </li>
            <li>
              <Check size={16} />
              Recording continues when changing views.
            </li>
          </ul>
          <p className="help-text">
            Session browsing, playback, experiment grids, and synchronized spatial sampling are
            planned integration work.
          </p>
        </Panel>
      </div>
      <Diagnostics snapshot={s} />
    </>
  )
}
function Diagnostics({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Panel
      title="Session diagnostics"
      subtitle="Latest 100 events · device debug, warnings, and errors remain visible"
    >
      <div className="diagnostics">
        {[...snapshot.diagnostics].reverse().map((d) => (
          <div className={`diagnostic ${d.level}`} key={d.id}>
            <time>{new Date(d.at).toLocaleTimeString()}</time>
            <span>{d.level.toUpperCase()}</span>
            <p>{d.message}</p>
          </div>
        ))}
      </div>
    </Panel>
  )
}
