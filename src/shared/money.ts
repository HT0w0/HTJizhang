/**
 * 金额换算。
 *
 * 全项目约定：金额一律以整数「分」存储和计算，绝不使用浮点数。
 * 原因：浮点数累加会产生分位偏差，记几千笔账后总额会对不上。
 * 所有「元 ↔ 分」的转换都必须经过本文件（见 CLAUDE.md §5.1）。
 */

/** 全角数字（０-９）与全角小数点（．） */
const FULL_WIDTH_RE = /[０-９．]/g

/** 把全角数字和全角小数点转成半角，中文输入法下很容易打出来 */
function toHalfWidth(input: string): string {
  return input.replace(FULL_WIDTH_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * 把用户输入的「元」文本换算成整数「分」。
 *
 * 接受：正数、最多两位小数、千分位逗号、全角数字、首尾空格。
 * 拒绝（返回 null）：空、非数字、负数、超过两位小数、超出安全整数范围。
 *
 * 返回 null 而不是抛异常，方便表单直接判断输入是否合法。
 * 注意 0 是合法的换算结果，「是否允许记 0 元的账」由表单层决定。
 */
export function yuanToFen(input: string): number | null {
  if (typeof input !== 'string') return null

  const normalized = toHalfWidth(input).replace(/,/g, '').trim()
  if (normalized === '') return null

  // 整数部分可省略（形如 ".5"），小数部分最多两位
  const matched = /^(\d*)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!matched) return null

  const intPart = matched[1] ?? ''
  const decPart = matched[2] ?? ''
  if (intPart === '' && decPart === '') return null

  // 用字符串拼装而非浮点乘法：Number('0.29') * 100 === 28.999999999999996
  const fen = Number(intPart === '' ? '0' : intPart) * 100 + Number((decPart + '00').slice(0, 2))

  return Number.isSafeInteger(fen) ? fen : null
}

/**
 * 把整数「分」格式化成固定两位小数的「元」字符串。
 * 1234 → "12.34"；7 → "0.07"；-1234 → "-12.34"
 */
export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? '-' : ''
  const abs = Math.abs(fen)
  const yuan = Math.trunc(abs / 100)
  const cents = abs % 100
  return `${sign}${yuan}.${String(cents).padStart(2, '0')}`
}

/**
 * 在 fenToYuan 的基础上加千分位分隔符，用于界面展示。
 * 123456 → "1,234.56"；-123456 → "-1,234.56"
 */
export function formatYuan(fen: number): string {
  const [intPart, decPart] = fenToYuan(fen).split('.')
  const sign = intPart.startsWith('-') ? '-' : ''
  const digits = sign ? intPart.slice(1) : intPart
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decPart}`
}
