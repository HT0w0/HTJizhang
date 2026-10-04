/**
 * 统计页的纯逻辑：月份序列、占比、横轴标签、空状态文案。
 *
 * 不碰数据库、不碰 React（CLAUDE.md §5.15），所以可以直接单测 ——
 * 这里算错的话，用户看到的是「占比加起来不是 100%」「趋势图少了一个月」
 * 这种**当场看不出来**的错，而且不会报任何错。
 *
 * 真正的聚合（SUM/GROUP BY）在 src/main/db/stats.ts 里，那边用内存数据库测。
 */
import { formatMonthForDisplay, shiftMonth } from './month'

/**
 * 最近 N 个月，**从旧到新**排（最后一个是 endMonth）。
 *
 * 顺序为什么是「旧在前」：柱状图从左到右就是时间往前走，
 * 画的时候直接按数组顺序排，不需要在界面里再反过来一次 ——
 * 那种「数据一个序、显示另一个序」的地方最容易出「月份和柱子对不上」的错。
 */
export function recentMonths(endMonth: string, count = 12): string[] {
  const months: string[] = []
  // 从 count-1 个月前一路排到 endMonth。shiftMonth 会自己校验格式并在非法时抛错。
  for (let i = count - 1; i >= 0; i -= 1) {
    months.push(shiftMonth(endMonth, -i))
  }
  return months
}

/**
 * 占比，百分数，保留一位小数。
 *
 * ⚠️ 总额是 0 时**必须返回 0**：`0 / 0` 是 NaN，界面上会原样显示成「NaN%」，
 * 用户完全不知道那是什么。这不是极端情况 —— 新用户刚装上软件、这个月一笔没记，
 * 就是 0。
 *
 * 先四舍五入再返回（而不是让调用方各自处理），是为了让图上标的数字和提示框里
 * 的数字**来自同一个值**。两处各算一次的话，早晚会出现「图上写 33.3%、提示框写 33.33%」。
 */
export function percentageOf(partFen: number, totalFen: number): number {
  if (!Number.isFinite(partFen) || !Number.isFinite(totalFen) || totalFen <= 0) return 0
  return Math.round((partFen / totalFen) * 1000) / 10
}

/**
 * 显示用的百分比串。
 *
 * 整数不拖一个「.0」（「100%.0」看着像出了错），
 * 也避免「0.04%」这种全是噪音的数字 —— 四舍五入到一位小数后就是 0。
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

/**
 * 趋势图横轴的标签：'2026-10' → '10月'。
 *
 * 只写月份不写年份：12 个标签里塞年份，横轴会挤成一团；
 * 具体是哪一年，鼠标移到柱子上看提示框就够了。
 * 不合法的输入原样返回 —— 一个标签而已，不该让整个图表崩掉。
 */
export function trendLabel(month: string): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(month)
  if (!matched) return month
  return `${Number(matched[2])}月`
}

/**
 * 趋势图**纵轴刻度**上的金额：把「分」换成好读的「元」。
 *
 * 为什么不能直接把 amount_fen 交给坐标轴：8000 元的刻度会显示成 800000，
 * 数字大 100 倍，而用户看到的只是一排又长又挤的数字 —— 他不会觉得「单位是分」，
 * 只会觉得这图看不懂。刻度上也不能拖两位小数（1,234.56 挤在轴上一团）。
 *
 * 上万之后换成「万」：一个月的支出上万很常见，5 位以上的数字会把绘图区挤小。
 * 刻度是给眼睛定位置用的，精确金额在鼠标移到柱子上的提示框里。
 */
export function formatAxisYuan(fen: number): string {
  if (!Number.isFinite(fen)) return '0'

  const yuan = Math.round(fen / 100)
  // 判据用**换算前的分**，这样「不到一万按元写」只有一条规则，
  // 不会因为四舍五入把 9,999 元推到「万」那一支去。
  if (Math.abs(fen) < 1000000) {
    return yuan.toLocaleString('en-US')
  }

  const wan = Math.round((yuan / 10000) * 10) / 10
  return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`
}

/** 饼图 / 排行没有内容时该显示的两行字。title 为空串表示「有内容，不用显示」。 */
export interface ChartEmptyHint {
  readonly title: string
  readonly hint: string
}

export interface ExpenseChartHintInput {
  /** 形如「2026年10月」。由调用方格式化 —— 本月传「这个月」比年月更像人话。 */
  readonly monthLabel: string
  /** 这个月一共几笔账（支出 + 收入）。 */
  readonly transactionCount: number
  readonly expenseFen: number
  readonly incomeFen: number
}

/**
 * 饼图和排行的空状态文案。
 *
 * **为什么必须分两种情形**：这两个图统计的都是**支出**，
 * 所以「一笔没记」和「记了但全是收入」看起来都是空的，但原因完全不同。
 * 一句话打发的话，第二种情形下用户会看到「还没有记账」——
 * 他明明记了三笔工资，屏幕上却说他没记。比一片空白更让人怀疑软件坏了。
 *
 * 第二种情形还必须说清「图统计的是支出」，否则用户只会觉得图坏了、
 * 而不会想到「哦，这个月我只记了收入」。
 */
export function expenseChartHint(input: ExpenseChartHintInput): ChartEmptyHint {
  if (input.expenseFen > 0) return { title: '', hint: '' }

  if (input.transactionCount === 0) {
    return {
      title: `${input.monthLabel}还没有记账`,
      hint: '去「记一笔」记下第一笔吧'
    }
  }

  return {
    title: `${input.monthLabel}没有支出记录`,
    hint: '占比和排行统计的是支出。这个月记的都是收入。'
  }
}

/**
 * 取数失败、界面还留着**上一次成功那一个月**的数据时，给用户的一句解释。
 *
 * 为什么非有这句不可：翻月时如果只是留着旧数字，界面上的**月份标题**会跟着
 * 用户翻到 9 月，而卡片和图表仍是 10 月的 —— 用户看到的是「2026年9月支出 300.00 元」，
 * 可 9 月其实一笔账都没有。**数字是真的、月份也是真的，凑在一起却是假的**，
 * 而屏幕上没有任何东西提示这一点（第 5 阶段独立复核抓到的就是这个）。
 *
 * 所以调用方要做两件事，缺一不可：
 *   1. 卡片和标题上的月份一律取**数据自己的月份**，不要取用户翻到的那个月；
 *   2. 把这里返回的这句话显示出来，让用户知道下面看的是哪个月的数。
 *
 * 返回空串表示「数据就是当前这个月的，没什么要说的」。
 */
export function staleStatsNotice(dataMonth: string, shownMonth: string): string {
  if (dataMonth === '' || shownMonth === '' || dataMonth === shownMonth) return ''

  return (
    `取不到${formatMonthForDisplay(shownMonth)}的统计，` +
    `下面显示的还是${formatMonthForDisplay(dataMonth)}的数据。`
  )
}
