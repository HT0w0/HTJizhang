/**
 * 界面与数据库之间的通道。
 *
 * 拆成两层：
 * - categoryHandlers(getDb) 返回一个纯对象，不依赖 electron，可以直接单测；
 * - registerIpcHandlers(ctx) 把它挂到 ipcMain 上，这层没有逻辑，不需要测。
 *
 * ⚠️ 各处理器拿到的是「取当前连接」的**函数**（DbGetter），不是连接本身。
 * 第 6 阶段的「从备份恢复」会把账本整个换掉、连接对象也跟着换一个新的，
 * 如果处理器在注册时就把连接抄在手里，恢复之后**每一个功能都会对着一个
 * 已经关闭的数据库报错** —— 而且症状是「点了没反应 / 程序内部出错」，
 * 完全指不到根因。传函数出去，它们每次调用时现取。
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
  autoBackupFileName,
  backupFileName,
  backupStamp,
  isAutoBackupFileName
} from '@shared/backup'
import { csvFileName } from '@shared/csv'
import {
  assertNotLiveLedger,
  exportDatabaseTo,
  inspectBackupFile,
  restoreFromBackup,
  writeCsvFile
} from './db/backup'
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

/**
 * 怎么拿到「当前正在用的那个数据库连接」。
 *
 * 见文件顶部说明：恢复备份会把连接换掉，所以处理器不能把连接抄在手里。
 */
export type DbGetter = () => DatabaseSync

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

export function categoryHandlers(getDb: DbGetter): CategoryHandlers {
  return {
    list: async () => guard(() => listTree(getDb())),
    listArchived: async () => guard(() => listArchivedTree(getDb())),
    usage: async () => guard(() => usageCounts(getDb())),
    create: async (input) => guard(() => createCategory(getDb(), input)),
    rename: async (id, name) => guard(() => renameCategory(getDb(), id, name)),
    setIcon: async (id, icon) => guard(() => setCategoryIcon(getDb(), id, icon)),
    reorder: async (kind, parentId, orderedIds) =>
      guard(() => reorderSiblings(getDb(), kind, parentId, orderedIds)),
    archive: async (id) => guard(() => archiveCategory(getDb(), id)),
    restore: async (id) => guard(() => restoreCategory(getDb(), id)),
    restoreBuiltins: async () => guard(() => restoreBuiltins(getDb()))
  }
}

