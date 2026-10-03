import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, MIGRATIONS } from './migrations'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as unknown as Array<{ name: string }>
  return rows.map((r) => r.name)
}

test('空库跑一遍，版本号推进到最后一条迁移', () => {
  const db = fresh()
  const applied = migrate(db)
  expect(applied).toBe(MIGRATIONS.length)
  expect(userVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
  db.close()
})

test('v1 建出 categories 与 transactions 两张表', () => {
  const db = fresh()
  migrate(db)
  expect(tableNames(db)).toEqual(['categories', 'transactions'])
  db.close()
})

test('重复跑不会重复执行（版本号已到位就跳过）', () => {
  const db = fresh()
  migrate(db)
  const again = migrate(db)
  expect(again).toBe(0)
  db.close()
})

test('迁移中途失败时，表结构和版本号一起回滚，不留半成品', () => {
  const db = fresh()
  const boom = [
    {
      version: 1,
      up: (d: DatabaseSync): void => {
        d.exec('CREATE TABLE ok_table (id INTEGER PRIMARY KEY)')
        throw new Error('模拟迁移中途断电')
      }
    }
  ]
  expect(() => migrate(db, boom)).toThrow('模拟迁移中途断电')
  expect(userVersion(db)).toBe(0)
  expect(tableNames(db)).toEqual([])
  db.close()
})

test('迁移版本号回滚后，还能重新跑成功（用户重启程序能自愈）', () => {
  const db = fresh()
  const bad = [
    {
      version: 1,
      up: (d: DatabaseSync): void => {
        d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        throw new Error('x')
      }
    }
  ]
  expect(() => migrate(db, bad)).toThrow()
  const applied = migrate(db)
  expect(applied).toBe(MIGRATIONS.length)
  expect(tableNames(db)).toEqual(['categories', 'transactions'])
  db.close()
})

test('版本号非递增的迁移表会被拒绝（防止写错顺序静默跳过）', () => {
  const db = fresh()
  const wrong = [
    { version: 2, up: (): void => {} },
    { version: 1, up: (): void => {} }
  ]
  expect(() => migrate(db, wrong)).toThrow()
  db.close()
})

// ---------- 结构约束（CLAUDE.md §5.2 要求日期一律本地 YYYY-MM-DD） ----------

function seedOneCategory(db: DatabaseSync): number {
  const r = db
    .prepare(
      `INSERT INTO categories (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
       VALUES ('expense', NULL, '餐饮', '🍜', 0, 0, 'expense/餐饮', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
    )
    .run()
  const id = Number(r.lastInsertRowid)
  db.prepare(
    `INSERT INTO categories (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
     VALUES ('expense', ?, '早餐', '🥐', 0, 0, 'expense/餐饮/早餐', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  ).run(id)
  return id
}

function insertTx(db: DatabaseSync, occurredOn: string): void {
  const breakfast = (
    db.prepare("SELECT id FROM categories WHERE builtin_key = 'expense/餐饮/早餐'").get() as {
      id: number
    }
  ).id
  db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', 1200, ?, ?, '', 'wechat', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  ).run(breakfast, occurredOn)
}

test('合法日期能被写入', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  expect(() => insertTx(db, '2026-10-03')).not.toThrow()
  db.close()
})

test('日期格式写成 2026/10/03 会被数据库拒绝（防止时区与格式跑偏）', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  expect(() => insertTx(db, '2026/10/03')).toThrow()
  db.close()
})

test('日期写成 UTC 时间戳会被数据库拒绝', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  expect(() => insertTx(db, '2026-10-03T00:00:00.000Z')).toThrow()
  db.close()
})

test('不存在的日期 2026-13-45 会被数据库拒绝', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  expect(() => insertTx(db, '2026-13-45')).toThrow()
  db.close()
})

test('个位数不补零的 2026-1-3 会被拒绝（要求严格 YYYY-MM-DD）', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  expect(() => insertTx(db, '2026-1-3')).toThrow()
  db.close()
})

test('金额必须为正整数：0 与负数都被拒绝', () => {
  const db = fresh()
  migrate(db)
  seedOneCategory(db)
  const breakfast = (
    db.prepare("SELECT id FROM categories WHERE builtin_key = 'expense/餐饮/早餐'").get() as {
      id: number
    }
  ).id
  const insert = db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', ?, ?, '2026-10-03', '', 'wechat', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  )
  expect(() => insert.run(0, breakfast)).toThrow()
  expect(() => insert.run(-100, breakfast)).toThrow()
  expect(() => insert.run(1, breakfast)).not.toThrow()
  db.close()
})

test('categories.kind 只接受 expense / income', () => {
  const db = fresh()
  migrate(db)
  const insert = db.prepare(
    `INSERT INTO categories (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
     VALUES (?, NULL, 'x', '❓', 0, 0, NULL, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  )
  expect(() => insert.run('支出')).toThrow()
  expect(() => insert.run('expense')).not.toThrow()
  db.close()
})
