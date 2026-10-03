/**
 * 本地日期工具。
 *
 * 全项目约定：日期一律存本地日期字符串 'YYYY-MM-DD'，绝不存 UTC 时间戳
 * （CLAUDE.md §5.2）。原因：存时间戳的话，GMT+8 用户的「本月」统计会在
 * 跨月边界算错，而且错得悄无声息。
 *
 * ⚠️ 绝对不要用 `new Date().toISOString().slice(0, 10)` 取「今天」——
 * 那取的是 UTC 的今天。北京时间 8 月 1 日早上 7 点时，UTC 还是 7 月 31 日，
 * 用户记的账会被算进上个月。
 */

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/**
 * 取「今天」的本地日期串。
 *
 * now 参数只为测试而存在，正常调用不传。
 */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

interface DateParts {
  readonly y: number
  readonly m: number
  readonly d: number
  readonly weekdayIndex: number
}

/**
 * 拆解日期串。不是严格合法的日期则返回 null。
 *
 * 用 UTC 构造一次再比对各个部分，能同时排掉 2 月 30 日、平年 2 月 29 日
 * 这类「格式对但日历上不存在」的日期。用 UTC 是为了不受本地时区影响 ——
 * 用本地时间构造的话，某些时区的历史夏令时会让结果偏一天。
 */
function parseParts(text: string): DateParts | null {
  const matched = LOCAL_DATE_RE.exec(text)
  if (!matched) return null

  const y = Number(matched[1])
  const m = Number(matched[2])
  const d = Number(matched[3])
  if (m < 1 || m > 12 || d < 1 || d > 31) return null

  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null
  }

  return { y, m, d, weekdayIndex: probe.getUTCDay() }
}

/** 校验是不是严格的 'YYYY-MM-DD'，且是日历上真实存在的日期。 */
export function isValidLocalDate(text: string): boolean {
  return parseParts(text) !== null
}

/** 显示成人看得懂的样子：2026-10-03 → 2026年10月3日。非法输入原样返回。 */
export function formatLocalDateForDisplay(text: string): string {
  const parts = parseParts(text)
  if (!parts) return text
  return `${parts.y}年${parts.m}月${parts.d}日`
}

/** 星期几，如「星期六」。非法输入返回空串。 */
export function localDateWeekday(text: string): string {
  const parts = parseParts(text)
  if (!parts) return ''
  return WEEKDAYS[parts.weekdayIndex]
}
