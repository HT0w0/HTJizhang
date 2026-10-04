import type { JSX } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { TooltipPayload } from 'recharts'
import type { TrendPoint } from '@shared/types'
import { formatMonthForDisplay } from '@shared/month'
import { formatYuan } from '@shared/money'
import { formatAxisYuan, trendLabel } from '@shared/stats'
import { EXPENSE_COLOR, INCOME_COLOR } from './chartColors'

interface MonthlyTrendChartProps {
  readonly trend: readonly TrendPoint[]
}

/**
 * 最近 12 个月的收支双柱图。
 *
 * 支出和收入并排两根柱（用户 2026-10-04 选定），不是堆叠 ——
 * 堆叠会让人以为「这一根的总高度是这个月进出的钱」，而收支相减没有意义，
 * 结余已经由上面的卡片单独说了。
 *
 * 横轴只写「几月」不写年份（trendLabel 负责）：12 个标签塞年份会糊在一起，
 * 具体是哪一年在鼠标提示框里。
 */
export default function MonthlyTrendChart({ trend }: MonthlyTrendChartProps): JSX.Element {
  const data = trend.map((point) => ({ ...point, label: trendLabel(point.month) }))

  return (
    <div data-testid="stats-trend">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} />
            <YAxis
              width={68}
              tick={{ fontSize: 12 }}
              tickLine={false}
              tickFormatter={formatAxisYuan}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ fill: '#94a3b8', fillOpacity: 0.12 }} />
            <Bar
              dataKey="expenseFen"
              name="支出"
              fill={EXPENSE_COLOR}
              isAnimationActive={false}
            />
            <Bar dataKey="incomeFen" name="收入" fill={INCOME_COLOR} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/*
        图例自己写，颜色用和柱子同一份常量 —— 见 chartColors.ts 的说明。
        这两行不是 Recharts 的 Legend，所以柱子不设 name 也不会影响它；
        name 是给提示框用的。
      */}
      <ul className="mt-2 flex gap-4 text-xs">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: EXPENSE_COLOR }}
          />
          <span className="text-slate-600 dark:text-slate-300">支出</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: INCOME_COLOR }}
          />
          <span className="text-slate-600 dark:text-slate-300">收入</span>
        </li>
      </ul>
    </div>
  )
}

/** 提示框里的一条：某一根柱子。 */
interface TrendEntry {
  readonly name?: string
  readonly value?: number
  /** Recharts 会把这一条对应的原始数据塞在 payload 里。 */
  readonly payload?: TrendPoint
}

interface TrendTooltipProps {
  readonly active?: boolean
  readonly payload?: TooltipPayload
}

/**
 * 鼠标移到柱子上时的提示框：补上横轴省掉的年份，并给出精确到分的金额。
 *
 * 标题用「2026年10月」而不是横轴上的「10月」—— 横轴为了不糊在一起省掉了年份，
 * 这里正是把年份还回去的地方。年月取自柱子对应的原始数据（payload.month），
 * 而不是横轴标签，因为标签里根本没有年份。
 */
function TrendTooltip({ active, payload }: TrendTooltipProps): JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) return null

  const entries = payload as readonly TrendEntry[]
  const month = entries[0].payload?.month
  const title = month === undefined ? '' : formatMonthForDisplay(month)

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-600 dark:bg-slate-800">
      {title !== '' && (
        <div className="font-medium text-slate-800 dark:text-slate-100">{title}</div>
      )}
      {entries.map((entry, index) => (
        <div
          key={entry.name ?? index}
          className="mt-0.5 flex items-center gap-2 tabular-nums text-slate-500 dark:text-slate-400"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: entry.name === '收入' ? INCOME_COLOR : EXPENSE_COLOR }}
          />
          <span>{entry.name}</span>
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {formatYuan(entry.value ?? 0)} 元
          </span>
        </div>
      ))}
    </div>
  )
}
