import { test, expect } from 'vitest'
import { buildDeleteWarning, buildTransactionDeleteWarning } from './deleteWarning'

test('小类、没记过账：说明还没记过账，不提账单去向', () => {
  const text = buildDeleteWarning({ name: '夜宵', childCount: 0, usage: 0 })
  expect(text).toContain('「夜宵」将被删除')
  expect(text).toContain('还没有记过账')
})

test('小类、有账单：必须讲清账单不会消失——这是用户最担心的一句', () => {
  const text = buildDeleteWarning({ name: '夜宵', childCount: 0, usage: 5 })
  expect(text).toContain('「夜宵」将被删除')
  expect(text).toContain('5 笔账单')
  expect(text).toContain('不会消失')
  expect(text).toContain('仍会照常显示和统计')
})

test('大类、下面有小类：说明会一起删除，并给出小类数量', () => {
  const text = buildDeleteWarning({ name: '餐饮', childCount: 9, usage: 0 })
  expect(text).toContain('「餐饮」')
  expect(text).toContain('还有 9 个小类')
  expect(text).toContain('一起删除')
})

test('大类、有小类且有账单：三个信息都要出现', () => {
  const text = buildDeleteWarning({ name: '餐饮', childCount: 9, usage: 23 })
  expect(text).toContain('还有 9 个小类')
  expect(text).toContain('一起删除')
  expect(text).toContain('23 笔账单')
  expect(text).toContain('不会消失')
})

test('无论哪种情况，都要告诉用户删错了能恢复', () => {
  const cases = [
    { name: 'A', childCount: 0, usage: 0 },
    { name: 'B', childCount: 0, usage: 3 },
    { name: 'C', childCount: 2, usage: 0 },
    { name: 'D', childCount: 2, usage: 7 }
  ]
  for (const c of cases) {
    expect(buildDeleteWarning(c)).toContain('恢复')
  }
})

test('无论哪种情况，都要提到「账」这件事（不能对账单去向只字不提）', () => {
  const cases = [
    { name: 'A', childCount: 0, usage: 0 },
    { name: 'B', childCount: 0, usage: 3 },
    { name: 'C', childCount: 2, usage: 0 },
    { name: 'D', childCount: 2, usage: 7 }
  ]
  for (const c of cases) {
    expect(buildDeleteWarning(c)).toContain('账')
  }
})

test('1 笔账时量词是「1 笔」而不是「1 笔账单」读起来别扭——仍要能读懂', () => {
  const text = buildDeleteWarning({ name: 'X', childCount: 0, usage: 1 })
  expect(text).toContain('1 笔账单')
})

test('分类名里有特殊字符也不会破坏文案', () => {
  const text = buildDeleteWarning({ name: '买&菜<🥬>', childCount: 0, usage: 0 })
  expect(text).toContain('买&菜<🥬>')
})

// ---------------------------------------------------------------------------
// 删除一笔账的确认文案
// ---------------------------------------------------------------------------

test('删一笔账：分类、金额、日期、备注都要出现，让用户认出删的是哪一笔', () => {
  const text = buildTransactionDeleteWarning({
    categoryName: '午餐',
    amountFen: 2800,
    occurredOn: '2026-10-04',
    note: '公司楼下快餐'
  })
  expect(text).toContain('午餐')
  expect(text).toContain('28.00 元')
  expect(text).toContain('2026年10月4日')
  expect(text).toContain('公司楼下快餐')
})

test('必须写清「无法恢复」——这是用户点下删除前读到的最后一句（用户 2026-10-04 拍板）', () => {
  const text = buildTransactionDeleteWarning({
    categoryName: '午餐',
    amountFen: 2800,
    occurredOn: '2026-10-04',
    note: ''
  })
  expect(text).toContain('删除后将无法恢复数据，请确认删除')
})

test('没备注时不留下多余的空格或占位符', () => {
  const text = buildTransactionDeleteWarning({
    categoryName: '午餐',
    amountFen: 2800,
    occurredOn: '2026-10-04',
    note: ''
  })
  const dateLine = text.split('\n').find((line) => line.includes('2026年10月4日'))
  expect(dateLine).toBe('2026年10月4日')
})

test('金额按元显示（带千分位），不是把「分」直接丢出来', () => {
  const text = buildTransactionDeleteWarning({
    categoryName: '买菜',
    amountFen: 123456,
    occurredOn: '2026-10-04',
    note: ''
  })
  // 千分位是项目里统一的金额写法（formatYuan），列表页和编辑弹窗都长这样，
  // 确认框里换成别的写法会让用户怀疑「这是不是同一笔钱」。
  expect(text).toContain('1,234.56 元')
  expect(text).not.toContain('123456')
})

test('分类名里带空格也不会和后面的金额粘成一片', () => {
  const text = buildTransactionDeleteWarning({
    categoryName: '聚餐 请客',
    amountFen: 100,
    occurredOn: '2026-10-04',
    note: ''
  })
  expect(text).toContain('聚餐 请客')
  expect(text).toContain('1.00 元')
})
