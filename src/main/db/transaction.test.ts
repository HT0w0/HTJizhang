import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { withTransaction, isInTransaction } from './transaction'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  return db
}

function count(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n
}

test('正常返回时数据提交', () => {
  const db = fresh()
  const result = withTransaction(db, () => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('a')
    return 'done'
  })
  expect(result).toBe('done')
  expect(count(db)).toBe(1)
  db.close()
})

test('回调抛错时全部回滚，且原始错误照原样抛出（不被包装）', () => {
  const db = fresh()
  db.prepare('INSERT INTO t (v) VALUES (?)').run('already-there')

  let caught = ''
  try {
    withTransaction(db, () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('will-be-rolled-back')
      throw new Error('业务校验失败：分类重名')
    })
  } catch (e) {
    caught = (e as Error).message
  }

  expect(caught).toBe('业务校验失败：分类重名')
  expect(count(db)).toBe(1)
  db.close()
})

test('回滚之后连接仍然可用，可以接着开新事务', () => {
  const db = fresh()
  expect(() =>
    withTransaction(db, () => {
      throw new Error('x')
    })
  ).toThrow()

  withTransaction(db, () => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('after')
  })
  expect(count(db)).toBe(1)
  db.close()
})

test('嵌套调用被明确拒绝，而不是让 SQLite 抛难懂的底层错误', () => {
  const db = fresh()
  let message = ''
  try {
    withTransaction(db, () => {
      withTransaction(db, () => {
        /* 不该走到这里 */
      })
    })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('嵌套')
  db.close()
})

test('内层抛错后，外层的在途标记被清干净（不会把后续事务全堵死）', () => {
  const db = fresh()
  expect(() =>
    withTransaction(db, () => {
      withTransaction(db, () => {
        throw new Error('inner')
      })
    })
  ).toThrow()
  expect(isInTransaction(db)).toBe(false)
  withTransaction(db, () => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('ok')
  })
  expect(count(db)).toBe(1)
  db.close()
})

test('两个不同的数据库互不干扰', () => {
  const a = fresh()
  const b = fresh()
  withTransaction(a, () => {
    expect(isInTransaction(a)).toBe(true)
    expect(isInTransaction(b)).toBe(false)
    withTransaction(b, () => {
      b.prepare('INSERT INTO t (v) VALUES (?)').run('b')
    })
  })
  expect(count(b)).toBe(1)
  a.close()
  b.close()
})

test('回调返回 undefined 也不出错（多数写入场景不关心返回值）', () => {
  const db = fresh()
  expect(
    withTransaction(db, () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('x')
    })
  ).toBeUndefined()
  expect(count(db)).toBe(1)
  db.close()
})
