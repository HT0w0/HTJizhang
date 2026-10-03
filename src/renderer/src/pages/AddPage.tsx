import type { JSX } from 'react'

export default function AddPage(): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold">记一笔</h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        这里将实现记账表单：金额、两级分类、日期、备注、支付方式。
      </p>
    </section>
  )
}
