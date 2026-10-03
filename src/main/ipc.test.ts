import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { seedBuiltinCategories } from './db/seed'
import { categoryHandlers } from './ipc'

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

test('底层抛出的非 Error 对象也被兜住，不会把空字符串当消息传出去', async () => {
  const db = fresh()
  const h = categoryHandlers(db)
  db.close() // 关掉连接，让后续调用必然失败
  const result = await h.list()
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
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
