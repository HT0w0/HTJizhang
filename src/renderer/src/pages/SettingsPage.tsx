import type { JSX } from 'react'

export default function SettingsPage(): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold">设置</h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        这里将实现分类管理、数据备份导出，以及「打开数据文件夹」。
      </p>
    </section>
  )
}
