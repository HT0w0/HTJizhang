import type { JSX } from 'react'
import CategoryManager from '../components/CategoryManager'
import DataBackup from '../components/DataBackup'

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

      <div className="mt-8">
        <h2 className="text-lg font-medium">数据备份</h2>
        <DataBackup />
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-medium">关于</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          HT记账 —— 个人记账软件。数据全部保存在这台电脑上，不联网、不注册账号、
          不上传任何内容。
        </p>
        <p className="mt-2 text-xs text-slate-400">
          记账货币：人民币（元）。金额按「分」存储，不会出现小数累加误差。
        </p>
      </div>
    </section>
  )
}
