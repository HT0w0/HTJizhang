/**
 * 数据库连接的建立与关闭。
 *
 * 本文件刻意不引入 electron —— 路径由调用方传进来，
 * 这样测试可以直接用临时目录跑，不需要启动整个 Electron。
 * electron 相关的路径解析在 ./index.ts 里。
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 数据库文件名。纯 ASCII，避免任何路径编码问题。 */
const DB_FILE_NAME = 'ht-jizhang.db'

/**
 * 拼出数据库文件的完整路径。
 * 一律走 path.join —— Windows 用反斜杠、macOS 用斜杠，手写拼接必出错。
 */
export function defaultDatabasePath(userDataDir: string): string {
  return join(userDataDir, DB_FILE_NAME)
}

/**
 * 打开数据库并设好 PRAGMA。
 *
 * - journal_mode = WAL：读写并发更好、断电时更不容易损坏。
 *   注意 WAL 在内存库（':memory:'）上会静默降级为 memory，这不算错误。
 * - foreign_keys = ON：SQLite 默认是关的，不开的话外键约束形同虚设。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/**
 * 关闭数据库。
 *
 * node:sqlite 的 close() 在库已经关闭时会抛 "database is not open"，
 * 直接调会在「启动失败 → 清理 → 再关一次」这类路径上二次抛错，
 * 把真正的错误盖掉。这里用 isOpen 先判断，让重复关闭成为安全的空操作。
 */
export function closeDatabase(db: DatabaseSync): void {
  if (db.isOpen) {
    db.close()
  }
}
