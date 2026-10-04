/**
 * 统计聚合查询。
 *
 * 每次取数都是**一个** SQL 里的 SUM + GROUP BY，不要把账单全捞出来在 JS 里累加：
 * 那样账单多了会越来越慢，而且「本月」的边界判定会在两处各写一遍，早晚对不上。
 *
 * ⚠️ 所有查询都**不过滤 `is_archived`**（§5.11）。
 * 归档一个分类之后，它名下的历史账单仍然照常显示、照常统计 ——
 * 这里多加一句 `AND c.is_archived = 0` 的话，用户一删分类，统计数字就会
 * 无缘无故变小，而且**当场看不出来**：饼图上少一块，没人会立刻发现是哪天开始的。
 * `stats.test.ts` 里有一条专门钉住这件事的测试。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { CategoryAmount, MajorAmount, StatsOverview, TrendPoint } from '@shared/types'
import { monthRange } from '@shared/month'
import { recentMonths } from '@shared/stats'

/** 趋势图看多少个月。 */
export const TREND_MONTHS = 12

interface TotalsRow {
  expense_fen: number | null
  income_fen: number | null
  cnt: number
}

interface MajorMinorRow {
  major_id: number
  major_name: string
  major_icon: string
  minor_id: number
  minor_name: string
  amount_fen: number
}

interface TrendRow {
  month: string
  expense_fen: number | null
  income_fen: number | null
}

/**
 * 某个月的统计总览：卡片数字 + 大类汇总（含小类）+ 最近 12 个月趋势。
 *
 * trend 用的是 12 个月里**第一个月的 1 号**到 month 的最后一天，一次查完再补 0 ——
 * 12 次小查询也能work，但 12 次跨进程往返换来的是「其中一个月份忘了补 0、
 * 柱子少一根」这类错误，不划算。
 */
export function statsOverview(db: DatabaseSync, month: string): StatsOverview {
  const { start, end } = monthRange(month)

  // ---- 卡片数字 ----
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
         COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_fen ELSE 0 END), 0) AS income_fen,
         COUNT(*) AS cnt
       FROM transactions
      WHERE occurred_on >= ? AND occurred_on <= ?`
    )
    .get(start, end) as unknown as TotalsRow

  const expenseFen = totals.expense_fen ?? 0
  const incomeFen = totals.income_fen ?? 0

  // ---- 大类 / 小类（只统计支出） ----
  const majorRows = db
    .prepare(
      `SELECT p.id   AS major_id,
              p.name AS major_name,
              p.icon AS major_icon,
              c.id   AS minor_id,
              c.name AS minor_name,
              SUM(t.amount_fen) AS amount_fen
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         JOIN categories p ON p.id = c.parent_id
        WHERE t.kind = 'expense'
          AND t.occurred_on >= ? AND t.occurred_on <= ?
        GROUP BY p.id, c.id
        ORDER BY p.id, amount_fen DESC`
    )
    .all(start, end) as unknown as MajorMinorRow[]

  const majors = assembleMajors(majorRows)

  return {
    month,
    expenseFen,
    incomeFen,
    netFen: incomeFen - expenseFen,
    count: totals.cnt,
    majors,
    trend: trendOf(db, month)
  }
}

/**
 * 把「每个 (大类, 小类) 一行」的结果拼成大类 → 小类两层。
 *
 * 排序在这里做而不是全靠 SQL：SQL 的 ORDER BY 只定了 p.id 和金额，
 * 而我们要的是「大类按金额从大到小」。金额是分组之后才知道的，
 * 在 JS 里排一遍最直接，也方便稳定并列时的顺序。
 */
function assembleMajors(rows: readonly MajorMinorRow[]): MajorAmount[] {
  const byMajor = new Map<number, { name: string; icon: string; children: CategoryAmount[] }>()

  for (const row of rows) {
    let entry = byMajor.get(row.major_id)
    if (!entry) {
      entry = { name: row.major_name, icon: row.major_icon, children: [] }
      byMajor.set(row.major_id, entry)
    }
    entry.children.push({
      categoryId: row.minor_id,
      name: row.minor_name,
      amountFen: row.amount_fen
    })
  }

  const majors: MajorAmount[] = []
  for (const [majorId, entry] of byMajor) {
    // 大类金额由小类相加而来，不另外查一遍 —— 两个数来自同一批行，
    // 不可能出现「图上写 100、点开小类加起来 120」。
    const amountFen = entry.children.reduce((acc, c) => acc + c.amountFen, 0)
    majors.push({
      categoryId: majorId,
      name: entry.name,
      icon: entry.icon,
      amountFen,
      children: entry.children.slice().sort((a, b) => b.amountFen - a.amountFen)
    })
  }

  return majors.sort((a, b) => b.amountFen - a.amountFen)
}

/**
 * 最近 12 个月的收支。
 *
 * 查到哪个月算到哪个月，**没有账的月份补 0**：SQL 的 GROUP BY 只会返回
 * 有数据的月份，直接拿去画图的话，横轴上的标签和柱子会错位 ——
 * 用户看到的是「1 月的柱子长在 12 月的位置上」，而且没有任何报错。
 */
function trendOf(db: DatabaseSync, month: string): TrendPoint[] {
  const months = recentMonths(month, TREND_MONTHS)
  const { start } = monthRange(months[0])
  const { end } = monthRange(month)

  const rows = db
    .prepare(
      `SELECT substr(occurred_on, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
              COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount_fen ELSE 0 END), 0) AS income_fen
         FROM transactions
        WHERE occurred_on >= ? AND occurred_on <= ?
        GROUP BY month`
    )
    .all(start, end) as unknown as TrendRow[]

  const found = new Map(rows.map((r) => [r.month, r]))
  // 顺序完全跟着 months 走，不跟 SQL 的返回顺序走 —— 这样「月份与柱子对齐」
  // 这件事只有一个来源，将来 SQL 改动也不会把它弄错。
  return months.map((m) => {
    const row = found.get(m)
    return {
      month: m,
      expenseFen: row?.expense_fen ?? 0,
      incomeFen: row?.income_fen ?? 0
    }
  })
}
