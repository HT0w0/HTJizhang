import type { JSX } from 'react'

export default function ListPage(): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold">账单</h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        这里将实现账单列表：按月查看、按日期分组、筛选、搜索、编辑与删除。
      </p>
    </section>
  )
}
