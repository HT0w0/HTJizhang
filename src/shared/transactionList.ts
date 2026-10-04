/**
 * 账单列表的纯逻辑：按天分组、算小计、洗搜索词。
 *
 * 不碰数据库、不碰 React（CLAUDE.md §5.15），所以可以直接单测 ——
 * 这里算错的话，用户看到的是「当天的小计和明细对不上」，而且不会报任何错。
 */
import type { CategoryKind, TransactionListItem } from './types'

/** 列表页的筛选状态：只看支出 / 只看收入 / 都看。没有选中的月份也是一样的意思。 */
export type KindFilter = CategoryKind | 'all'

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

/** 底部合计里的一行。 */
export interface SummaryRow {
  readonly label: '支出' | '收入' | '结余'
  readonly amountFen: number
}

/**
 * 底部合计该显示哪几项。
 *
 * 筛成「只看支出」时**只显示支出那一项**（用户 2026-10-04 拍板）。
 * 三项都显示的话，收入会显示 0.00 —— 明明这个月有收入，
 * 用户会读成「我这个月没有收入」，比不显示更糟。
 *
 * 为什么单独抽成一个函数：这是纯逻辑，放这里能直接单测（§5.15）；
 * 写在 JSX 里就只能靠界面验证脚本去点，测得慢也测不全。
 */
export function summaryRows(
  kind: KindFilter,
  totals: { readonly expenseFen: number; readonly incomeFen: number; readonly netFen: number }
): SummaryRow[] {
  if (kind === 'expense') return [{ label: '支出', amountFen: totals.expenseFen }]
  if (kind === 'income') return [{ label: '收入', amountFen: totals.incomeFen }]
  return [
    { label: '支出', amountFen: totals.expenseFen },
    { label: '收入', amountFen: totals.incomeFen },
    { label: '结余', amountFen: totals.netFen }
  ]
}

/** 列表为空时该显示的两行字。hint 为空串表示不显示第二行。 */
export interface EmptyHint {
  readonly title: string
  readonly hint: string
}

/**
 * 列表空了该说什么。
 *
 * 为什么要分三种情形：原来是「有没有搜索词」一刀切，于是筛成「只看支出」
 * 而当月只有收入时，会说出「本月还没有记账」——**和事实相反**。
 * 用户明明记过账，软件却说他没记，比一片空白更让人怀疑软件坏了。
 *
 * monthLabel 由调用方给：本月可以传「这个月」，比「2026年10月」更像人话。
 */
export function emptyHint(keyword: string, kind: KindFilter, monthLabel: string): EmptyHint {
  if (keyword !== '') {
    return { title: `没有找到包含「${keyword}」的账单`, hint: '' }
  }
  if (kind === 'expense') {
    return {
      title: `${monthLabel}没有支出记录`,
      hint: '换个筛选看看，或去「记一笔」记下第一笔吧'
    }
  }
  if (kind === 'income') {
    return {
      title: `${monthLabel}没有收入记录`,
      hint: '换个筛选看看，或去「记一笔」记下第一笔吧'
    }
  }
  return { title: `${monthLabel}还没有记账`, hint: '去「记一笔」记下第一笔吧' }
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
