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
