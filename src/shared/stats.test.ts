import { test, expect } from 'vitest'
import {
  expenseChartHint,
  formatAxisYuan,
  formatPercent,
  percentageOf,
  recentMonths,
  staleStatsNotice,
  trendLabel
} from './stats'

// ---------------------------------------------------------------------------
// 最近 N 个月
// ---------------------------------------------------------------------------

test('默认给出 12 个月', () => {
  expect(recentMonths('2026-10')).toHaveLength(12)
})

test('从旧到新排，最后一个是传进来的那个月（图从左到右是时间往前走）', () => {
  const months = recentMonths('2026-10')
  expect(months[11]).toBe('2026-10')
  expect(months[0]).toBe('2025-11')
})

test('跨年往前数不会数错（2026-01 的 11 个月前是 2025-02）', () => {
  const months = recentMonths('2026-01')
  expect(months[0]).toBe('2025-02')
  expect(months[11]).toBe('2026-01')
})

test('跨年时中间的月份也接得上，没有跳过或重复', () => {
  const months = recentMonths('2026-02')
  expect(months).toEqual([
    '2025-03',
    '2025-04',
    '2025-05',
    '2025-06',
    '2025-07',
    '2025-08',
    '2025-09',
    '2025-10',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02'
  ])
})

test('可以只取 1 个月', () => {
  expect(recentMonths('2026-10', 1)).toEqual(['2026-10'])
})

test('月份格式不对就报错，不悄悄返回一堆空串', () => {
  expect(() => recentMonths('2026-13')).toThrow()
  expect(() => recentMonths('')).toThrow()
})

// ---------------------------------------------------------------------------
// 占比
// ---------------------------------------------------------------------------

test('占比按百分数算，保留一位小数', () => {
  expect(percentageOf(50, 100)).toBe(50)
  expect(percentageOf(1, 3)).toBe(33.3)
  expect(percentageOf(2, 3)).toBe(66.7)
})

test('总额是 0 时占比是 0，不能是 NaN —— 界面上会显示成「NaN%」', () => {
  expect(percentageOf(0, 0)).toBe(0)
  expect(Number.isNaN(percentageOf(0, 0))).toBe(false)
})

test('总额是 0 但分子不是 0 时也返回 0（不该出现，但不能算出个天文数字）', () => {
  expect(percentageOf(500, 0)).toBe(0)
  expect(Number.isFinite(percentageOf(500, 0))).toBe(true)
})

test('全部就是它自己时是 100', () => {
  expect(percentageOf(1234, 1234)).toBe(100)
})

test('占 0% 就显示 0%，不要显示成 0.04% 这种噪音', () => {
  expect(formatPercent(percentageOf(1, 100000))).toBe('0%')
})

test('显示的百分比：整数不带小数点，小数保留一位', () => {
  expect(formatPercent(100)).toBe('100%')
  expect(formatPercent(0)).toBe('0%')
  expect(formatPercent(33.3)).toBe('33.3%')
})

// ---------------------------------------------------------------------------
// 趋势图的横轴标签
// ---------------------------------------------------------------------------

test('横轴标签是「几月」', () => {
  expect(trendLabel('2026-10')).toBe('10月')
  expect(trendLabel('2026-01')).toBe('1月')
})

test('横轴标签遇到不合法的月份原样返回，不抛错（图表不该因为一个标签崩掉）', () => {
  expect(trendLabel('乱七八糟')).toBe('乱七八糟')
})

// ---------------------------------------------------------------------------
// 饼图 / 排行没有内容时说什么
// ---------------------------------------------------------------------------

const monthLabel = '2026年10月'

test('这个月一笔账都没记：说还没记账，并指路去记一笔', () => {
  const hint = expenseChartHint({
    monthLabel,
    transactionCount: 0,
    expenseFen: 0,
    incomeFen: 0
  })
  expect(hint.title).toContain('还没有记账')
  expect(hint.hint).toContain('记一笔')
})

test('记了账但全是收入：绝不能说「还没有记账」——用户明明记了', () => {
  const hint = expenseChartHint({
    monthLabel,
    transactionCount: 3,
    expenseFen: 0,
    incomeFen: 800000
  })
  expect(hint.title).not.toContain('还没有记账')
  expect(hint.title).toContain('没有支出')
})

