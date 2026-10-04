import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'
import { seedBuiltinCategories } from './seed'
import { createTransaction } from './transactions'
import { statsOverview } from './stats'
import { archiveCategory } from './categories'
import { recentMonths } from '@shared/stats'

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

function add(
  db: DatabaseSync,
  kind: 'expense' | 'income',
  yuan: number,
  categoryKey: string,
  occurredOn: string
): void {
  createTransaction(db, {
    kind,
    amountFen: Math.round(yuan * 100),
    categoryId: idOf(db, categoryKey),
    occurredOn,
    note: '',
    paymentMethod: 'wechat'
  })
}

// ---------------------------------------------------------------------------
// 空的状态
// ---------------------------------------------------------------------------

test('这个月一笔账都没有：数字全是 0，数组是空的，不抛错', () => {
  const db = fresh()
  const s = statsOverview(db, '2026-10')

  expect(s.month).toBe('2026-10')
  expect(s.expenseFen).toBe(0)
  expect(s.incomeFen).toBe(0)
  expect(s.netFen).toBe(0)
  expect(s.count).toBe(0)
  expect(s.majors).toEqual([])
  db.close()
})

test('没有账的月份，趋势图仍然给出 12 个月，缺的月份补 0 而不是缺一格', () => {
  const db = fresh()
  const s = statsOverview(db, '2026-10')

  expect(s.trend).toHaveLength(12)
  expect(s.trend.every((p) => p.expenseFen === 0 && p.incomeFen === 0)).toBe(true)
  db.close()
})

// ---------------------------------------------------------------------------
// 数字卡片
// ---------------------------------------------------------------------------

test('支出、收入、结余、笔数', () => {
  const db = fresh()
  add(db, 'expense', 28.5, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 120, 'expense/交通/打车网约车', '2026-10-04')
  add(db, 'income', 8000, 'income/工资薪酬/月薪', '2026-10-05')

  const s = statsOverview(db, '2026-10')
  expect(s.expenseFen).toBe(14850)
  expect(s.incomeFen).toBe(800000)
  expect(s.netFen).toBe(785150)
  expect(s.count).toBe(3)
  db.close()
})

test('结余可以是负数（花得比挣得多）', () => {
  const db = fresh()
  add(db, 'expense', 100, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'income', 30, 'income/工资薪酬/月薪', '2026-10-05')

  expect(statsOverview(db, '2026-10').netFen).toBe(-7000)
  db.close()
})

// ---------------------------------------------------------------------------
// 只算这个月 —— 边界日最容易错
// ---------------------------------------------------------------------------

test('别的月份的账一笔都不算进来', () => {
  const db = fresh()
  add(db, 'expense', 50, 'expense/餐饮/午餐', '2026-09-30')
  add(db, 'expense', 60, 'expense/餐饮/午餐', '2026-10-01')
  add(db, 'expense', 70, 'expense/餐饮/午餐', '2026-11-01')

  expect(statsOverview(db, '2026-10').expenseFen).toBe(6000)
  db.close()
})

test('当月第一天和最后一天都算本月', () => {
  const db = fresh()
  add(db, 'expense', 1, 'expense/餐饮/午餐', '2026-10-01')
  add(db, 'expense', 2, 'expense/餐饮/午餐', '2026-10-31')

  expect(statsOverview(db, '2026-10').expenseFen).toBe(300)
  db.close()
})

test('2 月只有 28 天时，28 号仍然算本月', () => {
  const db = fresh()
  add(db, 'expense', 9, 'expense/餐饮/午餐', '2026-02-28')

  expect(statsOverview(db, '2026-02').expenseFen).toBe(900)
  db.close()
})

// ---------------------------------------------------------------------------
// 大类 / 小类分组（饼图 + 排行 + 下钻）
// ---------------------------------------------------------------------------

test('按大类分组，列出名字和图标', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 20, 'expense/餐饮/晚餐', '2026-10-04')
  add(db, 'expense', 50, 'expense/交通/打车网约车', '2026-10-05')

  const s = statsOverview(db, '2026-10')
  const food = s.majors.find((m) => m.name === '餐饮')
  const traffic = s.majors.find((m) => m.name === '交通')

  expect(food?.amountFen).toBe(5000)
  expect(food?.icon).toBeTruthy()
  expect(traffic?.amountFen).toBe(5000)
  db.close()
})

test('同一大类下的两个小类分别列出来（排行点开能看小类占比）', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 20, 'expense/餐饮/晚餐', '2026-10-04')

  const food = statsOverview(db, '2026-10').majors.find((m) => m.name === '餐饮')
  expect(food?.children).toHaveLength(2)
  expect(food?.children.map((c) => c.name).sort()).toEqual(['午餐', '晚餐'])
  const lunch = food?.children.find((c) => c.name === '午餐')
  expect(lunch?.amountFen).toBe(3000)
  db.close()
})

test('大类的金额等于它名下小类之和（图上和列表里必须是同一个数）', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 20, 'expense/餐饮/晚餐', '2026-10-04')

  const food = statsOverview(db, '2026-10').majors.find((m) => m.name === '餐饮')
  const sum = (food?.children ?? []).reduce((acc, c) => acc + c.amountFen, 0)
  expect(sum).toBe(food?.amountFen)
  db.close()
})

