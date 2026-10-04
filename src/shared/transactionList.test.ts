import { test, expect } from 'vitest'
import type { TransactionListItem } from './types'
import {
  groupByDay,
  sumByKind,
  normalizeKeyword,
  escapeLikePattern,
  summaryRows,
  emptyHint,
  MAX_KEYWORD_LENGTH
} from './transactionList'

function item(
  id: number,
  occurredOn: string,
  amountFen: number,
  kind: 'expense' | 'income' = 'expense',
  categoryName = '午餐',
  majorName = '餐饮'
): TransactionListItem {
  return {
    id,
    kind,
    amountFen,
    categoryId: 1,
    occurredOn,
    note: '',
    paymentMethod: 'wechat',
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    categoryName,
    categoryArchived: false,
    majorName,
    majorIcon: '🍜'
  }
}

test('groupByDay 同一天的聚成一组', () => {
  const groups = groupByDay([item(1, '2026-10-03', 100), item(2, '2026-10-03', 200)])
  expect(groups).toHaveLength(1)
  expect(groups[0].date).toBe('2026-10-03')
  expect(groups[0].items).toHaveLength(2)
})

test('groupByDay 保持传入的顺序（同一天内后记的在前）', () => {
  const groups = groupByDay([item(9, '2026-10-03', 100), item(8, '2026-10-03', 200)])
  expect(groups[0].items.map((i) => i.id)).toEqual([9, 8])
})

test('groupByDay 各组的先后顺序，跟着每个日期第一次出现的位置走', () => {
  // 本函数**不排序** —— 排序是 SQL 的 `ORDER BY occurred_on DESC, id DESC` 负责的。
  // 同一天内的先后顺序也只有 SQL 知道（它按 id 倒序），
  // 所以这里必须原样保留传入顺序，不能自作主张重排。
  const groups = groupByDay([
    item(1, '2026-10-05', 100),
    item(2, '2026-10-03', 100),
    item(3, '2026-10-04', 100)
  ])
  expect(groups.map((g) => g.date)).toEqual(['2026-10-05', '2026-10-03', '2026-10-04'])
})

