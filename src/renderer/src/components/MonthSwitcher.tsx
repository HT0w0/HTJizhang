import type { JSX } from 'react'
import { formatMonthForDisplay } from '@shared/month'

interface MonthSwitcherProps {
  readonly month: string
  /** 现在显示的是不是本月。是的话「回到本月」置灰。 */
  readonly isCurrent: boolean
  readonly onPrev: () => void
  readonly onNext: () => void
  readonly onThisMonth: () => void
}

/**
 * 月份切换：‹ 2026年10月 › ，右边一个「回到本月」。
 *
 * 本组件只负责显示和派发三个意图，**不做月份运算** —— 运算放在页面里，
 * 因为页面本来就要知道「现在是哪个月」才能决定从数据库拉哪段数据，
 * 两边各算一次早晚会不一致。
 *
 * 为什么要「回到本月」这个按钮：用户翻到半年前查完账，
 * 得连点六次才能回到当月；而记账软件 90% 的时间看的都是当月。
 */
export default function MonthSwitcher({
  month,
  isCurrent,
  onPrev,
  onNext,
  onThisMonth
}: MonthSwitcherProps): JSX.Element {
  const arrow =
    'rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm transition-colors hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="list-prev-month"
        aria-label="上一个月"
        onClick={onPrev}
        className={arrow}
      >
        ‹
      </button>
      <span
        data-testid="list-month"
        className="min-w-32 text-center text-base font-medium tabular-nums"
      >
        {formatMonthForDisplay(month)}
      </span>
      <button
        type="button"
        data-testid="list-next-month"
        aria-label="下一个月"
        onClick={onNext}
        className={arrow}
      >
        ›
      </button>
      <button
        type="button"
        data-testid="list-this-month"
        disabled={isCurrent}
        onClick={onThisMonth}
        className="rounded-lg px-3 py-1.5 text-sm text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-950"
      >
        回到本月
      </button>
    </div>
  )
}
