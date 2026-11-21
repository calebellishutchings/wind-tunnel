import { BrowserSerialTransport, serialRegistry } from './serial'
export class SerialPitotTransport extends BrowserSerialTransport {
  constructor(registry = serialRegistry) {
    super('pitot', registry)
  }
}