test('所有大类金额之和等于卡片上的支出总额（对不上就是算错了）', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 20, 'expense/娱乐/电影演出', '2026-10-04')
  add(db, 'expense', 15, 'expense/交通/打车网约车', '2026-10-05')
  add(db, 'income', 8000, 'income/工资薪酬/月薪', '2026-10-06')

  const s = statsOverview(db, '2026-10')
  const sum = s.majors.reduce((acc, m) => acc + m.amountFen, 0)
  expect(sum).toBe(s.expenseFen)
  db.close()
})

test('大类按金额从大到小排（排行第一的应该是花得最多的）', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 90, 'expense/居住/房租', '2026-10-04')
  add(db, 'expense', 50, 'expense/交通/打车网约车', '2026-10-05')

  const names = statsOverview(db, '2026-10').majors.map((m) => m.name)
  expect(names).toEqual(['居住', '交通', '餐饮'])
  db.close()
})

test('小类也按金额从大到小排', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 90, 'expense/餐饮/晚餐', '2026-10-04')
  add(db, 'expense', 50, 'expense/餐饮/早餐', '2026-10-05')

  const food = statsOverview(db, '2026-10').majors.find((m) => m.name === '餐饮')
  expect(food?.children.map((c) => c.name)).toEqual(['晚餐', '早餐', '午餐'])
  db.close()
})

test('收入不进饼图和排行 —— 那两个图统计的是支出', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'income', 8000, 'income/工资薪酬/月薪', '2026-10-05')

  const s = statsOverview(db, '2026-10')
  expect(s.majors.map((m) => m.name)).toEqual(['餐饮'])
  expect(s.incomeFen).toBe(800000)
  db.close()
})

// ---------------------------------------------------------------------------
// 归档分类下的账单 —— 必须照常统计（§5.11）
// ---------------------------------------------------------------------------

test('⚠️ 分类被「删除」（归档）之后，它名下的账**仍然算进统计**', () => {
  const db = fresh()
  add(db, 'expense', 30, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'expense', 50, 'expense/交通/打车网约车', '2026-10-05')

  archiveCategory(db, idOf(db, 'expense/餐饮'))

  const s = statsOverview(db, '2026-10')
  expect(s.expenseFen).toBe(8000)
  expect(s.majors.map((m) => m.name).sort()).toEqual(['交通', '餐饮'])
  db.close()
})

// ---------------------------------------------------------------------------
// 趋势图
// ---------------------------------------------------------------------------

test('趋势图给出 12 个月，从旧到新，最后一个是当前看的月份', () => {
  const db = fresh()
  const s = statsOverview(db, '2026-10')

  expect(s.trend.map((p) => p.month)).toEqual(recentMonths('2026-10'))
  expect(s.trend[11].month).toBe('2026-10')
  expect(s.trend[0].month).toBe('2025-11')
  db.close()
})

test('每个月各自算自己的收支，没有账的月份是 0', () => {
  const db = fresh()
  add(db, 'expense', 10, 'expense/餐饮/午餐', '2025-11-15')
  add(db, 'expense', 20, 'expense/餐饮/午餐', '2026-10-03')
  add(db, 'income', 8000, 'income/工资薪酬/月薪', '2026-10-05')

  const s = statsOverview(db, '2026-10')
  const first = s.trend[0]
  const last = s.trend[11]

  expect(first.month).toBe('2025-11')
  expect(first.expenseFen).toBe(1000)
  expect(first.incomeFen).toBe(0)
  expect(last.expenseFen).toBe(2000)
  expect(last.incomeFen).toBe(800000)
  // 中间那些没账的月份
  expect(s.trend[5].expenseFen).toBe(0)
  expect(s.trend[5].incomeFen).toBe(0)
  db.close()
})

test('12 个月以外的账不进趋势图（但也不影响卡片数字的月份隔离）', () => {
  const db = fresh()
  add(db, 'expense', 99, 'expense/餐饮/午餐', '2025-10-15')
  add(db, 'expense', 10, 'expense/餐饮/午餐', '2026-10-03')

  const s = statsOverview(db, '2026-10')
  expect(s.trend.some((p) => p.month === '2025-10')).toBe(false)
  expect(s.trend.reduce((acc, p) => acc + p.expenseFen, 0)).toBe(1000)
  db.close()
})

test('跨年的趋势图：月份连得上，不重不漏', () => {
  const db = fresh()
  add(db, 'expense', 5, 'expense/餐饮/午餐', '2025-12-20')
  add(db, 'expense', 7, 'expense/餐饮/午餐', '2026-01-20')

  const s = statsOverview(db, '2026-02')
  const months = s.trend.map((p) => p.month)
  expect(months).toContain('2025-12')
  expect(months).toContain('2026-01')
  expect(months.filter((m) => m === '2025-12')).toHaveLength(1)
  expect(s.trend.find((p) => p.month === '2025-12')?.expenseFen).toBe(500)
  expect(s.trend.find((p) => p.month === '2026-01')?.expenseFen).toBe(700)
  db.close()
})
