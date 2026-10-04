import { useState } from 'react'
import type { JSX } from 'react'
import type { CategoryAmount, MajorAmount } from '@shared/types'
import { formatYuan } from '@shared/money'
import { formatPercent, percentageOf } from '@shared/stats'
import { colorAt } from './chartColors'

interface MajorRankingProps {
  readonly majors: readonly MajorAmount[]
  /** 本月支出总额。排行里所有的百分比都是「占本月支出的多少」。 */
  readonly totalFen: number
}

/**
 * 支出大类排行。点一行展开它名下的小类。
 *
 * 为什么不做成「点一下跳去账单页看明细」（用户 2026-10-04 选的本期不做）：
 * 跳走之后要回到统计页、还要重新翻回同一个月，比自己算还慢。
 *
 * 小类的百分比也是**占本月支出总额**，不是占它所属的大类。
 * 同一个页面上所有百分比必须是一个意思 —— 饼图上的占比、排行上的占比、
 * 展开后小类的占比，如果有一处换了分母，用户看到「餐饮 40%，
 * 展开后午餐 60%」就会以为算错了，而屏幕上没有任何东西告诉他分母变了。
 */
export default function MajorRanking({ majors, totalFen }: MajorRankingProps): JSX.Element {
  const [expandedId, setExpandedId] = useState<number | null>(null)

  return (
    <div data-testid="stats-ranking" className="divide-y divide-slate-100 dark:divide-slate-700/60">
      {majors.map((major, index) => {
        const expanded = expandedId === major.categoryId

        return (
          <div key={major.categoryId}>
            <button
              type="button"
              data-testid={`stats-rank-row-${major.categoryId}`}
              aria-expanded={expanded}
              onClick={() => setExpandedId(expanded ? null : major.categoryId)}
              className="flex w-full items-center gap-3 px-2 py-2.5 text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-700/60"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: colorAt(index) }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span aria-hidden="true">{major.icon}</span> {major.name}
              </span>
              <span
                data-testid={`stats-rank-amount-${major.categoryId}`}
                className="shrink-0 text-sm tabular-nums"
              >
                {formatYuan(major.amountFen)}
              </span>
              <span
                data-testid={`stats-rank-percent-${major.categoryId}`}
                className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-400"
              >
                {formatPercent(percentageOf(major.amountFen, totalFen))}
              </span>
              <span aria-hidden="true" className="w-4 shrink-0 text-xs text-slate-400">
                {expanded ? '▾' : '▸'}
              </span>
            </button>

            {expanded && (
              <div
                data-testid={`stats-rank-children-${major.categoryId}`}
                className="bg-slate-50 px-2 pb-2 dark:bg-slate-800/60"
              >
                {major.children.map((child) => (
                  <MinorRow key={child.categoryId} child={child} totalFen={totalFen} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 展开后的一行小类。缩进 + 一条左边的竖线，让人看出它属于上面那个大类。 */
function MinorRow({
  child,
  totalFen
}: {
  readonly child: CategoryAmount
  readonly totalFen: number
}): JSX.Element {
  return (
    <div
      data-testid={`stats-rank-minor-${child.categoryId}`}
      className="flex items-center gap-3 border-l-2 border-slate-200 py-1.5 pl-5 pr-2 text-xs dark:border-slate-600"
    >
      <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
        {child.name}
      </span>
      <span
        data-testid={`stats-rank-minor-amount-${child.categoryId}`}
        className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400"
      >
        {formatYuan(child.amountFen)}
      </span>
      <span
        data-testid={`stats-rank-minor-percent-${child.categoryId}`}
        className="w-14 shrink-0 text-right tabular-nums text-slate-400"
      >
        {formatPercent(percentageOf(child.amountFen, totalFen))}
      </span>
      {/* 占位，让展开后的小类金额和上面大类的金额对齐 */}
      <span aria-hidden="true" className="w-4 shrink-0" />
    </div>
  )
}
