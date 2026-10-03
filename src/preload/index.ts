import { contextBridge } from 'electron'
import type { HtApi } from '@shared/types'

// 第 1 阶段只暴露版本号占位。
// 第 2 阶段起在这里挂数据库 API——所有数据读写都必须经由这里（CLAUDE.md §5.3）。
const api: HtApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('ht', api)
