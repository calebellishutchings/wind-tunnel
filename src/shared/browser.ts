/** Minimal native API contracts, also used by offline browser fixtures. */
export interface BrowserSerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): { usbVendorId?: number; usbProductId?: number }
  open(options: {
    baudRate: number
    dataBits: 8
    stopBits: 1
    parity: 'none'
    flowControl: 'none'
    bufferSize: number
  }): Promise<void>
  setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>
  close(): Promise<void>
}
export interface BrowserSerial extends EventTarget {
  getPorts(): Promise<BrowserSerialPort[]>
  requestPort(options: {
    filters: { usbVendorId: number; usbProductId: number }[]
  }): Promise<BrowserSerialPort>
}
export interface SaveFileHandle {
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: string | Uint8Array): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
  }>
}
export interface FilePickerOptions {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}
declare global {
  interface Navigator {
    readonly serial?: BrowserSerial
  }
  interface Window {
    showSaveFilePicker?: (options: FilePickerOptions) => Promise<SaveFileHandle>
    showOpenFilePicker?: (options: {
      multiple: false
      types: FilePickerOptions['types']
    }) => Promise<{ getFile(): Promise<File> }[]>
  }
}
