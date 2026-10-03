/**
 * 界面与数据库之间的通道。
 *
 * 拆成两层：
 * - categoryHandlers(db) 返回一个纯对象，不依赖 electron，可以直接单测；
 * - registerIpcHandlers(db) 把它挂到 ipcMain 上，这层没有逻辑，不需要测。
 *
 * 所有处理器都返回 IpcResult 而不是抛异常：ipcMain.handle 抛出后，
 * 渲染进程拿到的消息会被包上 "Error invoking remote method '...'" 这串英文，
 * 没法直接给用户看。包一层之后界面能拿到干净的中文原话。
 *
 * ⚠️ 本文件顶部**不能**静态导入 electron：测试环境里 electron 只是一个字符串
 * 路径模块，拿不到 ipcMain。因此 electron 的导入放在 registerIpcHandlers 内部。
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  Category,
  CategoryKind,
  CategoryNode,
  CreateCategoryInput,
  IpcResult
} from '@shared/types'
import {
  archiveCategory,
  createCategory,
  listArchivedTree,
  listTree,
  renameCategory,
  reorderSiblings,
  restoreBuiltins,
  restoreCategory,
  setCategoryIcon,
  usageCounts
} from './db/categories'

export interface CategoryHandlers {
  list(): Promise<IpcResult<CategoryNode[]>>
  listArchived(): Promise<IpcResult<CategoryNode[]>>
  usage(): Promise<IpcResult<Record<number, number>>>
  create(input: CreateCategoryInput): Promise<IpcResult<Category>>
  rename(id: number, name: string): Promise<IpcResult<void>>
  setIcon(id: number, icon: string): Promise<IpcResult<void>>
  reorder(
    kind: CategoryKind,
    parentId: number | null,
    orderedIds: readonly number[]
  ): Promise<IpcResult<void>>
  archive(id: number): Promise<IpcResult<void>>
  restore(id: number): Promise<IpcResult<void>>
  restoreBuiltins(): Promise<IpcResult<number>>
}

/**
 * 把任意抛出物转成一句能显示给用户的中文。
 *
 * 注意不能简单地把 error.message 直接往下传：底层抛的可能是
 * "SQLITE_BUSY"、"database is not open" 这类英文，
 * 但本项目的仓储层已经保证「面向用户的失败都抛中文 Error」，
 * 所以这里以 Error.message 为主，兜底才用其它形式。
 */
function toMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  const text = String(error)
  if (text.trim() !== '' && text !== 'undefined' && text !== 'null') return text
  return '操作失败，请重试。若反复出现，请把刚才的操作告诉开发者。'
}

/** 包一层：成功返回 { ok: true, value }，失败返回 { ok: false, message }。 */
function guard<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, message: toMessage(error) }
  }
}

export function categoryHandlers(db: DatabaseSync): CategoryHandlers {
  return {
    list: async () => guard(() => listTree(db)),
    listArchived: async () => guard(() => listArchivedTree(db)),
    usage: async () => guard(() => usageCounts(db)),
    create: async (input) => guard(() => createCategory(db, input)),
    rename: async (id, name) => guard(() => renameCategory(db, id, name)),
    setIcon: async (id, icon) => guard(() => setCategoryIcon(db, id, icon)),
    reorder: async (kind, parentId, orderedIds) =>
      guard(() => reorderSiblings(db, kind, parentId, orderedIds)),
    archive: async (id) => guard(() => archiveCategory(db, id)),
    restore: async (id) => guard(() => restoreCategory(db, id)),
    restoreBuiltins: async () => guard(() => restoreBuiltins(db))
  }
}

export { CATEGORY_CHANNELS } from '@shared/ipcChannels'
