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
  CreateTransactionInput,
  IpcResult,
  ListTransactionsInput,
  StatsOverview,
  Transaction,
  TransactionListItem,
  UpdateTransactionInput
} from '@shared/types'
import { todayLocal } from '@shared/localDate'
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
  monthsWithData,
  recentCategoryIds,
  updateTransaction
} from './db/transactions'
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
import { statsOverview } from './db/stats'

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

/** 用来区分「我们自己抛的中文提示」和「数据库/文件系统抛的英文错误」。 */
const HAS_CHINESE = /[一-鿿]/

/**
 * 把任意抛出物转成一段用户看得懂的话。
 *
 * 分两种情况：
 * - 我们自己抛的错误：仓储层的业务校验一律抛中文，原样透传即可。
 * - 数据库/文件系统抛的错误：这些是英文，比如磁盘写满时的
 *   "database or disk is full"、数据文件被网盘或杀软锁住时的
 *   "database is locked"、WAL 写失败时的 "disk I/O error"。
 *   用户看不懂英文，必须在前面加一句中文说明；**但英文原文要保留** ——
 *   它是出问题时唯一的排查线索，去掉之后开发者就无从下手了。
 */
function toMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim()

  if (text === '' || text === 'undefined' || text === 'null') {
    return '操作失败，请重试。若反复出现，请把刚才的操作告诉开发者。'
  }

  if (HAS_CHINESE.test(text)) return text

  return `程序内部出错了：${text}\n请先重试一次。若反复出现，请把这句话发给开发者。`
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

export { CATEGORY_CHANNELS, STATS_CHANNELS, TRANSACTION_CHANNELS } from '@shared/ipcChannels'

export interface TransactionHandlers {
  create(input: CreateTransactionInput): Promise<IpcResult<Transaction>>
  recentCategoryIds(): Promise<IpcResult<number[]>>
  today(): Promise<IpcResult<string>>
  list(input: ListTransactionsInput): Promise<IpcResult<TransactionListItem[]>>
  update(input: UpdateTransactionInput): Promise<IpcResult<Transaction>>
  remove(id: number): Promise<IpcResult<void>>
  months(): Promise<IpcResult<string[]>>
}

/**
 * 账单的 IPC 处理器。
 *
 * 与分类处理器一样，全部返回 IpcResult 而不是抛异常 ——
 * ipcMain.handle 抛出后渲染进程拿到的消息会被包上英文前缀。
 */
export function transactionHandlers(db: DatabaseSync): TransactionHandlers {
  return {
    create: async (input) => guard(() => createTransaction(db, input)),
    recentCategoryIds: async () => guard(() => recentCategoryIds(db)),
    // 「今天」由主进程算，界面不自己算 —— 界面里算容易误用 UTC（CLAUDE.md §5.2），
    // 而这里与记账数据用的是同一套日期口径。
    today: async () => guard(() => todayLocal()),
    list: async (input) => guard(() => listTransactions(db, input)),
    update: async (input) => guard(() => updateTransaction(db, input)),
    remove: async (id) => guard(() => deleteTransaction(db, id)),
    months: async () => guard(() => monthsWithData(db))
  }
}

export interface StatsHandlers {
  overview(month: string): Promise<IpcResult<StatsOverview>>
}

/**
 * 统计的 IPC 处理器。
 *
 * 统计页一次只调这一个通道（卡片、饼图、排行、趋势全在这一个返回值里）。
 * 分四次取的话，四次之间用户刚好记了一笔，就会出现「卡片写 100 元、
 * 饼图加起来 120 元」这种对不上、且**当场看不出来**的数字。
 */
export function statsHandlers(db: DatabaseSync): StatsHandlers {
  return {
    overview: async (month) => guard(() => statsOverview(db, month))
  }
}