test('groupByDay 传入已排好序的数据时，输出的日期就是从新到旧', () => {
  // 这才是真实调用场景：SQL 已经按日期倒序排好了
  const groups = groupByDay([
    item(3, '2026-10-05', 100),
    item(2, '2026-10-04', 100),
    item(1, '2026-10-03', 100)
  ])
  expect(groups.map((g) => g.date)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03'])
})

test('groupByDay 算出每天的支出、收入小计', () => {
  const groups = groupByDay([
    item(1, '2026-10-03', 1000, 'expense'),
    item(2, '2026-10-03', 2500, 'expense'),
    item(3, '2026-10-03', 300000, 'income')
  ])
  expect(groups[0].expenseFen).toBe(3500)
  expect(groups[0].incomeFen).toBe(300000)
})

test('groupByDay 某天只有收入时支出小计是 0（不是 undefined）', () => {
  const groups = groupByDay([item(1, '2026-10-03', 300000, 'income')])
  expect(groups[0].expenseFen).toBe(0)
  expect(groups[0].incomeFen).toBe(300000)
})

test('groupByDay 空输入返回空数组', () => {
  expect(groupByDay([])).toEqual([])
})

test('groupByDay 不修改传入的数组', () => {
  const input = [item(1, '2026-10-03', 100)]
  const copy = [...input]
  groupByDay(input)
  expect(input).toEqual(copy)
})

test('sumByKind 汇总支出、收入和结余', () => {
  const totals = sumByKind([
    item(1, '2026-10-03', 1000, 'expense'),
    item(2, '2026-10-03', 2500, 'expense'),
    item(3, '2026-10-03', 300000, 'income')
  ])
  expect(totals.expenseFen).toBe(3500)
  expect(totals.incomeFen).toBe(300000)
  expect(totals.netFen).toBe(296500)
})

test('sumByKind 结余可以是负数（花得比赚得多）', () => {
  const totals = sumByKind([
    item(1, '2026-10-03', 5000, 'expense'),
    item(2, '2026-10-03', 100, 'income')
  ])
  expect(totals.netFen).toBe(-4900)
})

test('sumByKind 空输入全是 0', () => {
  expect(sumByKind([])).toEqual({ expenseFen: 0, incomeFen: 0, netFen: 0 })
})

test('normalizeKeyword 去掉首尾空白并压掉中间连续空白', () => {
  expect(normalizeKeyword('  午餐  ')).toBe('午餐')
  expect(normalizeKeyword('麦当劳   午餐')).toBe('麦当劳 午餐')
})

test('normalizeKeyword 去掉换行（备注里存不了换行，搜索结果要和存的一致）', () => {
  expect(normalizeKeyword('午餐\n晚餐')).toBe('午餐 晚餐')
})

test('normalizeKeyword 保留全角字符原样（不能转半角，否则搜不到备注里的全角字）', () => {
  expect(normalizeKeyword('２８元')).toBe('２８元')
})

test('normalizeKeyword 超长截断到上限', () => {
  const long = '很'.repeat(MAX_KEYWORD_LENGTH + 50)
  expect(normalizeKeyword(long)).toHaveLength(MAX_KEYWORD_LENGTH)
})

test('escapeLikePattern 把 % 和 _ 转义（否则搜「50%」会命中全部账单）', () => {
  expect(escapeLikePattern('50%')).toBe('50\\%')
  expect(escapeLikePattern('a_b')).toBe('a\\_b')
})

test('escapeLikePattern 转义反斜杠本身', () => {
  expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
})

test('escapeLikePattern 普通中文原样返回', () => {
  expect(escapeLikePattern('午餐')).toBe('午餐')
})

test('escapeLikePattern 里的 % 不再有通配符含义（这是这个函数存在的唯一理由）', () => {
  const pattern = escapeLikePattern('%')
  expect(pattern).not.toBe('%')
})

// ---------- 底部的合计该显示哪几项 ----------
// 用户拍板的规则：「只看支出」时就只显示支出那一项。
// 原来三项都显示，筛成支出时收入会显示 0.00 —— 明明这个月有收入，
// 用户会读成「我这个月没有收入」。

test('summaryRows 看「全部」时，支出、收入、结余三项都显示', () => {
  const rows = summaryRows('all', { expenseFen: 21450, incomeFen: 800000, netFen: 778550 })
  expect(rows.map((r) => r.label)).toEqual(['支出', '收入', '结余'])
  expect(rows.map((r) => r.amountFen)).toEqual([21450, 800000, 778550])
})

test('summaryRows 筛「支出」时只显示支出，不显示收入和结余', () => {
  const rows = summaryRows('expense', { expenseFen: 21450, incomeFen: 800000, netFen: 778550 })
  expect(rows).toEqual([{ label: '支出', amountFen: 21450 }])
})

test('summaryRows 筛「收入」时只显示收入', () => {
  const rows = summaryRows('income', { expenseFen: 21450, incomeFen: 800000, netFen: 778550 })
  expect(rows).toEqual([{ label: '收入', amountFen: 800000 }])
})

test('summaryRows 筛出来的空月份显示 0.00，不是不显示', () => {
  const rows = summaryRows('expense', { expenseFen: 0, incomeFen: 0, netFen: 0 })
  expect(rows).toEqual([{ label: '支出', amountFen: 0 }])
})

// ---------- 空列表时该说什么 ----------
// 原来只判断「有没有搜索词」，于是筛成「只看支出」而当月只有收入时，
// 会说出「本月还没有记账」——和事实相反。

test('emptyHint 有搜索词时说「没找到」', () => {
  const hint = emptyHint('快餐', 'all', '2026年10月')
  expect(hint.title).toBe('没有找到包含「快餐」的账单')
})

test('emptyHint 有搜索词时，即使同时有筛选也说「没找到」', () => {
  const hint = emptyHint('快餐', 'expense', '2026年10月')
  expect(hint.title).toBe('没有找到包含「快餐」的账单')
})

test('emptyHint 筛「支出」而没搜索时说「没有支出记录」，不说「还没有记账」', () => {
  const hint = emptyHint('', 'expense', '2026年10月')
  expect(hint.title).toBe('2026年10月没有支出记录')
  expect(hint.title).not.toContain('还没有记账')
})

test('emptyHint 筛「收入」时说「没有收入记录」', () => {
  const hint = emptyHint('', 'income', '2026年10月')
  expect(hint.title).toBe('2026年10月没有收入记录')
})

test('emptyHint 什么都没筛、整月没账时才说「还没有记账」', () => {
  const hint = emptyHint('', 'all', '2026年10月')
  expect(hint.title).toBe('2026年10月还没有记账')
})

test('emptyHint 的月份文字由调用方给（本月可以传「这个月」）', () => {
  expect(emptyHint('', 'all', '这个月').title).toBe('这个月还没有记账')
})

test('emptyHint 整月没账时给一句下一步该干什么', () => {
  expect(emptyHint('', 'all', '2026年10月').hint).toContain('记一笔')
})

test('emptyHint 筛出来的空月份也给一句下一步（别让用户以为软件坏了）', () => {
  expect(emptyHint('', 'expense', '2026年10月').hint).not.toBe('')
})
