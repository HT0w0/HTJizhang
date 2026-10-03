import type { JSX } from 'react'

export default function StatsPage(): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold">统计</h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        这里将实现统计图表：本月支出/收入/结余、分类占比饼图、近 12 个月趋势、大类排行。
      </p>
    </section>
  )
}
