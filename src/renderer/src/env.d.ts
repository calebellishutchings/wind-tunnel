import type { TunnelApi } from '../../shared/model'
declare global {
  interface Window {
    tunnel: TunnelApi
  }
}
export {}
