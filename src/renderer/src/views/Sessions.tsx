import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Result, Snapshot } from '../../../shared/model'
import type { SessionSummary } from '../../../shared/storage'
import { Panel } from '../components/ui'

export function Sessions({
  snapshot: s,
  run,
}: {
  snapshot: Snapshot
  run: <T>(operation: () => Promise<Result<T>>, success?: string) => Promise<T | undefined>
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [storageError, setStorageError] = useState('')
  useEffect(() => {
    let active = true
    void window.tunnel.listRecordings().then((result) => {
      if (!active) return
      if (result.ok) setSessions(result.value)
      else setStorageError(result.error)
    })
    return () => {
      active = false
    }
  }, [s.recording.active, s.recording.path, s.disconnecting])
  return (
    <>
      <div className="two-columns">
        <Panel
          title="Append-only run log"
          subtitle="Persistent browser storage · JSONL schema version 1"
        >
          <div className="session-status">
            <span className={s.recording.active ? 'record-dot' : 'muted-dot'} />
            {s.recording.active ? `Recording ${s.mode} measurements` : 'Ready to record'}
          </div>
          <div className="big-stat">
            {s.recording.rows.toLocaleString()} <span>channel samples</span>
          </div>
          <p className="file-path">
            {s.recording.path ?? 'Use Record session to create a new local run.'}
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
          <div className="button-pair">
            <button
              disabled={s.recording.active || !s.recording.path || s.disconnecting}
              onClick={() =>
                void run(() => window.tunnel.saveRecording(null, 'jsonl'), 'Run log saved.')
              }
            >
              Save run log (JSONL)
            </button>
          </div>
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
      <Panel
        title="Saved recordings"
        subtitle="Stored on this computer in this browser profile; export files to keep or share them."
      >
        {storageError && <p role="alert">{storageError}</p>}
        {!sessions.length && <p className="panel-note">No saved runs yet.</p>}
        {sessions.map((session) => {
          const active = s.recording.active && session.name === s.recording.path
          return (
            <div className="saved-run" key={session.id}>
              <div>
                <strong>{session.name}</strong>
                <p>
                  {active ? s.recording.rows.toLocaleString() : session.rows.toLocaleString()}{' '}
                  samples ·{' '}
                  {active
                    ? 'recording'
                    : session.status === 'recording'
                      ? 'unfinalized — recover committed data'
                      : session.status}
                  {session.error && ` · ${session.error}`}
                </p>
              </div>
              <div className="button-pair">
                <button
                  disabled={active || s.disconnecting}
                  onClick={() =>
                    void run(
                      () => window.tunnel.saveRecording(session.id, 'jsonl'),
                      'Run log saved.',
                    )
                  }
                >
                  Save JSONL
                </button>
                <button
                  disabled={active || s.disconnecting}
                  onClick={() =>
                    void run(() => window.tunnel.saveRecording(session.id, 'csv'), 'CSV saved.')
                  }
                >
                  Save CSV
                </button>
              </div>
            </div>
          )
        })}
        <p className="help-text">
          Closing a tab cannot finish USB shutdown. Use Disconnect first. Clearing this site's
          browser data removes local runs and calibration. Previously committed data from an
          interrupted run can be recovered above.
        </p>
      </Panel>
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
