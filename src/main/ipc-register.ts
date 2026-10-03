/**
 * 把 IPC 处理器挂到 Electron 上。
 *
 * 本文件单独存在的原因：这里静态导入 electron，而 electron 在测试环境里
 * 只是一个字符串路径模块，拿不到 ipcMain。业务逻辑放在 ./ipc.ts（不含 electron，
 * 可直接单测），本文件只做「把已有函数挂上去」这一件事，没有逻辑也就不需要测。
 */
import type { DatabaseSync } from 'node:sqlite'
import { ipcMain } from 'electron'
import type { CategoryKind, CreateCategoryInput, CreateTransactionInput } from '@shared/types'
import { CATEGORY_CHANNELS, TRANSACTION_CHANNELS, categoryHandlers, transactionHandlers } from './ipc'

export function registerIpcHandlers(db: DatabaseSync): void {
  const h = categoryHandlers(db)

  ipcMain.handle(CATEGORY_CHANNELS.list, () => h.list())
  ipcMain.handle(CATEGORY_CHANNELS.listArchived, () => h.listArchived())
  ipcMain.handle(CATEGORY_CHANNELS.usage, () => h.usage())
  ipcMain.handle(CATEGORY_CHANNELS.create, (_event, input: CreateCategoryInput) => h.create(input))
  ipcMain.handle(CATEGORY_CHANNELS.rename, (_event, id: number, name: string) => h.rename(id, name))
  ipcMain.handle(CATEGORY_CHANNELS.setIcon, (_event, id: number, icon: string) => h.setIcon(id, icon))
  ipcMain.handle(
    CATEGORY_CHANNELS.reorder,
    (_event, kind: CategoryKind, parentId: number | null, orderedIds: readonly number[]) =>
      h.reorder(kind, parentId, orderedIds)
  )
  ipcMain.handle(CATEGORY_CHANNELS.archive, (_event, id: number) => h.archive(id))
  ipcMain.handle(CATEGORY_CHANNELS.restore, (_event, id: number) => h.restore(id))
  ipcMain.handle(CATEGORY_CHANNELS.restoreBuiltins, () => h.restoreBuiltins())

  const t = transactionHandlers(db)

  ipcMain.handle(TRANSACTION_CHANNELS.create, (_event, input: CreateTransactionInput) =>
    t.create(input)
  )
  ipcMain.handle(TRANSACTION_CHANNELS.recentCategoryIds, () => t.recentCategoryIds())
  ipcMain.handle(TRANSACTION_CHANNELS.today, () => t.today())
}
