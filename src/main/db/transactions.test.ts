import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'
import { seedBuiltinCategories } from './seed'
import {
  createTransaction,
  getTransaction,
  recentCategoryIds,
  DEFAULT_RECENT_LIMIT
} from './transactions'

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

function valid(db: DatabaseSync) {
  return {
    kind: 'expense' as const,
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '公司楼下快餐',
    paymentMethod: 'wechat' as const
  }
}

test('记一笔支出，字段都原样存下来', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  expect(created.id).toBeGreaterThan(0)
  expect(created.kind).toBe('expense')
  expect(created.amountFen).toBe(2850)
  expect(created.note).toBe('公司楼下快餐')
  expect(created.paymentMethod).toBe('wechat')
  expect(created.occurredOn).toBe('2026-10-03')
  expect(created.categoryId).toBe(idOf(db, 'expense/餐饮/午餐'))
  db.close()
})

test('记一笔收入', () => {
  const db = fresh()
  const created = createTransaction(db, {
    ...valid(db),
    kind: 'income',
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    amountFen: 1500000,
    note: ''
  })
  expect(created.kind).toBe('income')
  expect(created.amountFen).toBe(1500000)
  db.close()
})

test('金额以「分」存，12.34 元存成 1234（不是 12.34）', () => {
  const db = fresh()
  createTransaction(db, { ...valid(db), amountFen: 1234 })
  const raw = db.prepare('SELECT amount_fen FROM transactions').get() as { amount_fen: number }
  expect(raw.amount_fen).toBe(1234)
  expect(Number.isInteger(raw.amount_fen)).toBe(true)
  db.close()
})

test('金额必须是正整数：0 和负数被拒绝', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), amountFen: 0 })).toThrow()
  expect(() => createTransaction(db, { ...valid(db), amountFen: -100 })).toThrow()
  db.close()
})

test('金额必须是整数分，小数被拒绝（防止有人传 12.34 进来）', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), amountFen: 12.34 })).toThrow()
  db.close()
})

test('没选分类会被拒绝，并给中文提示', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: 0 })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('挂到一级大类上被拒绝，且提示是「选到更具体的小类」', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: idOf(db, 'expense/餐饮') })
  } catch (e) {
    message = (e as Error).message
  }
  // 注意：不能只断言「会抛错」——数据库的触发器也会抛错，
  // 那我们就分不清是仓储层拦下的还是数据库拦下的，也就无法确认
  // 用户看到的是不是这句中文。所以必须断言具体措辞。
  expect(message).toContain('更具体的小类')
  db.close()
})

test('收支类型与分类不一致被拒绝，且提示说清是哪边错', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, {
      ...valid(db),
      kind: 'expense',
      categoryId: idOf(db, 'income/工资薪酬/月薪')
    })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('支出不能记在收入分类下')
  db.close()
})

test('日期不合法被拒绝，提示里说清格式要求', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), occurredOn: '2026/10/03' })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('日期')
  db.close()
})

test('支付方式不合法被拒绝', () => {
  const db = fresh()
  expect(() =>
    createTransaction(db, { ...valid(db), paymentMethod: 'bitcoin' as never })
  ).toThrow()
  db.close()
})

test('备注超长被拒绝（防止一屏塞不下）', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), note: '啊'.repeat(201) })).toThrow()
  db.close()
})

test('备注恰好 200 字通过', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), note: '啊'.repeat(200) })).not.toThrow()
  db.close()
})

test('备注首尾空格被去掉', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '  午饭  ' })
  expect(created.note).toBe('午饭')
  db.close()
})

test('备注可以不填', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '' })
  expect(created.note).toBe('')
  db.close()
})

test('备注里的换行被压成空格（账单列表每行只占一行）', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '第一行\n第二行' })
  expect(created.note).toBe('第一行 第二行')
  db.close()
})

test('归档掉的分类不能再用来记账', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  db.exec(`UPDATE categories SET is_archived = 1 WHERE id = ${lunch}`)
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: lunch })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('写入失败时不留半条记录（事务整体回滚）', () => {
  const db = fresh()
  const before = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(() => createTransaction(db, { ...valid(db), occurredOn: '乱写' })).toThrow()
  const after = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(after).toBe(before)
  db.close()
})

