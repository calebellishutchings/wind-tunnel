import { useCallback, useEffect, useState, useRef } from 'react'
import {
  Activity,
  ArrowDownToLine,
  Circle,
  Check,
  Database,
  Gauge,
  Grid2X2,
  Info,
  Plug,
  SlidersHorizontal,
  Square,
  Wind,
  Compass,
  Layers,
  Octagon,
} from 'lucide-react'
import type { Action, Result, Snapshot } from '../../shared/model'
import type { TrendPoint } from './TrendChart'
import { Panel } from './components/ui'
import { PressureGrid, ChannelTable } from './views/Measurements'
import { Overview } from './views/Overview'
import { CalibrationPage } from './views/Calibration'
import { Hardware } from './views/Hardware'
import { Sessions } from './views/Sessions'
import { SensorPlots } from './views/SensorPlots'
import { PitotPage, ForceBalancePage } from './views/LabViews'
import { CHANNELS } from '../../shared/model'
import type { OperatorSettings } from '../../shared/operator'
import { snapshotAirspeed } from '../../domain/measurements'
import type { PitotAction } from '../../shared/pitot'

type Page =
  | 'Main'
  | 'Pitot'
  | 'Force Balance'
  | 'Pressure graphs'
  | 'Data Viewer'
  | 'Pressure array'
  | 'Calibration'
  | 'Sessions'
  | 'Hardware'
