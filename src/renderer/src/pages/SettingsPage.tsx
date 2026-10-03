import type { JSX } from 'react'
import CategoryManager from '../components/CategoryManager'

export default function SettingsPage(): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold">设置</h1>

      <div className="mt-6">
        <h2 className="text-lg font-medium">分类管理</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          左边选一个大类，右边管理它下面的小类。顺序可以拖动调整，也可以按 ↑↓。
          删除的分类会进到「已删除」里，随时能恢复。
        </p>
        <CategoryManager />
      </div>

      <p className="mt-8 text-sm text-slate-400">数据备份导出将在后续版本提供。</p>
    </section>
  )
}
