import type { JSX } from 'react'
import type { TransactionListItem } from '@shared/types'
import { formatYuan } from '@shared/money'
import { paymentMethodLabel } from '@shared/paymentMethods'

interface TransactionRowProps {
  readonly item: TransactionListItem
  readonly onClick: () => void
}

/**
 * 账单列表里的一行。整行可点，点开就是编辑窗口。
 *
 * 金额的符号和颜色是这里唯一「有观点」的地方：支出带负号显示成红色、
 * 收入带正号显示成绿色 —— 光靠颜色区分，色觉障碍的用户分不出来；
 * 光靠符号区分，一眼扫过去又不够快。两个都给。
 *
 * 备注为空时不占位（truncate 一个空串什么也不显示），
 * 免得每一行都留一段空白，把有备注的账挤到看不清。
 */
export default function TransactionRow({ item, onClick }: TransactionRowProps): JSX.Element {
  const isExpense = item.kind === 'expense'

  return (
    <button
      type="button"
      data-testid={`list-row-${item.id}`}
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-700/60"
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
  )
}
