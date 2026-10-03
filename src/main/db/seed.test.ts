import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'
import { BUILTIN_CATEGORIES, seedBuiltinCategories } from './seed'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

interface Row {
  id: number
  kind: string
  parent_id: number | null
  name: string
  icon: string
  sort_order: number
  builtin_key: string | null
}

function allRows(db: DatabaseSync): Row[] {
  return db
    .prepare(
      'SELECT id, kind, parent_id, name, icon, sort_order, builtin_key FROM categories ORDER BY kind, parent_id, sort_order'
    )
    .all() as unknown as Row[]
}

test('内置分类表本身的规模符合产品文档：16 个大类', () => {
  expect(BUILTIN_CATEGORIES).toHaveLength(16)
  expect(BUILTIN_CATEGORIES.filter((c) => c.kind === 'expense')).toHaveLength(11)
  expect(BUILTIN_CATEGORIES.filter((c) => c.kind === 'income')).toHaveLength(5)
})

test('小类总数符合产品文档：支出 61 + 收入 19 = 80', () => {
  const expense = BUILTIN_CATEGORIES.filter((c) => c.kind === 'expense').reduce(
    (n, c) => n + c.children.length,
    0
  )
  const income = BUILTIN_CATEGORIES.filter((c) => c.kind === 'income').reduce(
    (n, c) => n + c.children.length,
    0
  )
  expect(expense).toBe(61)
  expect(income).toBe(19)
})

test('播种后数据库里是 16 个大类 + 80 个小类 = 96 行', () => {
  const db = fresh()
  const inserted = seedBuiltinCategories(db)
  expect(inserted).toBe(96)
  expect(allRows(db)).toHaveLength(96)
  db.close()
})

test('每个小类都正确挂在同 kind 的大类下，没有孤儿', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  const rows = allRows(db)
  const majors = rows.filter((r) => r.parent_id === null)
  const minors = rows.filter((r) => r.parent_id !== null)

  expect(majors).toHaveLength(16)
  expect(minors).toHaveLength(80)

  const kindById = new Map(majors.map((m) => [m.id, m.kind]))
  for (const minor of minors) {
    expect(kindById.get(minor.parent_id as number)).toBe(minor.kind)
  }
  db.close()
})

test('内置分类都有 builtin_key，且互不重复', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  const keys = allRows(db).map((r) => r.builtin_key)
  expect(keys.every((k) => k !== null && k.length > 0)).toBe(true)
  expect(new Set(keys).size).toBe(96)
  db.close()
})

test('sort_order 在大类之间、以及同一大类的各小类之间都是 0,1,2... 连续无重复', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  const rows = allRows(db)

  const majors = rows.filter((r) => r.parent_id === null)
  for (const kind of ['expense', 'income']) {
    const orders = majors
      .filter((m) => m.kind === kind)
      .map((m) => m.sort_order)
      .sort((a, b) => a - b)
    expect(orders).toEqual(orders.map((_, i) => i))
  }

  const groups = new Map<number, number[]>()
  for (const minor of rows.filter((r) => r.parent_id !== null)) {
    const list = groups.get(minor.parent_id as number) ?? []
    list.push(minor.sort_order)
    groups.set(minor.parent_id as number, list)
  }
  expect(groups.size).toBe(16)
  for (const orders of groups.values()) {
    const sorted = [...orders].sort((a, b) => a - b)
    expect(sorted).toEqual(sorted.map((_, i) => i))
  }
  db.close()
})

test('每个分类都有图标，没有空字符串', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  const blank = allRows(db).filter((r) => r.icon.trim() === '')
  expect(blank).toEqual([])
  db.close()
})

test('重复播种不会产生第二份（幂等）——用户每次启动程序都会跑一次', () => {
  const db = fresh()
  expect(seedBuiltinCategories(db)).toBe(96)
  expect(seedBuiltinCategories(db)).toBe(0)
  expect(seedBuiltinCategories(db)).toBe(0)
  expect(allRows(db)).toHaveLength(96)
  db.close()
})

test('用户删掉（归档）某个内置分类后再次启动，不会被强行恢复', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  db.exec("UPDATE categories SET is_archived = 1 WHERE builtin_key = 'expense/餐饮'")
  seedBuiltinCategories(db)
  const row = db
    .prepare("SELECT is_archived FROM categories WHERE builtin_key = 'expense/餐饮'")
    .get() as { is_archived: number }
  expect(row.is_archived).toBe(1)
  db.close()
})

test('用户改过名字后再次启动，名字不会被覆盖回默认值', () => {
  const db = fresh()
  seedBuiltinCategories(db)
  db.exec("UPDATE categories SET name = '吃饭' WHERE builtin_key = 'expense/餐饮'")
  seedBuiltinCategories(db)
  const row = db
    .prepare("SELECT name FROM categories WHERE builtin_key = 'expense/餐饮'")
    .get() as { name: string }
  expect(row.name).toBe('吃饭')
  db.close()
})

test('内置分类名称在同级之内不重复（否则用户会看到两个一样的）', () => {
  for (const major of BUILTIN_CATEGORIES) {
    const names = major.children.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  }
  const majorNames = BUILTIN_CATEGORIES.map((c) => `${c.kind}/${c.name}`)
  expect(new Set(majorNames).size).toBe(majorNames.length)
})

test('用户已经手动建过大类时，内置分类的排序号不会和它撞车', () => {
  const db = fresh()
  // 模拟「用户先自己建了一个大类，然后程序才播种内置分类」的极端顺序
  db.prepare(
    `INSERT INTO categories (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
     VALUES ('expense', NULL, '用户自建', '🐱', 0, 0, NULL, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  ).run()

  seedBuiltinCategories(db)

  const orders = (
    db
      .prepare("SELECT sort_order FROM categories WHERE kind = 'expense' AND parent_id IS NULL")
      .all() as unknown as Array<{ sort_order: number }>
  ).map((r) => r.sort_order)
  expect(new Set(orders).size).toBe(orders.length)
  expect(orders).toHaveLength(12)
  db.close()
})