const navigation: { name: Page; icon: typeof Activity; section?: string }[] = [
  { name: 'Main', icon: Gauge, section: 'WORKSPACE' },
  { name: 'Pitot', icon: Compass },
  { name: 'Force Balance', icon: Layers },
  { name: 'Pressure graphs', icon: Activity },
  { name: 'Data Viewer', icon: Activity },
  { name: 'Pressure array', icon: Grid2X2 },
  { name: 'Calibration', icon: SlidersHorizontal, section: 'CONFIGURATION' },
  { name: 'Sessions', icon: Database },
  { name: 'Hardware', icon: Plug },
]
const titles: Record<Page, string> = {
  Main: 'Wind tunnel control',
  Pitot: 'Pitot controller',
  'Force Balance': 'Force balance',
  'Pressure graphs': 'Raw pressure readings',
  'Data Viewer': 'Data viewer',
  'Pressure array': 'Surface pressure array',
  Calibration: 'Channel calibration',
  Sessions: 'Session recording',
  Hardware: 'Hardware integration',
}
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [startupError, setStartupError] = useState('')
  const [page, setPage] = useState<Page>('Main')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [pitotPending, setPitotPending] = useState(false)
  const [history, setHistory] = useState<Record<string, TrendPoint[]>>({})
  const [settings, setSettings] = useState<OperatorSettings>({
    sources: { pitot: 'press1', ring: 'press2' },
    unit: 'mph',
    requestedPercent: 0,
    target: { x: 0, y: 0 },
  })
  const sourcesRef = useRef(settings.sources)
  const speedSeq = useRef<Record<string, number>>({})
  const [speedHistory, setSpeedHistory] = useState<Record<'pitot' | 'ring', TrendPoint[]>>({
    pitot: [],
    ring: [],
  })
  const onSettings = (next: OperatorSettings) => {
    if (
      next.sources.pitot !== sourcesRef.current.pitot ||
      next.sources.ring !== sourcesRef.current.ring
    ) {
      setSpeedHistory({ pitot: [], ring: [] })
      speedSeq.current = {}
    }
    sourcesRef.current = next.sources
    setSettings(next)
  }

  useEffect(() => {
    let active = true
    let sourceVersion = -1
    const update = (next: Snapshot) => {
      if (!active) return
      if (sourceVersion !== next.sourceVersion) {
        setSettings((old) => ({ ...old, requestedPercent: 0 }))
        setHistory({})
        setSpeedHistory({ pitot: [], ring: [] })
        speedSeq.current = {}
        sourceVersion = next.sourceVersion
      }
      if (next.emergencyStopped)
        setSettings((old) => (old.requestedPercent === 0 ? old : { ...old, requestedPercent: 0 }))
      setSnapshot(next)
      const added: Partial<Record<'pitot' | 'ring', TrendPoint>> = {}
      for (const kind of ['pitot', 'ring'] as const) {
        const measurement = next.measurements[sourcesRef.current[kind]]
        if (measurement && measurement.sequence !== speedSeq.current[kind]) {
          speedSeq.current[kind] = measurement.sequence
          added[kind] = {
            at: measurement.receivedAt,
            value: snapshotAirspeed(next, measurement.channelId)?.speed ?? null,
          }
        }
      }
      setSpeedHistory((old) => ({
        pitot: added.pitot ? [...old.pitot.slice(-119), added.pitot] : old.pitot,
        ring: added.ring ? [...old.ring.slice(-119), added.ring] : old.ring,
      }))
      setHistory((old) => {
        const changed = { ...old }
        for (const [id, measurement] of Object.entries(next.measurements)) {
          const points = old[id] ?? []
          if (points.at(-1)?.at === measurement.receivedAt) continue
          changed[id] = [
            ...points.slice(-119),
            {
              at: measurement.receivedAt,
              value: measurement.quality === 'stale' ? null : measurement.raw,
            },
          ]
        }
        return changed
      })
    }
    const unsubscribe = window.tunnel.subscribe(update)
    void window.tunnel
      .snapshot()
      .then(update)
      .catch((e: unknown) => setStartupError(String(e)))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const run = useCallback(
    async <T,>(operation: () => Promise<Result<T>>, success?: string): Promise<T | undefined> => {
      setPending(true)
      setError('')
      setNotice('')
      try {
        const result = await operation()
        if (!result.ok) {
          setError(result.error)
          return undefined
        }
        if (success) setNotice(success)
        return result.value
      } catch (e) {
        setError(String(e))
        return undefined
      } finally {
        setPending(false)
      }
    },
    [],
  )
  const act = (action: Action) => run(() => window.tunnel.act(action))
  const pitotAct = async (action: PitotAction) => {
    setPitotPending(true)
    setError('')
    try {
      const result = await window.tunnel.pitotAct(action)
      if (!result.ok) setError(result.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setPitotPending(false)
    }
  }
  if (!snapshot)
    return (
      <main className="startup">
        <Wind size={42} />
        <h1>ENS Wind Tunnel</h1>
        <p>{startupError || 'Connecting to the local acquisition service…'}</p>
      </main>
    )
  const s = snapshot
  const running = s.acquisition === 'running'
  const startRecord = async () => {
    const path = await run(() => window.tunnel.startRecording())
    if (path) setNotice(`Recording ${s.mode} data to ${path}`)
  }
  const exportCsv = async () => {
    const path = await run(() => window.tunnel.exportCsv())
    if (path) setNotice('CSV saved to ' + path)
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Wind size={26} />
          </div>
          <div>
            <strong>ENS</strong>
            <span>WIND TUNNEL</span>
          </div>
        </div>
        <div className="lab-label">
          <span className="status-dot" /> ACQUISITION CONSOLE <span>01</span>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map(({ name, icon: Icon, section }) => (
            <div key={name}>
              {section && <div className="nav-section">{section}</div>}
              <button
                className={`nav-item ${page === name ? 'active' : ''}`}
                onClick={() => setPage(name)}
              >
                <Icon size={18} />
                {name}
                {page === name && <span className="nav-active-dot" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="device-icon">
            <Plug size={19} />
          </div>
          <strong>{s.daq.state === 'connected' ? 'DAQ connected' : 'Waiting for DAQ'}</strong>
          <p>
            {s.daq.path ?? 'Select a board in Hardware'} · {s.daq.state}
          </p>
          <div className="version">
            DESKTOP APP <span>v0.6.2</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <span>
            ENS LAB <span className="slash">/</span> {page}
          </span>
          <div>
            <span className="local-indicator" /> Local session <span className="top-separator" />{' '}
            <span className="protocol-pill">
              <Plug size={12} /> BINARY DAQ
            </span>
          </div>
        </div>
        <main className="workspace">
          <header className="page-heading">
            <div>
              <div className="eyebrow">WIND TUNNEL INSTRUMENTATION</div>
              <h1>{titles[page]}</h1>
              <p>Acquire, inspect, and record your experiment.</p>
            </div>
            <div className="header-actions">
              <button
                className="emergency-button"
                aria-label="Emergency Stop"
                onClick={() => void act({ type: 'emergency-stop' })}
              >
                <Octagon size={20} />
                EMERGENCY STOP
              </button>
              {s.emergencyStopped && (
                <button disabled={pending} onClick={() => void act({ type: 'emergency-reset' })}>
                  Reset command block
                </button>
              )}
              <button
                disabled={pending || s.recording.active || !s.recording.path || !!s.recording.error}
                onClick={() => void exportCsv()}
              >
                <ArrowDownToLine size={16} />
                Export CSV
              </button>
              <button
                className={s.recording.active ? 'recording-button' : 'primary'}
                disabled={pending || (!s.recording.active && s.daq.state !== 'connected')}
                onClick={() =>
                  void (s.recording.active
                    ? run(
                        () => window.tunnel.stopRecording(),
                        'Run log finalized. Ready to export CSV.',
                      )
                    : startRecord())
                }
              >
                {s.recording.active ? <Square size={14} /> : <Circle size={14} />}
                {s.recording.active ? 'Stop recording' : 'Record session'}
              </button>
            </div>
          </header>
          <div className="connection-banner">
            <Plug size={17} />
            <span>
              <strong>
                {s.daq.state === 'connected' ? `Live DAQ · ${s.daq.path}` : 'DAQ disconnected'}
              </strong>
              {s.daq.state === 'connected'
                ? `${s.daq.baudRate} baud / 8N1 · binary measurements · manual fan reference available.`
                : 'Connect the board in Hardware to acquire data. No measurements are generated without a connection.'}
            </span>
            <span className="banner-tag">{s.daq.receivedBytes.toLocaleString()} BYTES RX</span>
          </div>
          {s.emergencyStopped && (
            <div role="alert" className="emergency-banner">
              <strong>EMERGENCY STOP — NONZERO OUTPUT BLOCKED</strong>
              <span>
                DAC zero requested; check the board-confirmed output. Use the physical VFD Stop.
                Incoming measurements may continue. Resetting never restores a previous output.
              </span>
            </div>
          )}
          {error && (
            <div role="alert" className="feedback error">
              <Info size={17} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="feedback success">
              <Check size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Dismiss notice">
                ×
              </button>
            </div>
          )}
          {s.recording.error && (
            <div role="alert" className="feedback error">
              Recording failed: {s.recording.error}
            </div>
          )}

          {page === 'Main' && (
            <Overview
              snapshot={s}
              settings={settings}
              onSettings={onSettings}
              speedHistory={speedHistory}
              act={act}
              pending={pending}
              onOpenPitot={() => setPage('Pitot')}
              pitotAct={pitotAct}
              pitotPending={pitotPending}
            />
          )}
          {page === 'Pitot' && (
            <PitotPage
              snapshot={s}
              settings={settings}
              onSettings={onSettings}
              history={history}
              pitotAct={pitotAct}
              pitotPending={pitotPending}
            />
          )}
          {page === 'Force Balance' && <ForceBalancePage snapshot={s} history={history} />}
          {page === 'Pressure graphs' && (
            <SensorPlots
              channels={CHANNELS.filter(
                (c) => c.group === 'Pressure' || c.group === 'Array' || c.group === 'Atmosphere',
              )}
              history={history}
              snapshot={s}
              title="Raw pressure sensor selection"
            />
          )}
          {page === 'Data Viewer' && (
            <>
              <ChannelTable snapshot={s} />
              <SensorPlots
                channels={CHANNELS}
                history={history}
                snapshot={s}
                title="All raw sensor streams"
              />
            </>
          )}
          {page === 'Pressure array' && (
            <>
              <Panel
                title="Backpack differential pressures"
                subtitle="Three banks of eight taps · physical channel order and polarity await verification"
              >
                <PressureGrid snapshot={s} />
                <p className="panel-note">
                  Zeros are retained as measured. Invalid and stale readings remain visible through
                  their quality flags.
                </p>
              </Panel>
              <SensorPlots
                channels={CHANNELS.filter((c) => c.bank === 6)}
                history={history}
                snapshot={s}
                title="24 pressure array graphs"
                initiallyAll
              />
            </>
          )}
          {page === 'Calibration' && (
            <CalibrationPage
              snapshot={s}
              act={act}
              pending={pending || s.emergencyStopped}
              reportError={setError}
            />
          )}
          {page === 'Sessions' && <Sessions snapshot={s} />}
          {page === 'Hardware' && <Hardware snapshot={s} act={act} pending={pending} run={run} />}
          <footer>
            <span>
              <span className={`status-dot ${running ? '' : 'idle'}`} />
              {s.emergencyStopped
                ? 'Nonzero output blocked · DAC zero remains available'
                : running
                  ? 'DAQ acquisition active'
                  : 'Acquisition idle'}
              <span className="footer-divider">|</span>
              {s.recording.active
                ? `${s.recording.rows.toLocaleString()} samples recorded`
                : 'No active recording'}
            </span>
            <span>
              ENS SYSTEM <span className="footer-divider">/</span> 37 CHANNELS{' '}
              <span className="footer-divider">/</span> BINARY USB DAQ
            </span>
          </footer>
        </main>
      </div>
    </div>
  )
}
