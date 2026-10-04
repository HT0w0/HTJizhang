/**
 * 数据库的启动装配。
 *
 * 这里把「建目录 → 开库 → 迁移 → 播种」串成一条线。
 *
 * 本文件刻意不引入 electron —— 接受的是数据目录路径而不是自己去问 app.getPath，
 * 这样测试可以直接喂临时目录，跑的是和线上完全同一条代码路径。
 * electron 相关的取值在 src/main/index.ts 里做。
 */
import { mkdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { closeDatabase, defaultDatabasePath, openDatabase } from './connection'
import { migrate } from './migrations'
import { seedBuiltinCategories } from './seed'

/**
 * 在指定目录里打开（必要时创建）数据库，并推进到最新结构、补齐内置分类。
 *
 * 目录不存在时自动创建：用户第一次启动程序时 %APPDATA%\HTJizhang\ 还没被建出来，
 * 少了这一步会直接启动失败。
 *
 * 中途任何一步失败都会先把连接关掉再往上抛，不留一个半开的文件句柄。
 */
export function initDatabaseIn(userDataDir: string): DatabaseSync {
  mkdirSync(userDataDir, { recursive: true })
  return initDatabaseAt(defaultDatabasePath(userDataDir))
}

/**
 * 同上，但直接指定数据库文件路径。
 *
 * 恢复备份时要先拿一份**临时副本**试一遍「打开 → 迁移 → 播种」（见 db/backup.ts）：
 * 光看表名根本认不出「长得像备份、其实结构不是我们的」文件，只有真的迁移一次
 * 才知道行不行。而那个副本不在数据目录里，得能按路径打开。
 */
export function initDatabaseAt(dbPath: string): DatabaseSync {
  const db = openDatabase(dbPath)
  try {
    migrate(db)
    seedBuiltinCategories(db)
  } catch (error) {
    closeDatabase(db)
    throw error
  }
  return db
}

/** 关闭数据库。可安全重复调用。 */
export function disposeDatabaseIn(db: DatabaseSync): void {
  closeDatabase(db)
}
