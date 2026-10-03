import type { HtApi } from '@shared/types'

declare global {
  interface Window {
    ht: HtApi
  }
}

export {}
