/**
 * 账单列表的纯逻辑：按天分组、算小计、洗搜索词。
 *
 * 不碰数据库、不碰 React（CLAUDE.md §5.15），所以可以直接单测 ——
 * 这里算错的话，用户看到的是「当天的小计和明细对不上」，而且不会报任何错。
 */
import type { TransactionListItem } from './types'

/** 搜索关键词的长度上限。超长的关键词没有意义，还会让 SQL 变慢。 */
export const MAX_KEYWORD_LENGTH = 100

/** 一整天：当天的账单 + 当天的小计。 */
export interface DateGroup {
  readonly date: string
  readonly items: readonly TransactionListItem[]
  readonly expenseFen: number
  readonly incomeFen: number
}

/**
 * 按日期分组，并算出每天的小计。
 *
 * 用 Map 分桶而不是「跟前一组比」：只要输入是按日期排好的（SQL 就是这么排的），
 * 两种写法结果一样，但分桶版本不依赖输入顺序，将来 SQL 的排序改动了也不会悄悄出错。
 * 顺序上完全跟着传入数组走（Map 保持插入顺序），所以界面里
 * 「同一天后记的在上」这一条只在 SQL 里定义一次。
 *
 * ⚠️ 假定输入已经按日期排好序（SQL 的 `ORDER BY occurred_on DESC, id DESC` 保证）。
 * 本函数只分桶，不排序。
 */
export function groupByDay(items: readonly TransactionListItem[]): DateGroup[] {
  const buckets = new Map<string, TransactionListItem[]>()

  for (const item of items) {
    const bucket = buckets.get(item.occurredOn)
    if (bucket) bucket.push(item)
    else buckets.set(item.occurredOn, [item])
  }

  return [...buckets.entries()].map(([date, list]) => {
    let expenseFen = 0
    let incomeFen = 0
    for (const it of list) {
      if (it.kind === 'expense') expenseFen += it.amountFen
      else incomeFen += it.amountFen
    }
    return { date, items: list, expenseFen, incomeFen }
  })
}

/** 整页的合计。netFen 是结余 = 收入 − 支出，可以是负数。 */
export function sumByKind(items: readonly TransactionListItem[]): {
  readonly expenseFen: number
  readonly incomeFen: number
  readonly netFen: number
} {
  let expenseFen = 0
  let incomeFen = 0
  for (const item of items) {
    if (item.kind === 'expense') expenseFen += item.amountFen
    else incomeFen += item.amountFen
  }
  return { expenseFen, incomeFen, netFen: incomeFen - expenseFen }
}

/**
 * 洗搜索词：去首尾空白、把换行和连续空白压成一个空格、超长截断。
 *
 * ⚠️ 不转半角。备注存的是用户原样输入的字符（见 transactions.ts 的 normalizeNote：
 * 也只 trim 和压空白），把关键词转成半角之后，备注里的全角字符就再也搜不到了。
 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_LENGTH)
}

/**
 * 把 SQL LIKE 的特殊字符转义掉。
 *
 * 为什么必须做：LIKE 里 `%` 表示「任意多个字符」、`_` 表示「任意一个字符」。
 * 用户在备注里写了「双十一 50% 折扣」，他搜「50%」时期望的是按字面找，
 * 不转义的话 `%` 会变成通配符 —— 搜「%」甚至会把**所有**账单都搜出来。
 *
 * 配套要求：SQL 里必须写 `ESCAPE '\'`，否则转义符本身没有意义。
 */
export function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
