/**
 * 把 IPC 处理器挂到 Electron 上。
 *
 * 本文件单独存在的原因：这里静态导入 electron，而 electron 在测试环境里
 * 只是一个字符串路径模块，拿不到 ipcMain。业务逻辑放在 ./ipc.ts（不含 electron，
 * 可直接单测），本文件只做「把已有函数挂上去」这一件事，没有逻辑也就不需要测。
 */
import { join, dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  CategoryKind,
  CreateCategoryInput,
  CreateTransactionInput,
  ListTransactionsInput,
  UpdateTransactionInput
} from '@shared/types'
import { todayLocal } from '@shared/localDate'
import {
  BACKUP_CHANNELS,
  CATEGORY_CHANNELS,
  STATS_CHANNELS,
  TRANSACTION_CHANNELS,
  backupHandlers,
  categoryHandlers,
  statsHandlers,
  transactionHandlers
} from './ipc'

/** 主进程手里那份「当前连接」。恢复备份会把它整个换掉。 */
export interface DatabaseHolder {
  db: DatabaseSync
  /** 数据目录，即 app.getPath('userData')。 */
  userDataDir: string
}

export function registerIpcHandlers(holder: DatabaseHolder): void {
  const getDb = (): DatabaseSync => holder.db

  const h = categoryHandlers(getDb)

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

  const t = transactionHandlers(getDb)

  ipcMain.handle(TRANSACTION_CHANNELS.create, (_event, input: CreateTransactionInput) =>
    t.create(input)
  )
  ipcMain.handle(TRANSACTION_CHANNELS.recentCategoryIds, () => t.recentCategoryIds())
  ipcMain.handle(TRANSACTION_CHANNELS.today, () => t.today())
  ipcMain.handle(TRANSACTION_CHANNELS.list, (_event, input: ListTransactionsInput) =>
    t.list(input)
  )
  ipcMain.handle(TRANSACTION_CHANNELS.update, (_event, input: UpdateTransactionInput) =>
    t.update(input)
  )
  ipcMain.handle(TRANSACTION_CHANNELS.remove, (_event, id: number) => t.remove(id))
  ipcMain.handle(TRANSACTION_CHANNELS.months, () => t.months())

  const s = statsHandlers(getDb)

  ipcMain.handle(STATS_CHANNELS.overview, (_event, month: string) => s.overview(month))

  const b = backupHandlers({
    getDb,
    userDataDir: holder.userDataDir,
    // 换连接。**必须做**：不换的话，恢复之后每个功能都对着一个已经关掉的
    // 数据库报错，而症状只是「点了没反应」，完全指不到根因。
    replaceDatabase: (next) => {
      holder.db = next
    },
    today: () => todayLocal(),
    pickSavePath: (defaultFileName) => pickSavePath(defaultFileName),
    pickBackupPath: () => pickBackupPath(),
    openDataFolder: async () => {
      const error = await shell.openPath(holder.userDataDir)
      if (error !== '') throw new Error(`打不开数据文件夹：${error}`)
    }
  })

  ipcMain.handle(BACKUP_CHANNELS.exportDatabase, () => b.exportDatabase())
  ipcMain.handle(BACKUP_CHANNELS.exportCsv, (_event, month: string | null) => b.exportCsv(month))
  ipcMain.handle(BACKUP_CHANNELS.openDataFolder, () => b.openDataFolder())
  ipcMain.handle(BACKUP_CHANNELS.pickRestoreFile, () => b.pickRestoreFile())
  ipcMain.handle(
    BACKUP_CHANNELS.restore,
    (_event, path: string, autoBackupName: string) => b.restore(path, autoBackupName)
  )
}

/** 上次用户把文件存到了哪里。再做一次同类导出时，保存框从那儿开始。 */
let lastSaveDir: string | undefined

/**
 * 验证脚本用的「弹框替身」。
 *
 * 为什么需要：原生文件框是**操作系统的窗口**，CDP 够不着、点不动。于是
 * 「导出到哪」和「从哪个文件恢复」这两条路径在脚本里一步都走不了 ——
 * 而恢复是全软件**唯一不可逆**的操作，恰恰是最该被客观验证的一个。
 * 有了这两个环境变量，验证脚本能走完整的：点按钮 → 看到确认框里的
 * 「备份里有 N 笔 / 当前有 M 笔」→ 点「替换」→ 真的换掉了 → 界面重新载入。
 *
 * ⚠️ 三条约束，改这段代码时别破坏：
 * 1. **用 app.isPackaged 挡住**：打包给用户的那份里这条分支**根本不存在**。
 *    它不是一个「用户可以打开的开关」，只在你从源码跑（含验证脚本）时才可能生效。
 * 2. **它不跳过确认框**。恢复照样得先看到那段警告、再点「替换」——
 *    去掉的是文件选择框，不是用户的同意。
 * 3. 值取 `__cancel__` 时返回 null，用来验证「用户取消」这条路径。
 *
 * 见 CLAUDE.md §5.27。
 */
const testSaveDir = app.isPackaged ? undefined : process.env['HT_TEST_SAVE_DIR']
const testOpenPath = app.isPackaged ? undefined : process.env['HT_TEST_OPEN_PATH']
/** 传给 HT_TEST_OPEN_PATH 表示「用户点了取消」。 */
const CANCEL = '__cancel__'

/**
 * 弹「另存为」对话框。
 *
 * defaultPath 用**上次存过的目录** + 这次的默认文件名：用户把备份存到 U 盘之后，
 * 下次导出还应该从 U 盘开始，而不是每次都从「文档」重新找一遍。
 *
 * 用户取消时返回 null —— 那是正常操作，不是错误，不该弹报错。
 */
async function pickSavePath(defaultFileName: string): Promise<string | null> {
  // 验证脚本的替身，见上面 testSaveDir 的说明
  if (testSaveDir !== undefined) return join(testSaveDir, defaultFileName)

  const window = focusedWindow()
  const options = {
    defaultPath: lastSaveDir ? join(lastSaveDir, defaultFileName) : defaultFileName,
    filters: [
      { name: '备份文件', extensions: ['db'] },
      { name: '表格文件', extensions: ['csv'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }

  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) return null
  lastSaveDir = dirname(result.filePath)
  return result.filePath
}

/** 弹「选一个备份文件」对话框。取消时返回 null。 */
async function pickBackupPath(): Promise<string | null> {
  // 验证脚本的替身，见上面 testOpenPath 的说明
  if (testOpenPath !== undefined) return testOpenPath === CANCEL ? null : testOpenPath

  const window = focusedWindow()
  const options = {
    title: '选择要恢复的备份文件',
    defaultPath: lastSaveDir ?? app.getPath('userData'),
    properties: ['openFile' as const],
    filters: [{ name: '备份文件', extensions: ['db'] }]
  }

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/**
 * 弹框要挂在某个窗口上，否则在 macOS 上会变成一个不跟着应用走的游离窗口。
 * 拿不到窗口（理论上不该发生）时返回 undefined，那边有兜底。
 */
function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}
