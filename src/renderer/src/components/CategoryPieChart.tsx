import type { JSX } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { TooltipPayload } from 'recharts'
import type { MajorAmount } from '@shared/types'
import { formatYuan } from '@shared/money'
import { formatPercent, percentageOf } from '@shared/stats'
import { colorAt } from './chartColors'

interface CategoryPieChartProps {
  readonly majors: readonly MajorAmount[]
  /** 本月支出总额。饼图的占比都是「占本月支出的百分比」。 */
  readonly totalFen: number
}

/**
 * 支出按大类占比的饼图 + 图例。
 *
 * 图例是自己写的 HTML，不用 Recharts 自带的 Legend：图例上要带百分比，
 * 而自定义 Legend 的格式化回调参数类型很绕；自己写反而更短，
 * 而且颜色能直接调用 colorAt() —— 和饼图每一块的 fill 是**同一个来源**，
 * 不会出现「饼图上最大那块是蓝色、图例里最大那块是红色」。
 *
 * 饼图的每一块**不写文字标签**：11 个大类里有 8 个占比不到 5%，
 * 标签会互相叠在一起糊成一片。名字和占比交给下面的图例，
 * 具体金额鼠标移上去看提示框。
 */
export default function CategoryPieChart({ majors, totalFen }: CategoryPieChartProps): JSX.Element {
  return (
    <div data-testid="stats-pie">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={majors as MajorAmount[]}
              dataKey="amountFen"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="45%"
              outerRadius="82%"
              paddingAngle={1}
              // 关掉动画。开着的话饼图每次重新挂载都要转一圈才成形，
              // 验证脚本读到的可能是「转到一半」的中间状态（CLAUDE.md §九）。
              isAnimationActive={false}
            >
              {majors.map((major, index) => (
                <Cell key={major.categoryId} fill={colorAt(index)} />
              ))}
            </Pie>
            <Tooltip content={<PieTooltip totalFen={totalFen} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {majors.map((major, index) => (
          <li
            key={major.categoryId}
            data-testid={`stats-pie-legend-${major.categoryId}`}
            className="flex items-center gap-1.5"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: colorAt(index) }}
            />
            <span className="text-slate-600 dark:text-slate-300">{major.name}</span>
            <span
              data-testid={`stats-pie-legend-percent-${major.categoryId}`}
              className="tabular-nums text-slate-400"
            >
              {formatPercent(percentageOf(major.amountFen, totalFen))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 鼠标移到饼图上时跟着出来的提示框。
 *
 * 参数由 Recharts 注入（它会把 active / payload 这些塞进来），
 * 所以除了 totalFen 之外都是可选的 —— 自己直接渲染它时会缺这些。
 */
interface PieTooltipProps {
  readonly totalFen: number
  readonly active?: boolean
  readonly payload?: TooltipPayload
}

function PieTooltip({ totalFen, active, payload }: PieTooltipProps): JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) return null

  const major = payload[0].payload as MajorAmount | undefined
  if (major === undefined || major === null) return null

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-600 dark:bg-slate-800">
      <div className="font-medium text-slate-800 dark:text-slate-100">{major.name}</div>
      <div className="mt-0.5 tabular-nums text-slate-500 dark:text-slate-400">
        {formatYuan(major.amountFen)} 元　{formatPercent(percentageOf(major.amountFen, totalFen))}
      </div>
    </div>
  )
}
