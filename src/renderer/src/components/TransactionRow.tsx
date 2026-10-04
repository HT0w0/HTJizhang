import type { JSX } from 'react'
import type { TransactionListItem } from '@shared/types'
import { formatYuan } from '@shared/money'
import { paymentMethodLabel } from '@shared/paymentMethods'

interface TransactionRowProps {
  readonly item: TransactionListItem
  /** 点这一行（除删除按钮以外的任何地方）→ 打开编辑窗口。 */
  readonly onClick: () => void
  /** 点这一行末尾的「删除」→ 由父组件弹确认框。 */
  readonly onDelete: () => void
}

/**
 * 账单列表里的一行。点行开编辑窗口，鼠标移上去时行尾浮出「删除」。
 *
 * ⚠️ 这里**不能**写成「一个大按钮套着一个小按钮」——HTML 不允许按钮嵌套按钮，
 * 浏览器会把内层按钮甩到外层外面去，界面上会少一个按钮、点击还会错位。
 * 所以结构是三层的：外层 div 管悬停背景，行内容是一个按钮，删除是它的**兄弟**按钮。
 *
 * 删除按钮常驻在布局里（`opacity-0`），只是看不见 —— 不能用 `hidden` 或条件渲染：
 * 那样鼠标移上去的瞬间整行会被撑开，金额列跟着往左跳。
 *
 * 点击删除按钮**不会**触发外层的行点击（它不是行的后代），所以不必 stopPropagation。
 * 键盘用户 Tab 过来时靠 `focus-visible:opacity-100` 让它现形，否则会出现
 * 「焦点在删除按钮上、用户却什么都看不见」的情况。
 *
 * 金额的符号和颜色是这里唯一「有观点」的地方：支出带负号显示成红色、
 * 收入带正号显示成绿色 —— 光靠颜色区分，色觉障碍的用户分不出来；
 * 光靠符号区分，一眼扫过去又不够快。两个都给。
 */
export default function TransactionRow({ item, onClick, onDelete }: TransactionRowProps): JSX.Element {
  const isExpense = item.kind === 'expense'

  return (
    <div className="group flex w-full items-center gap-2 pr-2 transition-colors hover:bg-slate-100 dark:hover:bg-slate-700/60">
      <button
        type="button"
        data-testid={`list-row-${item.id}`}
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
      >
        <span aria-hidden="true" className="w-7 shrink-0 text-center text-lg">
          {item.majorIcon}
        </span>

        <span className="w-40 shrink-0">
          <span className="block truncate text-sm font-medium">{item.categoryName}</span>
          <span className="block truncate text-xs text-slate-400">{item.majorName}</span>
        </span>

        <span className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400">
          {item.note}
        </span>

        <span className="w-16 shrink-0 text-right text-xs text-slate-400">
          {paymentMethodLabel(item.paymentMethod)}
        </span>

        <span
          data-testid={`list-amount-${item.id}`}
          className={`w-32 shrink-0 text-right text-sm font-medium tabular-nums ${
            isExpense ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
          }`}
        >
          {isExpense ? '-' : '+'}
          {formatYuan(item.amountFen)}
        </span>
      </button>

      <button
        type="button"
        data-testid={`list-delete-${item.id}`}
        aria-label={`删除「${item.categoryName}」这一笔`}
        onClick={onDelete}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs text-red-600 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
      >
        删除
      </button>
    </div>
  )
}
