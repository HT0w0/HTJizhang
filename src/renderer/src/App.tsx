import { useState } from 'react'
import type { JSX } from 'react'
import AddPage from './pages/AddPage'
import ListPage from './pages/ListPage'
import StatsPage from './pages/StatsPage'
import SettingsPage from './pages/SettingsPage'
import { ACTIVE_PAGE_KEY } from './sessionKeys'

type PageKey = 'add' | 'list' | 'stats' | 'settings'

const NAV_ITEMS: ReadonlyArray<{ key: PageKey; label: string; icon: string }> = [
  { key: 'add', label: '记一笔', icon: '✏️' },
  { key: 'list', label: '账单', icon: '📋' },
  { key: 'stats', label: '统计', icon: '📊' },
  { key: 'settings', label: '设置', icon: '⚙️' }
]

const PAGE_KEYS: ReadonlyArray<string> = NAV_ITEMS.map((item) => item.key)

/**
 * 重载之后该停在哪一页。
 *
 * 恢复账本会让界面整页重载（见 components/DataBackup.tsx），而重载会把 state
 * 全清掉 —— 少了这一下，用户在设置页点完「替换」会被甩回「记一笔」页，
 * 而那句「已恢复」的提示挂在设置页里，他一个字都看不到。
 * 2026-10-04 独立复核实测到过：提示的文本在，元素 `offsetParent` 是 null。
 *
 * 这个键只在恢复前被写进去。平时读不到，就照旧落在「记一笔」。
 */
function initialPage(): PageKey {
  const stored = sessionStorage.getItem(ACTIVE_PAGE_KEY)
  return stored !== null && PAGE_KEYS.includes(stored) ? (stored as PageKey) : 'add'
}

/**
 * 页面组件。
 *
 * `active` 表示「这一页现在是不是当前显示的那一页」。因为四个页面是常驻挂载的
 * （见下方注释），组件只有在挂载时才会拉一次数据 —— 如果用户在设置页新建了分类，
 * 记账页看不到，会以为软件把数据弄丢了（大类只能在设置页创建，这是常规操作）。
 * 所以把 active 传下去，让各页在「被切到」时重新拉数据。
 *
 * 不声明 active 参数的页面（列表/统计/设置）不必改：参数更少的函数
 * 可以赋值给参数更多的类型。
 */
type PageComponent = (props: { active: boolean }) => JSX.Element

const PAGES: Record<PageKey, PageComponent> = {
  add: AddPage,
  list: ListPage,
  stats: StatsPage,
  settings: SettingsPage
}

export default function App(): JSX.Element {
  const [current, setCurrent] = useState<PageKey>(initialPage)

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
              <Page active={current === item.key} />
            </div>
          )
        })}
      </main>
    </div>
  )
}
