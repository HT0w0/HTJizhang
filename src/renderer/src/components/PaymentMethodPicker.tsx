import type { JSX } from 'react'
import type { PaymentMethod } from '@shared/types'
import { PAYMENT_METHODS, paymentMethodLabel } from '@shared/paymentMethods'

interface PaymentMethodPickerProps {
  readonly value: PaymentMethod
  readonly onChange: (next: PaymentMethod) => void
  /**
   * 测试标识前缀，规则同 AmountInput 的 testId：**必须全局唯一**。
   * 记账页用默认值 `payment`，编辑弹窗传 `edit-payment`。
   */
  readonly testIdPrefix?: string
}

/** 一排支付方式按钮。日常最常用的排在前面（顺序由 PAYMENT_METHODS 决定）。 */
export default function PaymentMethodPicker({
  value,
  onChange,
  testIdPrefix = 'payment'
}: PaymentMethodPickerProps): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {PAYMENT_METHODS.map((method) => {
        const active = method === value
        return (
          <button
            key={method}
            type="button"
            data-testid={`${testIdPrefix}-${method}`}
            aria-pressed={active}
            onClick={() => onChange(method)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {paymentMethodLabel(method)}
          </button>
        )
      })}
    </div>
  )
}
