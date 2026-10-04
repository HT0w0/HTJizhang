import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryKind, TransactionListItem } from '@shared/types'
import { formatMonthForDisplay, shiftMonth } from '@shared/month'
import { formatLocalDateForDisplay, localDateWeekday } from '@shared/localDate'
import { formatYuan } from '@shared/money'
import { groupByDay, sumByKind } from '@shared/transactionList'
import MonthSwitcher from '../components/MonthSwitcher'
import TransactionRow from '../components/TransactionRow'
import EditTransactionDialog from '../components/EditTransactionDialog'

type KindFilter = CategoryKind | 'all'

const KIND_FILTERS: ReadonlyArray<{ readonly value: KindFilter; readonly label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' }
]

export default function ListPage({ active }: { active: boolean }): JSX.Element {
  /** 正在看哪个月。空串表示还没定下来（第一次打开时的那一刻）。 */
  const [month, setMonth] = useState('')
  /** 今天所在的月。由主进程给，界面不自己算（§5.2）。 */
  const [thisMonth, setThisMonth] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<readonly TransactionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 用户点开了哪一笔（null 表示没开编辑窗口）。 */
  const [editing, setEditing] = useState<TransactionListItem | null>(null)

  /**
   * 最近一次查询的编号。用来丢弃「过期的响应」。
   *
   * 场景：搜索框里连着敲几个字，会连发好几次查询。数据库回答的快慢没有保证，
   * 万一先发的那次后回来，界面就会被上一次的结果覆盖 ——
   * 用户会看到搜索结果和搜索框里的字对不上。编号能确保只有最后一次算数。
   */
  const requestId = useRef(0)

  // 每次切回本页都重新问一次「今天是几号」——
  // 这样跨零点（甚至跨月）之后，「回到本月」指向的仍是真正的本月。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    window.ht.transactions
      .today()
      .then((today) => {
        if (cancelled) return
        const m = today.slice(0, 7)
        setThisMonth(m)
        // 只在还没定下月份时跟随（第一次打开）；用户自己翻过的月份不抢回来
        setMonth((current) => (current === '' ? m : current))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [active])

  function reload(): void {
    const id = ++requestId.current
    setLoading(true)
    window.ht.transactions
      .list({ month, kind, keyword })
      .then((rows) => {
        if (id !== requestId.current) return
        setItems(rows)
        setError('')
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return
        setError((e as Error).message)
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }

  // 月份/筛选/搜索变化，或从别的页面切回来时，都重新拉一次
  useEffect(() => {
    if (!active || month === '') return
    reload()
    // reload 每次渲染都是新的函数，故意不进依赖数组 ——
    // 放进去会变成「加载完就再加载一次」的死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, month, kind, keyword])

  const groups = groupByDay(items)
  const totals = sumByKind(items)
  const shownMonth = month === '' ? thisMonth : month

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">账单</h1>
        <span data-testid="list-total" className="text-sm text-slate-500 dark:text-slate-400">
          共 {items.length} 笔
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {shownMonth !== '' && (
          <MonthSwitcher
            month={shownMonth}
            isCurrent={shownMonth === thisMonth}
            onPrev={() => setMonth(shiftMonth(shownMonth, -1))}
            onNext={() => setMonth(shiftMonth(shownMonth, 1))}
            onThisMonth={() => setMonth(thisMonth)}
          />
        )}

        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              data-testid={`list-filter-${f.value}`}
              aria-pressed={kind === f.value}
              onClick={() => setKind(f.value)}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                kind === f.value
                  ? 'bg-white font-medium text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-400'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          data-testid="list-search"
          value={keyword}
          aria-label="搜索备注或分类"
          placeholder="搜备注或分类"
          onChange={(e) => setKeyword(e.target.value)}
          className="w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
        />
      </div>

      {error !== '' && (
        <p
          role="alert"
          data-testid="list-error"
          className="mt-4 whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {!loading && items.length === 0 && (
        <p data-testid="list-empty" className="mt-16 text-center text-sm text-slate-500 dark:text-slate-400">
          {keyword !== ''
            ? `没有找到包含「${keyword}」的账单`
            : `${shownMonth === '' ? '这个月' : formatMonthForDisplay(shownMonth)}还没有记账`}
          {keyword === '' && (
            <>
              <br />
              <span className="text-xs text-slate-400">去「记一笔」记下第一笔吧</span>
            </>
          )}
        </p>
      )}

      {items.length > 0 && (
        <>
          <div className="mt-5 space-y-5">
            {groups.map((group) => (
              <div key={group.date} data-testid={`list-day-${group.date}`}>
                <div className="flex items-baseline justify-between border-b border-slate-200 pb-1 dark:border-slate-700">
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {formatLocalDateForDisplay(group.date)}　{localDateWeekday(group.date)}
                  </span>
                  <span data-testid={`list-day-sum-${group.date}`} className="text-xs text-slate-400">
                    {group.expenseFen > 0 && `支出 ${formatYuan(group.expenseFen)}`}
                    {group.expenseFen > 0 && group.incomeFen > 0 && '　'}
                    {group.incomeFen > 0 && `收入 ${formatYuan(group.incomeFen)}`}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                  {group.items.map((item) => (
                    <TransactionRow key={item.id} item={item} onClick={() => setEditing(item)} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div
            data-testid="list-summary"
            className="mt-6 flex justify-end gap-6 border-t border-slate-200 pt-3 text-sm dark:border-slate-700"
          >
            <span className="text-slate-500 dark:text-slate-400">
              支出{' '}
              <span className="font-medium tabular-nums text-red-600 dark:text-red-400">
                {formatYuan(totals.expenseFen)}
              </span>
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              收入{' '}
              <span className="font-medium tabular-nums text-green-600 dark:text-green-400">
                {formatYuan(totals.incomeFen)}
              </span>
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              结余{' '}
              <span
                className={`font-medium tabular-nums ${
                  totals.netFen < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {formatYuan(totals.netFen)}
              </span>
            </span>
          </div>
        </>
      )}

      {/*
        key 用账单 id：换一笔账时整个弹窗重建，各输入框回到那一笔的初始值。
        不这样做的话 React 会复用旧实例，点开第二笔时看到的是第一笔的内容。
      */}
      <EditTransactionDialog
        key={editing === null ? 'closed' : editing.id}
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          reload()
        }}
        onDeleted={() => {
          setEditing(null)
          reload()
        }}
      />
    </section>
  )
}
