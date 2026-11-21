import type { PortInfo } from './model'

/** Only the observed RP2350 DAQ identity. CH340/Pitot ports must never be opened here. */
export function isDaqPort(port: PortInfo): boolean {
  return port.vendorId?.toUpperCase() === '2E8A' && port.productId?.toUpperCase() === 'F00F'
}
export function preferredDaqPath(ports: PortInfo[]): string | undefined {
  const boards = ports.filter(isDaqPort)
  return boards.length === 1 ? boards[0]!.path : undefined
}
