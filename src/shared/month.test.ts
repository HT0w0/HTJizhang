import { test, expect } from 'vitest'
import {
  currentMonth,
  isValidMonth,
  monthOfDate,
  shiftMonth,
  monthRange,
  formatMonthForDisplay
} from './month'

test('currentMonth 取本地年月，两位数补零', () => {
  expect(currentMonth(new Date(2026, 9, 4))).toBe('2026-10') // 月份是 0 基的，9 = 十月
  expect(currentMonth(new Date(2026, 0, 1))).toBe('2026-01')
})

test('currentMonth 在跨零点时不受 UTC 影响', () => {
  // 本地 10 月 1 日 00:30，UTC 还是 9 月 30 日 16:30。
  // 用 toISOString 会得到 2026-09，用户的账会被算进上个月。
  const localMidnight = new Date(2026, 9, 1, 0, 30)
  expect(currentMonth(localMidnight)).toBe('2026-10')
})

test('isValidMonth 只认严格的 YYYY-MM', () => {
  expect(isValidMonth('2026-10')).toBe(true)
  expect(isValidMonth('2026-01')).toBe(true)
  expect(isValidMonth('2026-1')).toBe(false)
  expect(isValidMonth('2026-13')).toBe(false)
  expect(isValidMonth('2026-00')).toBe(false)
  expect(isValidMonth('2026/10')).toBe(false)
  expect(isValidMonth('2026-10-03')).toBe(false)
  expect(isValidMonth('')).toBe(false)
})

test('monthOfDate 从日期串取年月', () => {
  expect(monthOfDate('2026-10-03')).toBe('2026-10')
  expect(monthOfDate('2026-01-31')).toBe('2026-01')
})

test('monthOfDate 对非法日期返回空串', () => {
  expect(monthOfDate('2026/10/03')).toBe('')
  expect(monthOfDate('')).toBe('')
})

test('shiftMonth 往前一个月', () => {
  expect(shiftMonth('2026-10', -1)).toBe('2026-09')
  expect(shiftMonth('2026-01', -1)).toBe('2025-12') // 跨年
})

test('shiftMonth 往后一个月', () => {
  expect(shiftMonth('2026-10', 1)).toBe('2026-11')
  expect(shiftMonth('2026-12', 1)).toBe('2027-01') // 跨年
})

test('shiftMonth 闰年二月不特殊（月份运算与天数无关）', () => {
  expect(shiftMonth('2024-02', 0)).toBe('2024-02')
  expect(shiftMonth('2024-02', -1)).toBe('2024-01')
})

test('shiftMonth 跨多个月仍然正确', () => {
  expect(shiftMonth('2026-10', -13)).toBe('2025-09')
  expect(shiftMonth('2026-10', 14)).toBe('2027-12')
})

test('shiftMonth 对非法月份抛错，不静默返回垃圾', () => {
  expect(() => shiftMonth('2026-13', 1)).toThrow()
  expect(() => shiftMonth('2026-1', 1)).toThrow()
})

test('monthRange 给出当月首尾两天', () => {
  expect(monthRange('2026-10')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
  expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' }) // 闰年
  expect(monthRange('2026-04')).toEqual({ start: '2026-04-01', end: '2026-04-30' })
})

test('monthRange 的两个端点都是合法日期，且能拿来直接比较字符串', () => {
  const { start, end } = monthRange('2026-10')
  // 本地日期串的字典序就是时间序，所以 SQL 里可以直接 >= start AND <= end
  expect(start < '2026-10-01').toBe(false)
  expect(end >= '2026-10-31').toBe(true)
})

test('formatMonthForDisplay 显示成中文', () => {
  expect(formatMonthForDisplay('2026-10')).toBe('2026年10月')
  expect(formatMonthForDisplay('2026-01')).toBe('2026年1月') // 月份不补零
})