test('created_at / updated_at 会写上，且是合法的 ISO 时间串', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const raw = db
    .prepare('SELECT created_at, updated_at FROM transactions WHERE id = ?')
    .get(created.id) as { created_at: string; updated_at: string }
  expect(raw.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(raw.updated_at).toBe(raw.created_at)
  db.close()
})

test('occurred_on 存的是本地日期串，不带时间部分', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const raw = db
    .prepare('SELECT occurred_on FROM transactions WHERE id = ?')
    .get(created.id) as { occurred_on: string }
  expect(raw.occurred_on).toBe('2026-10-03')
  expect(raw.occurred_on).not.toContain('T')
  db.close()
})

test('getTransaction 能读回来', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(getTransaction(db, created.id)).toEqual(created)
  db.close()
})

test('getTransaction 对不存在的 id 返回 undefined', () => {
  const db = fresh()
  expect(getTransaction(db, 999999)).toBeUndefined()
  db.close()
})

test('连记两笔互不影响（保存后能接着记下一笔）', () => {
  const db = fresh()
  const a = createTransaction(db, valid(db))
  const b = createTransaction(db, { ...valid(db), amountFen: 3600, note: '咖啡' })
  expect(a.id).not.toBe(b.id)
  const n = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(n).toBe(2)
  db.close()
})

// ---------- 最近用过的分类 ----------

function insertRaw(
  db: DatabaseSync,
  categoryId: number,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', 100, ?, '2026-10-03', '', 'wechat', ?, ?)`
  ).run(categoryId, createdAt, createdAt)
}

test('recentCategoryIds：没记过账时返回空数组', () => {
  const db = fresh()
  expect(recentCategoryIds(db)).toEqual([])
  db.close()
})

test('recentCategoryIds：按最近使用的先后返回，最近的在最前', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const taxi = idOf(db, 'expense/交通/打车网约车')

  insertRaw(db, breakfast, '2026-10-03T01:00:00.000Z')
  insertRaw(db, lunch, '2026-10-03T02:00:00.000Z')
  insertRaw(db, taxi, '2026-10-03T03:00:00.000Z')

  expect(recentCategoryIds(db)).toEqual([taxi, lunch, breakfast])
  db.close()
})

test('recentCategoryIds：同一个分类记多次只出现一次，按最后一次算', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  const lunch = idOf(db, 'expense/餐饮/午餐')

  insertRaw(db, lunch, '2026-10-03T01:00:00.000Z')
  insertRaw(db, breakfast, '2026-10-03T02:00:00.000Z')
  insertRaw(db, lunch, '2026-10-03T03:00:00.000Z') // 午餐最后一次比早餐晚

  expect(recentCategoryIds(db)).toEqual([lunch, breakfast])
  db.close()
})

test('recentCategoryIds：尊重 limit', () => {
  const db = fresh()
  insertRaw(db, idOf(db, 'expense/餐饮/早餐'), '2026-10-03T01:00:00.000Z')
  insertRaw(db, idOf(db, 'expense/餐饮/午餐'), '2026-10-03T02:00:00.000Z')
  insertRaw(db, idOf(db, 'expense/餐饮/晚餐'), '2026-10-03T03:00:00.000Z')
  expect(recentCategoryIds(db, 2)).toHaveLength(2)
  expect(recentCategoryIds(db, 2)).toEqual([
    idOf(db, 'expense/餐饮/晚餐'),
    idOf(db, 'expense/餐饮/午餐')
  ])
  db.close()
})

test('recentCategoryIds：默认 limit 是正整数', () => {
  expect(Number.isInteger(DEFAULT_RECENT_LIMIT)).toBe(true)
  expect(DEFAULT_RECENT_LIMIT).toBeGreaterThan(0)
})

test('新记的一笔会立刻变成「最近用过」的第一个（保存后重新打开记账页就能看到它置顶）', () => {
  const db = fresh()
  const first = createTransaction(db, valid(db))
  expect(recentCategoryIds(db)[0]).toBe(first.categoryId)
  db.close()
})
