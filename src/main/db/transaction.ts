/**
 * 手写的事务包装。
 *
 * 为什么不用现成的：Electron 内置的 node:sqlite **没有** better-sqlite3 那样的
 * db.transaction() 便捷方法（实测 typeof 为 'undefined'）。所以必须自己写，
 * 自己写的就得自己测 —— 事务写错会静默丢数据，是最不能靠肉眼检查的地方。
 *
 * 用 WeakSet 按数据库实例记录在途事务，而不是用一个模块级布尔量：
 * 测试里会同时开多个内存库，全局标记会互相污染。
 */
import type { DatabaseSync } from 'node:sqlite'

const inFlight = new WeakSet<DatabaseSync>()

/** 当前是否正处于本包装器开启的事务中。主要给测试和调试用。 */
export function isInTransaction(db: DatabaseSync): boolean {
  return inFlight.has(db)
}

/**
 * 在事务中执行 fn，成功则提交，抛错则回滚并把原始错误原样抛出。
 *
 * 用 BEGIN IMMEDIATE 而不是 BEGIN：立刻拿写锁，避免「读事务中途要升级成
 * 写事务」时撞上 SQLITE_BUSY。单机单进程下两者差别不大，但这个更正确。
 *
 * 不支持嵌套 —— 实测嵌套 BEGIN 会被 SQLite 拒绝（"cannot start a
 * transaction within a transaction"）。与其让底层抛出难懂的英文错误，
 * 不如在这里拦下来给一句能看懂的中文。
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (inFlight.has(db)) {
    throw new Error('内部错误：不支持嵌套事务。请把这两段写入合并到一个事务里。')
  }

  db.exec('BEGIN IMMEDIATE')
  inFlight.add(db)

  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 连接已不可用，回滚失败。此时原始错误信息比回滚失败更有诊断价值。
    }
    throw error
  } finally {
    inFlight.delete(db)
  }
}
