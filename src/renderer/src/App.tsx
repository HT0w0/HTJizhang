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
  const CurrentPage = PAGES[current]

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

      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        <CurrentPage />
      </main>
    </div>
  )
}
