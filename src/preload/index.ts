import { contextBridge, ipcRenderer } from 'electron'
import type {
  CategoryKind,
  CreateCategoryInput,
  CreateTransactionInput,
  HtApi,
  IpcResult,
  ListTransactionsInput,
  UpdateTransactionInput
} from '@shared/types'
import {
  BACKUP_CHANNELS,
  CATEGORY_CHANNELS,
  STATS_CHANNELS,
  TRANSACTION_CHANNELS
} from '@shared/ipcChannels'

/**
 * 把一个 IPC 调用包成「失败就抛干净中文错误」的形式。
 *
 * 主进程那边返回的是 IpcResult，这里负责拆包：
 * 成功直接给出值，失败就抛出一个 message 就是中文原话的 Error，
 * 界面里 try/catch 拿到 err.message 就能直接显示给用户。
 */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  throw new Error(result.message)
}

const api: HtApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  categories: {
    list: () => call(CATEGORY_CHANNELS.list),
    listArchived: () => call(CATEGORY_CHANNELS.listArchived),
    usage: () => call(CATEGORY_CHANNELS.usage),
    create: (input: CreateCategoryInput) => call(CATEGORY_CHANNELS.create, input),
    rename: (id: number, name: string) => call(CATEGORY_CHANNELS.rename, id, name),
    setIcon: (id: number, icon: string) => call(CATEGORY_CHANNELS.setIcon, id, icon),
    reorder: (kind: CategoryKind, parentId: number | null, orderedIds: readonly number[]) =>
      call(CATEGORY_CHANNELS.reorder, kind, parentId, orderedIds),
    archive: (id: number) => call(CATEGORY_CHANNELS.archive, id),
    restore: (id: number) => call(CATEGORY_CHANNELS.restore, id),
    restoreBuiltins: () => call(CATEGORY_CHANNELS.restoreBuiltins)
  },
  transactions: {
    create: (input: CreateTransactionInput) => call(TRANSACTION_CHANNELS.create, input),
    recentCategoryIds: () => call(TRANSACTION_CHANNELS.recentCategoryIds),
    today: () => call(TRANSACTION_CHANNELS.today),
    list: (input: ListTransactionsInput) => call(TRANSACTION_CHANNELS.list, input),
    update: (input: UpdateTransactionInput) => call(TRANSACTION_CHANNELS.update, input),
    remove: (id: number) => call(TRANSACTION_CHANNELS.remove, id),
    months: () => call(TRANSACTION_CHANNELS.months)
  },
  stats: {
    overview: (month: string) => call(STATS_CHANNELS.overview, month)
  },
  backup: {
    exportDatabase: () => call(BACKUP_CHANNELS.exportDatabase),
    exportCsv: (month: string | null) => call(BACKUP_CHANNELS.exportCsv, month),
    openDataFolder: () => call(BACKUP_CHANNELS.openDataFolder),
    pickRestoreFile: () => call(BACKUP_CHANNELS.pickRestoreFile),
    restore: (path: string, autoBackupName: string) =>
      call(BACKUP_CHANNELS.restore, path, autoBackupName)
  }
}

contextBridge.exposeInMainWorld('ht', api)
