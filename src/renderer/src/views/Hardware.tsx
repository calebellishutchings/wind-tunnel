import { useState, useEffect } from 'react'
import { Plug, CircleDot, Compass } from 'lucide-react'
import type { Action, PortInfo, Result, Snapshot } from '../../../shared/model'
import { Panel } from '../components/ui'
import { SerialMonitor } from './SerialMonitor'
import { isDaqPort, preferredDaqPath } from '../../../shared/daq-device'

export function Hardware({
  snapshot: s,
  act,
  pending,
  run,
}: {
  snapshot: Snapshot
  act: (action: Action) => unknown
  pending: boolean
  run: <T>(operation: () => Promise<Result<T>>, success?: string) => Promise<T | undefined>
}) {
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  const [path, setPath] = useState(s.daq.path ?? '')
  const [baudRate, setBaudRate] = useState(s.daq.baudRate)
  const connected = s.daq.state === 'connected'
  useEffect(() => {
    let active = true
    void window.tunnel
      .listPorts()
      .then((result) => {
        if (!active || !result.ok) return
        setPorts(result.value)
        if (!s.daq.path) setPath(preferredDaqPath(result.value) ?? '')
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [s.daq.path])
  const discover = async () => {
    const result = await run(() => window.tunnel.listPorts())
    if (result) {
      setPorts(result)
      if (!connected) setPath(preferredDaqPath(result) ?? '')
    }
  }
  return (
    <>
      <div className="two-columns">
        <Panel
          title="DAQ connection"
          subtitle="Open the selected board and request sensor measurements"
          action={
            <button disabled={pending} onClick={() => void discover()}>
              <Plug size={15} />
              Scan ports
            </button>
          }
        >
          <div className="connection-fields">
            <label className="field">
              Serial port
              <input
                aria-label="DAQ serial port"
                list="daq-ports"
                value={path}
                onChange={(e) => setPath(e.target.value.toUpperCase())}
                disabled={connected || pending}
              />
              <datalist id="daq-ports">
                {ports?.filter(isDaqPort).map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.manufacturer}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="field">
              Baud rate
              <select
                aria-label="DAQ baud rate"
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                disabled={connected || pending}
              >
                <option value="115200">115200</option>
                <option value="9600">9600</option>
              </select>
            </label>
            <div className="field">
              Response format<strong>Binary float32 + device timestamps</strong>
            </div>
          </div>
          <div className="button-pair">
            <button
              className="primary"
              disabled={
                pending ||
                s.emergencyStopped ||
                connected ||
                s.recording.active ||
                !ports?.some(
                  (port) =>
                    port.path.toUpperCase() === path.trim().toUpperCase() && isDaqPort(port),
                )
              }
              onClick={() => act({ type: 'daq-connect', path: path.trim(), baudRate })}
            >
              <Plug size={15} />
              Connect and read DAQ
            </button>
            <button
              disabled={pending || !connected}
              onClick={() => act({ type: 'daq-disconnect' })}
            >
              Disconnect DAQ
            </button>
          </div>
          <div className="detail-line">
            <span>Connection</span>
            <strong>
              {s.daq.path ?? 'No port'} · {s.daq.state}
            </strong>
          </div>
          <div className="detail-line">
            <span>Response format</span>
            <strong>{s.daq.format.toUpperCase()}</strong>
          </div>
          <div className="detail-line">
            <span>Received / sent</span>
            <strong>
              {s.daq.receivedBytes.toLocaleString()} / {s.daq.sentBytes.toLocaleString()} bytes
            </strong>
          </div>
          <div className="detail-line">
            <span>Decoded bank packets</span>
            <strong>{s.mode === 'hardware' ? s.frameCount.toLocaleString() : '—'}</strong>
          </div>
          {s.daq.error && (
            <p className="panel-note" role="alert">
              {s.daq.error}
            </p>
          )}
          <p className="help-text">
            Connect attempts DAC zero and starts acquisition at the requested period even if the fan
            interface does not acknowledge. It sends binary commands with little-endian binary
            replies. NaN readings and literal zero values are retained. View Data Viewer for decoded
            values; use Main to apply a manual fan percentage.
          </p>
          {ports &&
            (ports.length ? (
              ports.map((port) => (
                <div className="port-item" key={port.path}>
                  <strong>
                    {port.path}
                    <span>
                      {isDaqPort(port)
                        ? 'DAQ · available for acquisition'
                        : 'Other device · excluded from DAQ connection'}
                    </span>
                  </strong>
                  <p>
                    VID {port.vendorId ?? '—'} · PID {port.productId ?? '—'} · serial{' '}
                    {port.serialNumber ?? '—'}
                  </p>
                </div>
              ))
            ) : (
              <p className="panel-note">No serial devices found.</p>
            ))}
        </Panel>
        <div className="secondary-column">
          <Panel
            title="Verified official DAQ communication"
            subtitle="USB 2E8A:F00F · November 5, 2026"
          >
            <div className="hardware-route">
              <CircleDot size={18} />
              <div>
                <strong>RP2350B DAQ · 115200 baud, 8N1</strong>
                <p>
                  The official board sends little-endian binary measurements with microsecond
                  timestamps and D0 debug text. The application is configured for the firmware's
                  binary output branch.
                </p>
              </div>
            </div>
            <p className="help-text">
              All five measurement banks and all 37 channel slots were captured from the official
              board, including the 24-pressure backpack. Some channels return NaN or repeated high
              values; raw readings are retained and still require physical validation. The app
              selects the DAQ by USB identity, not a saved COM number. CH340/Pitot ports are
              excluded.
            </p>
            <div className="hardware-route">
              <Compass size={18} />
              <div>
                <strong>Acquisition and manual fan reference</strong>
                <p>
                  Fan percentage Apply is available on Main after verified DAC zero. Pitot motion
                  connects independently on startup and homes X/Y before movement. Use the Pitot
                  page for Home, bounded commissioning moves and Stop. Scan ports only lists
                  metadata.
                </p>
              </div>
            </div>
          </Panel>
          <Panel
            title="Reading the results"
            subtitle="Raw data is available even before decoding succeeds"
          >
            <p className="help-text">
              If the receive count increases while the decoded count stays at zero, inspect the raw
              monitor and response format. If receive bytes stay at zero, check the selected port
              and whether another program owns it. Missing sensors may produce NaN, zero, or no bank
              response; the app does not invent values for them.
            </p>
          </Panel>
        </div>
      </div>
      <SerialMonitor snapshot={s} />
    </>
  )
}
