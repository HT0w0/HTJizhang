import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { StatsOverview } from '@shared/types'
import { formatMonthForDisplay, shiftMonth } from '@shared/month'
import { formatYuan } from '@shared/money'
import { expenseChartHint, staleStatsNotice } from '@shared/stats'
import MonthSwitcher from '../components/MonthSwitcher'
import CategoryPieChart from '../components/CategoryPieChart'
import MonthlyTrendChart from '../components/MonthlyTrendChart'
import MajorRanking from '../components/MajorRanking'

/**
 * 统计页。
 *
 * 数字卡片、饼图、趋势图、排行**只用一次取数**（window.ht.stats.overview）：
 * 分四次取的话，四次之间用户刚好记了一笔，就会出现「卡片写 100 元、
 * 饼图加起来 120 元」这种对不上、且当场看不出来的数字。
 *
 * 本页的月份**与账单页各管各的**（用户 2026-10-04 选定）：在账单页翻到 3 月查账，
 * 切过来看统计时不该被迫跟着回到 3 月 —— 统计页要看的是「这个月花了多少」。
 */
export default function StatsPage({ active }: { active: boolean }): JSX.Element {
  /** 正在看哪个月。空串表示还没定下来（第一次打开时的那一刻）。 */
  const [month, setMonth] = useState('')
  /** 今天所在的月。由主进程给，界面不自己算（§5.2）。 */
  const [thisMonth, setThisMonth] = useState('')
  const [overview, setOverview] = useState<StatsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /**
   * 最近一次查询的编号，用来丢弃过期响应。
   * 连点「‹」翻月份时，早发的那次可能后回来，把界面覆盖成上一个月的数据。
   */
  const requestId = useRef(0)

  // 每次切回本页都重新问一次「今天是几号」——跨零点/跨月之后「回到本月」才是对的。
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

  // 切回本页、或换月份时重新取数。
  // 切回来也要重取：用户很可能刚在「记一笔」记了一笔再过来看统计。
  useEffect(() => {
    if (!active || month === '') return

    const id = ++requestId.current
    setLoading(true)

    window.ht.stats
      .overview(month)
      .then((data) => {
        if (id !== requestId.current) return
        setOverview(data)
        setError('')
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return
        // 取数失败时**不清空**已有的数据：留着上一次的数字比一片 0 更不容易被误读成
        // 「这个月一笔都没花」。错误提示会显示在下面。
        setError((e as Error).message)
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [active, month])

  const shownMonth = month === '' ? thisMonth : month
  const expenseFen = overview?.expenseFen ?? 0
  const incomeFen = overview?.incomeFen ?? 0
  const netFen = overview?.netFen ?? 0
  const majors = overview?.majors ?? []
  const trend = overview?.trend ?? []

  /**
   * 卡片和图表标题上写的月份，一律取**数据自己的月份**（`overview.month`），
   * 不取用户翻到的那个月。
   *
   * 取数失败时这两个会不一样：用户翻到了 9 月，手上却还是 10 月的数据。
   * 这时若拿 `shownMonth` 写标题、拿 `overview` 写数字，屏幕上就是
   * 「2026年9月 支出 300.00 元」—— 数字是真的、月份也是真的，凑在一起是假的，
   * 而 9 月其实一笔账都没有。标题跟着数据走，最坏也只是「按了翻月没反应」，
   * 配上下面那句说明就说得通（第 5 阶段独立复核抓到的就是这个）。
   */
  const labelMonth = overview?.month ?? shownMonth
  const monthLabel = labelMonth === '' ? '这个月' : formatMonthForDisplay(labelMonth)

  /** 数据不是用户正在看的那个月时，把「下面显示的是几月」讲清楚。 */
  const staleNotice = staleStatsNotice(overview?.month ?? '', shownMonth)

  /**
   * 饼图和排行没有内容时说什么。两种情形必须分开 ——
   * 「一笔没记」和「记了但全是收入」在图上都是空的，原因却完全不同。
   *
   * 还没取到数时一个字都不说（title 给空串，ChartEmpty 会整块不画）：
   * 否则第一次打开统计页会先闪一下「这个月还没有记账」，再被真实数据顶掉 ——
   * 用户明明记了账，却看到一句说他没记账的话。
   */
  const hint =
    overview === null
      ? { title: '', hint: '' }
      : expenseChartHint({
          monthLabel,
          transactionCount: overview.count,
          expenseFen,
          incomeFen
        })

  const panel =
    'rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60'

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">统计</h1>
        <span data-testid="stats-total" className="text-sm text-slate-500 dark:text-slate-400">
          共 {overview?.count ?? 0} 笔
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {shownMonth !== '' && (
          <MonthSwitcher
            testIdPrefix="stats"
            month={shownMonth}
            isCurrent={shownMonth === thisMonth}
            onPrev={() => setMonth(shiftMonth(shownMonth, -1))}
            onNext={() => setMonth(shiftMonth(shownMonth, 1))}
            onThisMonth={() => setMonth(thisMonth)}
          />
        )}
      </div>

      {error !== '' && (
        <p
          role="alert"
          data-testid="stats-error"
          className="mt-4 whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {/*
        取数失败、界面还留着上个月的数据时，必须把「下面看的是几月」讲出来。
        没有这句的话，用户翻了月、标题却还写着上个月，只会以为翻页坏了；
        而若改成标题跟着翻月走，就变成「9 月支出 300 元」这种错月份的正确数字 ——
        比前一种坏得多。见 staleStatsNotice 的说明。
      */}
      {staleNotice !== '' && (
        <p
          role="status"
          data-testid="stats-stale"
          className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {staleNotice}
        </p>
      )}

      <div className="mt-5 grid grid-cols-3 gap-4">
        <StatCard
          testId="stats-card-expense"
          label={`${monthLabel}支出`}
          fen={expenseFen}
          tone="expense"
        />
        <StatCard
          testId="stats-card-income"
          label={`${monthLabel}收入`}
          fen={incomeFen}
          tone="income"
        />
        {/*
          结余的颜色按产品设计文档 §3.4：**正数绿色、负数红色**。
          零单独走中性灰 —— 文档说的是「正数」绿，0 既不是正也不是负，
          刚打开一个还没记账的月份时，绿色大数字「0.00」会被读成「这个月存下了钱」。
        */}
        <StatCard
          testId="stats-card-net"
          label="结余"
          fen={netFen}
          tone={netFen < 0 ? 'expense' : netFen > 0 ? 'income' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid grid-cols-5 gap-4">
        <div className={`${panel} col-span-2`}>
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">支出构成</h2>
          {majors.length > 0 ? (
            <div className="mt-3">
              <CategoryPieChart majors={majors} totalFen={expenseFen} />
            </div>
          ) : (
            <ChartEmpty title={hint.title} hint={hint.hint} testId="stats-pie-empty" />
          )}
        </div>

        <div className={`${panel} col-span-3`}>
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">大类排行</h2>
          {majors.length > 0 ? (
            <div className="mt-2">
              <MajorRanking majors={majors} totalFen={expenseFen} />
            </div>
          ) : (
            <ChartEmpty title={hint.title} hint={hint.hint} testId="stats-ranking-empty" />
          )}
        </div>
      </div>

      <div className={`${panel} mt-4`}>
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
          近 12 个月收支
        </h2>
        {trend.length > 0 ? (
          <div className="mt-3">
            <MonthlyTrendChart trend={trend} />
          </div>
        ) : (
          <ChartEmpty title="" hint="" testId="stats-trend-empty" />
        )}
      </div>

      {/*
        loading 只用来避免「刚打开时闪过一片 0」被当成真实数字。
        取数很快，所以不加转圈之类的东西。
      */}
      {loading && overview === null && error === '' && (
        <span data-testid="stats-loading" className="sr-only">
          统计中
        </span>
      )}
    </section>
  )
}

/** 一张数字卡片。三张卡片长得一样，只有标题、金额和颜色不同。 */
function StatCard({
  testId,
  label,
  fen,
  tone
}: {
  readonly testId: string
  readonly label: string
  readonly fen: number
  readonly tone: 'expense' | 'income' | 'neutral'
}): JSX.Element {
  const valueColor =
    tone === 'expense'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'income'
        ? 'text-green-600 dark:text-green-400'
        : 'text-slate-700 dark:text-slate-200'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60">
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div
        data-testid={testId}
        className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}
      >
        {formatYuan(fen)}
        <span className="ml-1 text-sm font-normal text-slate-400">元</span>
      </div>
    </div>
  )
}

/**
 * 图表区没有内容时的两行字。
 *
 * title 为空串表示「有内容但还没加载出来」，这时什么都不画 ——
 * 否则刚切过来的那一瞬间会闪一下「还没有记账」，而用户明明是有的。
 */
function ChartEmpty({
  title,
  hint,
  testId
}: {
  readonly title: string
  readonly hint: string
  readonly testId: string
}): JSX.Element | null {
  if (title === '') return null

  return (
    <p
      data-testid={testId}
      className="mt-10 text-center text-sm text-slate-500 dark:text-slate-400"
    >
      {title}
      <br />
      <span className="text-xs text-slate-400">{hint}</span>
    </p>
  )
}
