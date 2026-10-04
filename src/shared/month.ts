/**
 * 月份工具。
 *
 * 全项目约定：月份一律写成 'YYYY-MM' 字符串，与日期串 'YYYY-MM-DD' 同源。
 * 为什么不存成数字或 Date 对象：字符串的字典序就是时间序，
 * SQL 里可以直接 `occurred_on >= '2026-10-01' AND occurred_on <= '2026-10-31'`，
 * 不需要任何转换，也就没有转换出错的机会。
 *
 * ⚠️ 本文件的任何函数都不得使用 `toISOString()` 取当前月份 ——
 * 那取的是 UTC 的年月，北京时间 10 月 1 日早上 8 点时会算成 9 月。
 */
const MONTH_RE = /^(\d{4})-(\d{2})$/

/** 取「这个月」的年月串。now 参数只为测试而存在。 */
export function currentMonth(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function parseMonth(text: string): { y: number; m: number } | null {
  const matched = MONTH_RE.exec(text)
  if (!matched) return null
  const y = Number(matched[1])
  const m = Number(matched[2])
  if (m < 1 || m > 12) return null
  return { y, m }
}

/** 校验是不是严格的 'YYYY-MM'，且月份在 1..12 之间。 */
export function isValidMonth(text: string): boolean {
  return parseMonth(text) !== null
}

/** 从 'YYYY-MM-DD' 取 'YYYY-MM'。非法日期返回空串。 */
export function monthOfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  return date.slice(0, 7)
}

/**
 * 月份加减。delta 可以是负数。
 *
 * 用「总月数」换算而不是分别加减年月：直接对月份做加法要处理进位和借位，
 * 而换算成「从公元 0 年 1 月起算的第几个月」之后，进退位就只是普通的整数加减。
 * Math.floor 是必需的 —— 负数除法（-1 / 12）会向零取整，跨年时会算错。
 */
export function shiftMonth(month: string, delta: number): string {
  const parts = parseMonth(month)
  if (!parts) throw new Error(`月份格式不对，应该是 2026-10 这样（收到「${month}」）`)
  if (!Number.isInteger(delta)) throw new Error('月份偏移量必须是整数')

  const total = parts.y * 12 + (parts.m - 1) + delta
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`
}

/**
 * 当月的首尾两天。
 *
 * 「下个月的第 0 天」就是本月最后一天 —— 这是 Date 的既有行为，
 * 用 UTC 构造是为了不受本地时区影响（本地构造在部分时区的历史夏令时上会偏一天）。
 */
export function monthRange(month: string): { readonly start: string; readonly end: string } {
  const parts = parseMonth(month)
  if (!parts) throw new Error(`月份格式不对，应该是 2026-10 这样（收到「${month}」）`)

  const lastDay = new Date(Date.UTC(parts.y, parts.m, 0)).getUTCDate()
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`
  }
}

/** 显示成人看得懂的样子：2026-10 → 2026年10月。非法输入原样返回。 */
export function formatMonthForDisplay(month: string): string {
  const parts = parseMonth(month)
  if (!parts) return month
  return `${parts.y}年${parts.m}月`
}
