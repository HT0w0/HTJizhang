import { test, expect } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabaseIn, disposeDatabaseIn } from './index'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ht-init-'))
}

test('首次初始化：自己建目录、建库、建表、写内置分类', () => {
  const dir = tempDir()
  const target = join(dir, '还不存在的目录')
  const db = initDatabaseIn(target)

  const n = (db.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n
  expect(n).toBe(96)
  disposeDatabaseIn(db)
  expect(readdirSync(target)).toContain('ht-jizhang.db')
  rmSync(dir, { recursive: true, force: true })
})

test('第二次初始化：不重复写入分类，数据还在', () => {
  const dir = tempDir()
  const first = initDatabaseIn(dir)
  first.prepare("UPDATE categories SET name = '吃饭' WHERE builtin_key = 'expense/餐饮'").run()
  disposeDatabaseIn(first)

  const second = initDatabaseIn(dir)
  const n = (second.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n
  expect(n).toBe(96)
  const row = second
    .prepare("SELECT name FROM categories WHERE builtin_key = 'expense/餐饮'")
    .get() as { name: string }
  expect(row.name).toBe('吃饭')
  disposeDatabaseIn(second)
  rmSync(dir, { recursive: true, force: true })
})

test('初始化返回的库可以直接用：外键约束已开、能正常读写', () => {
  const dir = tempDir()
  const db = initDatabaseIn(dir)

  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  expect(fk.foreign_keys).toBe(1)

  const breakfast = db
    .prepare("SELECT id FROM categories WHERE builtin_key = 'expense/餐饮/早餐'")
    .get() as { id: number }
  db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', 1200, ?, '2026-10-03', '', 'wechat', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  ).run(breakfast.id)
  const n = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(n).toBe(1)

  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('路径被一个同名文件占住时，初始化会抛错而不是静默失败', () => {
  const dir = tempDir()
  // 把「数据目录」这个路径占成一个文件，mkdirSync 必然失败
  const blocked = join(dir, '占位文件')
  writeFileSync(blocked, 'x')

  expect(() => initDatabaseIn(blocked)).toThrow()
  rmSync(dir, { recursive: true, force: true })
})

test('disposeDatabaseIn 重复调用不抛错', () => {
  const dir = tempDir()
  const db = initDatabaseIn(dir)
  disposeDatabaseIn(db)
  expect(() => disposeDatabaseIn(db)).not.toThrow()
  rmSync(dir, { recursive: true, force: true })
})
