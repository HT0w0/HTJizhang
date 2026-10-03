import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { seedBuiltinCategories } from './db/seed'
import { categoryHandlers, transactionHandlers } from './ipc'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  seedBuiltinCategories(db)
  return db
}

function idOf(db: DatabaseSync, key: string): number {
  return (db.prepare('SELECT id FROM categories WHERE builtin_key = ?').get(key) as { id: number }).id
}

test('list 走通，返回 ok:true 且带 16 个大类', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  const result = await h.list()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toHaveLength(16)
  db.close()
})

test('失败时返回 ok:false 和干净的中文，不带 Electron 那串英文前缀', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  const result = await h.create({ kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('已存在')
    expect(result.message).not.toContain('Error invoking remote method')
    expect(result.message).not.toContain('Error:')
  }
  db.close()
})

test('数据库层的英文错误不会原样甩给用户（磁盘满/文件被锁时就会走到这里）', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  db.close() // 关掉连接，让后续调用抛出 SQLite 的英文错误 "database is not open"

  const result = await h.list()
  expect(result.ok).toBe(false)
  if (result.ok) return

  // 用户看不懂英文，消息里必须至少有一段中文说明
  expect(result.message).toMatch(/[一-鿿]/)
  // 但不能把英文原文丢掉——出了问题时这句话是唯一的排查线索
  expect(result.message).toContain('database is not open')
  expect(result.message).not.toMatch(/^database is not open$/)
})

test('底层抛出的非 Error 对象也被兜住，不会把空字符串或 undefined 当消息传出去', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  db.close()
  const result = await h.list()
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.message).not.toBe('undefined')
    expect(result.message).not.toBe('null')
  }
})

test('create → rename → setIcon → archive → listArchived → restore 一整条链路走通', async () => {
  const db = fresh()
  const h = categoryHandlers(db)

  const created = await h.create({ kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const id = created.value.id

  expect((await h.rename(id, '毛孩子')).ok).toBe(true)
  expect((await h.setIcon(id, '🐶')).ok).toBe(true)
  expect((await h.archive(id)).ok).toBe(true)

  const archived = await h.listArchived()
  expect(archived.ok).toBe(true)
  if (archived.ok) {
    expect(archived.value.map((n) => n.name)).toContain('毛孩子')
    expect(archived.value.find((n) => n.name === '毛孩子')!.icon).toBe('🐶')
  }

  expect((await h.restore(id)).ok).toBe(true)
  const tree = await h.list()
  if (tree.ok) expect(tree.value.map((n) => n.name)).toContain('毛孩子')

  db.close()
})

test('reorder 走通，顺序真的变了', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  const before = await h.list()
  if (!before.ok) throw new Error('前置失败')
  const ids = before.value.filter((n) => n.kind === 'expense').map((n) => n.id)
  const reversed = [...ids].reverse()

  expect((await h.reorder('expense', null, reversed)).ok).toBe(true)
  const after = await h.list()
  if (after.ok) {
    expect(
      after.value
        .filter((n) => n.kind === 'expense')
        .map((n) => n.id)
    ).toEqual(reversed)
  }
  db.close()
})

test('restoreBuiltins 走通', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  expect((await h.archive(idOf(db, 'expense/餐饮'))).ok).toBe(true)
  const restored = await h.restoreBuiltins()
  expect(restored.ok).toBe(true)
  const tree = await h.list()
  if (tree.ok) expect(tree.value.map((n) => n.name)).toContain('餐饮')
  db.close()
})

test('usage 在没有账单时返回空对象', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  const result = await h.usage()
  expect(result).toEqual({ ok: true, value: {} })
  db.close()
})

test('每个处理器在出错时都返回 ok:false，没有一个会把异常漏出去', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  db.close()

  const calls: Array<Promise<{ ok: boolean }>> = [
    h.list(),
    h.listArchived(),
    h.usage(),
    h.create({ kind: 'expense', parentId: null, name: 'x', icon: '❓' }),
    h.rename(1, 'y'),
    h.setIcon(1, '❓'),
    h.reorder('expense', null, []),
    h.archive(1),
    h.restore(1),
    h.restoreBuiltins()
  ]

  for (const call of calls) {
    const result = await call
    expect(result.ok).toBe(false)
  }
})

// ---------- 账单 ----------

test('记账走通，返回 ok:true 且带 id', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '午饭',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.id).toBeGreaterThan(0)
    expect(result.value.amountFen).toBe(2850)
  }
  db.close()
})

test('金额为 0 时返回干净中文，不带 Electron 英文前缀', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 0,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('金额')
    expect(result.message).not.toContain('Error')
  }
  db.close()
})

test('没选分类时提示是中文的「请先选择一个分类」', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 100,
    categoryId: 0,
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('请先选择一个分类')
  db.close()
})

test('today 返回合法的本地日期串', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.today()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  db.close()
})

test('recentCategoryIds 初始为空数组，记一笔后就有内容了', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  expect(await h.recentCategoryIds()).toEqual({ ok: true, value: [] })

  await h.create({
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/早餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'cash'
  })
  const after = await h.recentCategoryIds()
  expect(after.ok).toBe(true)
  if (after.ok) expect(after.value).toEqual([idOf(db, 'expense/餐饮/早餐')])
  db.close()
})

test('数据库关掉后，账单处理器也返回 ok:false 而不是把异常漏出去', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  db.close()
  const result = await h.recentCategoryIds()
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
})
