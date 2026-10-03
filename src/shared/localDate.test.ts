import { test, expect } from 'vitest'
import {
  todayLocal,
  isValidLocalDate,
  formatLocalDateForDisplay,
  localDateWeekday
} from './localDate'

test('todayLocal 用本地时区，不是 UTC', () => {
  // 2026-10-03 23:30 UTC 在东八区已经是 10-04 了。
  // 用 toISOString().slice(0,10) 会错算成 10-03 —— 这正是 CLAUDE.md §5.2 要避免的。
  const utcLate = new Date('2026-10-03T23:30:00Z')
  const expected = [
    utcLate.getFullYear(),
    String(utcLate.getMonth() + 1).padStart(2, '0'),
    String(utcLate.getDate()).padStart(2, '0')
  ].join('-')
  expect(todayLocal(utcLate)).toBe(expected)
})

test('todayLocal 对凌晨时刻也正确', () => {
  const early = new Date('2026-01-05T00:10:00')
  expect(todayLocal(early)).toBe('2026-01-05')
})

test('todayLocal 月份和日期都补零', () => {
  expect(todayLocal(new Date('2026-03-07T12:00:00'))).toBe('2026-03-07')
})

test('todayLocal 结果一定是 YYYY-MM-DD 的形状', () => {
  expect(todayLocal(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('isValidLocalDate 接受规范日期', () => {
  expect(isValidLocalDate('2026-10-03')).toBe(true)
  expect(isValidLocalDate('2026-01-01')).toBe(true)
  expect(isValidLocalDate('2024-02-29')).toBe(true) // 闰年
})

test('isValidLocalDate 拒绝不规范写法', () => {
  expect(isValidLocalDate('2026-1-3')).toBe(false)
  expect(isValidLocalDate('2026/10/03')).toBe(false)
  expect(isValidLocalDate('2026-10-03T00:00:00Z')).toBe(false)
  expect(isValidLocalDate('')).toBe(false)
})

test('isValidLocalDate 拒绝日历上不存在的日期', () => {
  expect(isValidLocalDate('2026-02-30')).toBe(false)
  expect(isValidLocalDate('2026-13-01')).toBe(false)
  expect(isValidLocalDate('2025-02-29')).toBe(false) // 平年
})

test('formatLocalDateForDisplay 显示成中文习惯的样子', () => {
  expect(formatLocalDateForDisplay('2026-10-03')).toBe('2026年10月3日')
  expect(formatLocalDateForDisplay('2026-01-05')).toBe('2026年1月5日')
})

test('formatLocalDateForDisplay 对非法输入原样返回，不崩', () => {
  expect(formatLocalDateForDisplay('乱写的')).toBe('乱写的')
  expect(formatLocalDateForDisplay('')).toBe('')
})

test('localDateWeekday 给出星期几', () => {
  expect(localDateWeekday('2026-10-03')).toBe('星期六')
  expect(localDateWeekday('2026-10-04')).toBe('星期日')
  expect(localDateWeekday('2026-10-05')).toBe('星期一')
})

test('localDateWeekday 对非法输入返回空串，不崩', () => {
  expect(localDateWeekday('乱写的')).toBe('')
})

test('星期几的算法不受本地时区影响', () => {
  // 用 new Date('2026-10-03') 会被当成 UTC 零点，东八区是当天 08:00，
  // 西半球则会变成前一天。这里断言算法在任何时区下都给同一天。
  expect(localDateWeekday('2026-01-01')).toBe('星期四')
  expect(localDateWeekday('2026-12-31')).toBe('星期四')
})