export {
  BACKUP_CHANNELS,
  CATEGORY_CHANNELS,
  STATS_CHANNELS,
  TRANSACTION_CHANNELS
} from '@shared/ipcChannels'

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
export function transactionHandlers(getDb: DbGetter): TransactionHandlers {
  return {
    create: async (input) => guard(() => createTransaction(getDb(), input)),
    recentCategoryIds: async () => guard(() => recentCategoryIds(getDb())),
    // 「今天」由主进程算，界面不自己算 —— 界面里算容易误用 UTC（CLAUDE.md §5.2），
    // 而这里与记账数据用的是同一套日期口径。
    today: async () => guard(() => todayLocal()),
    list: async (input) => guard(() => listTransactions(getDb(), input)),
    update: async (input) => guard(() => updateTransaction(getDb(), input)),
    remove: async (id) => guard(() => deleteTransaction(getDb(), id)),
    months: async () => guard(() => monthsWithData(getDb()))
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
export function statsHandlers(getDb: DbGetter): StatsHandlers {
  return {
    overview: async (month) => guard(() => statsOverview(getDb(), month))
  }
}

/**
 * 备份相关的处理器需要的那点「外界」能力。
 *
 * 做成注入的，是为了让本文件继续不依赖 electron（CLAUDE.md 的惯例）：
 * 弹保存框、弹选择框、打开文件夹都得用 electron 的 dialog/shell，
 * 那些在 ipc-register.ts 里实现，测试里换成假的，于是一整套备份逻辑
 * （包括「用户取消」「选错文件」）都能在命令行里跑。
 */
export interface BackupContext {
  readonly getDb: DbGetter
  /** 数据目录，即 app.getPath('userData')。 */
  readonly userDataDir: string
  /** 恢复成功后，把主进程手里那个连接换成新的。必须换，见 DbGetter 的说明。 */
  readonly replaceDatabase: (db: DatabaseSync) => void
  /** 「今天」的本地日期串。由调用方给，界面不自己算（§5.2）。 */
  readonly today: () => string
  /** 弹保存框，返回用户选的完整路径；取消时返回 null。 */
  readonly pickSavePath: (defaultFileName: string) => Promise<string | null>
  /** 弹选择框，返回用户选的备份文件；取消时返回 null。 */
  readonly pickBackupPath: () => Promise<string | null>
  /** 在系统文件管理器里打开数据目录。 */
  readonly openDataFolder: () => Promise<void>
}

/** 用户点了「导出备份文件」之后的结果。cancelled 表示用户在保存框里点了取消。 */
export interface ExportOutcome {
  readonly cancelled: boolean
  /** 保存到的完整路径。取消时是空串。 */
  readonly path: string
}

/** 用户在文件框里选中一个备份之后，先给他看的「这份备份里有什么」。 */
export interface RestorePreview {
  readonly path: string
  readonly fileName: string
  /** 备份文件里有几笔账。 */
  readonly backupCount: number
  readonly backupCategories: number
  readonly firstDate: string
  readonly lastDate: string
  /** 当前账本里有几笔账。和上面那个一起给用户判断选没选错文件。 */
  readonly currentCount: number
  /** 替换前自动另存的那一份的文件名。要显示在确认框里。 */
  readonly autoBackupFileName: string
}

/** 恢复完成后返回给界面的东西（界面会拿它显示「已恢复 N 笔」并重新载入）。 */
export interface RestoreOutcome {
  readonly fileName: string
  readonly count: number
}

export interface BackupHandlers {
  exportDatabase(): Promise<IpcResult<ExportOutcome>>
  exportCsv(month: string | null): Promise<IpcResult<ExportOutcome>>
  openDataFolder(): Promise<IpcResult<void>>
  /** 弹选择框 + 检查文件。用户取消时 preview 为 null。这一步不动任何数据。 */
  pickRestoreFile(): Promise<IpcResult<RestorePreview | null>>
  /**
   * 用备份替换当前账本。**不可逆**，界面上必须先弹确认框。
   *
   * `autoBackupName` 是确认框里给用户看过的那个名字，要原样传回来 ——
   * 不能在这里重新取一次时间（见 pickRestoreFile 里的说明）。
   */
  restore(path: string, autoBackupName: string): Promise<IpcResult<RestoreOutcome>>
}

/** 从文件名里取出「叫什么」，用于界面显示。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * 备份与恢复的处理器。
 *
 * ⚠️ 替换顺序是刻意的：**先检查、再动手**。
 * 「检查备份文件」这一步可能失败（用户选错文件、版本太新），
 * 失败时账本必须一个字节都没动 —— 挑错文件不该有任何代价。
 * 所以 inspectBackupFile 在 restoreFromBackup 的最前面，且它全程只读。
 */
export function backupHandlers(ctx: BackupContext): BackupHandlers {
  return {
    exportDatabase: async () =>
      guardAsync(async () => {
        const path = await ctx.pickSavePath(backupFileName(ctx.today()))
        if (path === null) return { cancelled: true, path: '' }
        // 保存框的**默认目录就是数据目录**，用户把文件名打成 ht-jizhang.db
        // 就指到账本自己身上了。macOS 上那会真的把账本删掉，见 assertNotLiveLedger。
        assertNotLiveLedger(path, ctx.userDataDir)
        exportDatabaseTo(ctx.getDb(), path)
        return { cancelled: false, path }
      }),

    exportCsv: async (month) =>
      guardAsync(async () => {
        const path = await ctx.pickSavePath(csvFileName(month, ctx.today()))
        if (path === null) return { cancelled: true, path: '' }
        // CSV 那边不用 rmSync，但 writeFileSync 同样是整个覆盖掉，一样得拦。
        assertNotLiveLedger(path, ctx.userDataDir)
        writeCsvFile(ctx.getDb(), month, path)
        return { cancelled: false, path }
      }),

    openDataFolder: async () =>
      guardAsync(async () => {
        await ctx.openDataFolder()
      }),

    // 只问、不动：这一步不改任何数据，用户看完确认框反悔了就什么都没发生。
    pickRestoreFile: async () =>
      guardAsync(async () => {
        const path = await ctx.pickBackupPath()
        if (path === null) return null

        const info = inspectBackupFile(path)
        const currentCount = (
          ctx.getDb().prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }
        ).n

        return {
          path,
          fileName: baseName(path),
          backupCount: info.transactions,
          backupCategories: info.categories,
          firstDate: info.firstDate,
          lastDate: info.lastDate,
          currentCount,
          // 名字在这里定下来，一路带到确认框、再带回来。
          // ⚠️ 不要在 restore 里重新取一次时间：用户读完警告再点「替换」
          // 至少要一秒，两处各取一次的结果就是**确认框里写的名字和磁盘上的对不上**
          //（差一秒），用户照着提示去数据文件夹里找会找不到。
          // 2026-10-04 独立复核实测到过（显示 …173930，实际 …173931）。
          autoBackupFileName: autoBackupFileName(backupStamp(new Date()))
        }
      }),

    restore: async (path, autoBackupName) =>
      guard(() => {
        // 这个名字接下来要拼进数据目录的路径里，而它是界面传回来的字符串，
        // 所以先确认它确实是「我们自己产出的那种名字」，不能是 ..\..\别的地方。
        if (!isAutoBackupFileName(autoBackupName)) {
          throw new Error('恢复请求里的备份文件名不合法，已中止。请重新选择备份文件。')
        }

        const before = inspectBackupFile(path)
        const next = restoreFromBackup({
          userDataDir: ctx.userDataDir,
          backupPath: path,
          currentDb: ctx.getDb(),
          autoBackupName
        })
        // 主进程手里那个引用必须跟着换，否则恢复之后所有功能都对着旧连接报错。
        ctx.replaceDatabase(next)
        return { fileName: baseName(path), count: before.transactions }
      })
  }
}

/**
 * guard 的异步版。
 *
 * 为什么需要：导出/弹框这些是 async 的，`guard` 收的是同步函数，
 * async 函数抛出的错会变成一个**被拒绝的 Promise**，穿过 guard 直接冒到
 * ipcMain 那里，渲染进程收到的就是那串英文前缀了 —— 正是 IpcResult 要避免的事。
 */
async function guardAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, message: toMessage(error) }
  }
}
