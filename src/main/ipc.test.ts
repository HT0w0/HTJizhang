import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { seedBuiltinCategories } from './db/seed'
import { categoryHandlers, statsHandlers, transactionHandlers } from './ipc'
import { CATEGORY_CHANNELS, STATS_CHANNELS, TRANSACTION_CHANNELS } from '@shared/ipcChannels'

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

// ---------------------------------------------------------------------------
// 第 4 阶段：账单列表 / 编辑 / 删除 的通道与处理器
// ---------------------------------------------------------------------------

test('账单处理器暴露了 list / update / remove / months', () => {
  const db = fresh()
  const h = transactionHandlers(db)
  expect(typeof h.list).toBe('function')
  expect(typeof h.update).toBe('function')
  expect(typeof h.remove).toBe('function')
  expect(typeof h.months).toBe('function')
  db.close()
})

test('list 成功时返回 ok:true', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.list({ month: '2026-10', kind: 'all', keyword: '' })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toEqual([])
  db.close()
})

test('list 失败时返回 ok:false，消息是中文且不带 Electron 的英文前缀', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.list({ month: '瞎写的', kind: 'all', keyword: '' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toMatch(/[一-鿿]/)
    expect(result.message).not.toContain('Error invoking remote method')
  }
  db.close()
})

test('remove 删不存在的账单时返回中文错误，而不是把异常漏出去', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.remove(999999)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('这笔账不存在')
  db.close()
})

test('update 改不存在的账单时返回中文错误', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.update({
    id: 999999,
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('这笔账不存在')
  db.close()
})

test('months 成功时返回数组', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  const result = await h.months()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toEqual([])
  db.close()
})

test('数据库关掉后，list / update / remove / months 也是 ok:false 而不是漏异常', async () => {
  const db = fresh()
  const h = transactionHandlers(db)
  db.close()

  for (const result of [
    await h.list({ month: '2026-10', kind: 'all', keyword: '' }),
    await h.update({
      id: 1,
      kind: 'expense',
      amountFen: 100,
      categoryId: 1,
      occurredOn: '2026-10-03',
      note: '',
      paymentMethod: 'wechat'
    }),
    await h.remove(1),
    await h.months()
  ]) {
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
  }
})

test('通道名和界面契约对得上（写错通道名不会报错，只会静默失效）', () => {
  expect(TRANSACTION_CHANNELS.list).toBe('transactions:list')
  expect(TRANSACTION_CHANNELS.update).toBe('transactions:update')
  expect(TRANSACTION_CHANNELS.remove).toBe('transactions:remove')
  expect(TRANSACTION_CHANNELS.months).toBe('transactions:months')
})

test('每个账单通道名都唯一（重复会让两个功能接到同一个处理器上）', () => {
  const names = Object.values(TRANSACTION_CHANNELS)
  expect(new Set(names).size).toBe(names.length)
})

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

test('统计页取数走通：这个月没记账时也给得出结果，不是报错', async () => {
  const db = fresh()
  const h = statsHandlers(db)

  const result = await h.overview('2026-10')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.month).toBe('2026-10')
    expect(result.value.expenseFen).toBe(0)
    expect(result.value.incomeFen).toBe(0)
    expect(result.value.majors).toEqual([])
    // 趋势图即使一笔账都没有也要给满 12 个月 —— 否则横轴是空的，用户以为图坏了
    expect(result.value.trend).toHaveLength(12)
  }
  db.close()
})

test('统计的数字和刚记的账对得上（界面拿到的是同一批账算出来的）', async () => {
  const db = fresh()
  const t = transactionHandlers(db)
  await t.create({
    kind: 'expense',
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '午饭',
    paymentMethod: 'wechat'
  })
  await t.create({
    kind: 'income',
    amountFen: 800000,
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    occurredOn: '2026-10-05',
    note: '',
    paymentMethod: 'bank'
  })

  const result = await statsHandlers(db).overview('2026-10')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.expenseFen).toBe(2850)
    expect(result.value.incomeFen).toBe(800000)
    expect(result.value.netFen).toBe(797150)
    expect(result.value.count).toBe(2)
    expect(result.value.majors.map((m) => m.name)).toEqual(['餐饮'])
    expect(result.value.trend[11].expenseFen).toBe(2850)
  }
  db.close()
})

test('月份格式不对时给用户一句中文，而不是把 SQL 的错误甩出去', async () => {
  const db = fresh()
  const result = await statsHandlers(db).overview('2026-13')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
  db.close()
})

test('数据库关掉后取统计也是 ok:false 而不是漏异常', async () => {
  const db = fresh()
  const h = statsHandlers(db)
  db.close()

  const result = await h.overview('2026-10')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
})

test('统计通道名和界面契约对得上（写错通道名不会报错，只会静默失效）', () => {
  expect(STATS_CHANNELS.overview).toBe('stats:overview')
})

test('统计通道名唯一（重复会让两个功能接到同一个处理器上）', () => {
  const names = Object.values(STATS_CHANNELS)
  expect(new Set(names).size).toBe(names.length)
})

test('三个模块的通道名互不重名（跨模块重名会静默串线）', () => {
  const all = [
    ...Object.values(CATEGORY_CHANNELS),
    ...Object.values(TRANSACTION_CHANNELS),
    ...Object.values(STATS_CHANNELS)
  ]
  expect(new Set(all).size).toBe(all.length)
})
