import { useState } from 'react'
import type { JSX } from 'react'
import AddPage from './pages/AddPage'
import ListPage from './pages/ListPage'
import StatsPage from './pages/StatsPage'
import SettingsPage from './pages/SettingsPage'

type PageKey = 'add' | 'list' | 'stats' | 'settings'

const NAV_ITEMS: ReadonlyArray<{ key: PageKey; label: string; icon: string }> = [
  { key: 'add', label: '记一笔', icon: '✏️' },
  { key: 'list', label: '账单', icon: '📋' },
  { key: 'stats', label: '统计', icon: '📊' },
  { key: 'settings', label: '设置', icon: '⚙️' }
]

const PAGES: Record<PageKey, () => JSX.Element> = {
  add: AddPage,
  list: ListPage,
  stats: StatsPage,
  settings: SettingsPage
}

export default function App(): JSX.Element {
  const [current, setCurrent] = useState<PageKey>('add')

  return (
    <div className="flex h-full bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
        <div className="px-3 py-4 text-lg font-semibold text-blue-600 dark:text-blue-400">
          HT记账
        </div>

        {NAV_ITEMS.map((item) => {
          const isActive = current === item.key
          const classes = isActive
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700'

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setCurrent(item.key)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${classes}`}
            >
              <span aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      {/*
        四个页面全部保持挂载，只把非当前的隐藏起来。
        这样切换页面不会卸载组件，「记一笔」填到一半、账单页的搜索词和筛选月份
        都会原样保留（用户 2026-10-03 明确选择「保留」）。

        不要改回「只渲染当前页」的写法——那会让用户在页面间切换时丢失已填内容。
      */}
      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        {NAV_ITEMS.map((item) => {
          const Page = PAGES[item.key]

          return (
            <div key={item.key} hidden={current !== item.key}>
              <Page />
            </div>
          )
        })}
      </main>
    </div>
  )
}