test('全是收入时要说清为什么图是空的（因为统计的是支出），否则用户以为坏了', () => {
  const hint = expenseChartHint({
    monthLabel,
    transactionCount: 3,
    expenseFen: 0,
    incomeFen: 800000
  })
  expect(hint.hint).toContain('支出')
})

test('有支出时不该给空状态文案（文案只在图没内容时用，但函数本身也要给对）', () => {
  const hint = expenseChartHint({
    monthLabel,
    transactionCount: 5,
    expenseFen: 12345,
    incomeFen: 800000
  })
  expect(hint.title).toBe('')
  expect(hint.hint).toBe('')
})

test('两种空状态的文案不一样，用户能分辨自己遇到的是哪一种', () => {
  const a = expenseChartHint({ monthLabel, transactionCount: 0, expenseFen: 0, incomeFen: 0 })
  const b = expenseChartHint({
    monthLabel,
    transactionCount: 2,
    expenseFen: 0,
    incomeFen: 100
  })
  expect(a.title).not.toBe(b.title)
})

// ---------------------------------------------------------------------------
// 纵轴刻度上的金额
// ---------------------------------------------------------------------------

test('纵轴刻度用「元」，不是「分」—— 把分直接写上去，数字会大 100 倍', () => {
  expect(formatAxisYuan(800000)).toBe('8,000')
})

test('纵轴刻度不带小数（刻度线上拖两位小数是纯噪音）', () => {
  expect(formatAxisYuan(123456)).toBe('1,235')
  expect(formatAxisYuan(100)).toBe('1')
})

test('纵轴刻度从 0 开始（没有账的月份）', () => {
  expect(formatAxisYuan(0)).toBe('0')
  // 比不出数字时也得给个能看的，不能把 NaN 写到刻度上
  expect(formatAxisYuan(Number.NaN)).toBe('0')
})

test('金额大到上万就换成「万」，否则刻度会被挤成一团', () => {
  expect(formatAxisYuan(1000000)).toBe('1万')
  expect(formatAxisYuan(12300000)).toBe('12.3万')
  expect(formatAxisYuan(100000000)).toBe('100万')
})

test('刚好不到一万的仍然按元写（8,000 元和 1 万元的区别一目了然）', () => {
  expect(formatAxisYuan(999900)).toBe('9,999')
  // 9,999.99 元四舍五入成 10,000。刻度上不会出现这种数，
  // 这一条只是把「四舍五入」这件事钉住，免得以后有人改成截断。
  expect(formatAxisYuan(999999)).toBe('10,000')
})

test('负的刻度也认（结余柱状图可能用到）', () => {
  expect(formatAxisYuan(-50000)).toBe('-500')
})

// ---------------------------------------------------------------------------
// 取数失败时的说明文案
// ---------------------------------------------------------------------------

test('取数没失败就什么都不说', () => {
  expect(staleStatsNotice({ dataMonth: '2026-10', shownMonth: '2026-10', failed: true })).toBe('')
})

test('翻到别的月份但取数失败时，说清下面显示的还是哪个月的数据', () => {
  // 这是本函数存在的唯一理由：翻到 9 月但取数失败时，界面若只换个标题、
  // 数字还是 10 月的，用户看到的是「9 月支出 300 元」—— 一个错月份的正确数字，
  // 当场看不出来。文案必须把「下面显示的是几月」说清楚。
  const notice = staleStatsNotice({ dataMonth: '2026-10', shownMonth: '2026-09', failed: true })
  expect(notice).toContain('2026年10月')
  expect(notice).toContain('2026年9月')
})

test('正在加载、只是月份还没跟上时**不能**说数据过期', () => {
  // 这条是修「翻月时闪一下『取不到 X 月的数据』」留下的（用户 2026-10-04 反馈）。
  // 点「‹」的那一刻月份 state 就已经变成 9 月了，数据要等几十毫秒才回来 ——
  // 中间这段时间 overview.month 还是 10 月。光看「月份对不上」的话，
  // 一条假提示就会闪出来再消失。所以判据里必须有「这次确实是失败了」。
  expect(staleStatsNotice({ dataMonth: '2026-10', shownMonth: '2026-09', failed: false })).toBe('')
})

test('还没成功取到过任何数据时不解释（没得解释）', () => {
  expect(staleStatsNotice({ dataMonth: '', shownMonth: '2026-09', failed: true })).toBe('')
  expect(staleStatsNotice({ dataMonth: '2026-10', shownMonth: '', failed: true })).toBe('')
})
