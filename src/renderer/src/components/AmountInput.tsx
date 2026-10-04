import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { JSX } from 'react'
import { toHalfWidth } from '@shared/money'

export interface AmountInputHandle {
  focus(): void
}

interface AmountInputProps {
  /** 用户输入的原始文本 */
  readonly value: string
  readonly onChange: (next: string) => void
  readonly onEnter: () => void
  /** 是否显示成「有错」的样子 */
  readonly invalid: boolean
  /**
   * 测试标识。**必须全局唯一。**
   *
   * 四个页面是常驻挂载的（见 App.tsx），编辑弹窗和记账页会同时存在于文档里。
   * 两边都叫 amount 的话，验证脚本 `querySelector('[data-testid="amount"]')`
   * 抓到的是记账页那个（还是隐藏的），脚本会以为自己验证了弹窗。
   * 记账页用默认值，弹窗传 `edit-amount`。
   */
  readonly testId?: string
}

/**
 * 允许「打字打到一半」的中间状态。
 *
 * 这一步不能省，否则用户永远打不出 12.34：
 * 输入过程是 1 → 12 → 12. → 12.3 → 12.34，中间每一步都得接受。
 * 用 yuanToFen 判断的话 "12." 会返回 null（它不合法），
 * 于是用户敲下小数点的那一刻输入就被吞掉了。
 *
 * 真正的合法性由保存时统一用 yuanToFen 判断。
 */
/**
 * 放行的中间状态。
 *
 * 逗号是**故意放宽的**：`money.ts` 支持并严格校验千分位写法（1,234.56），
 * 如果输入框一律不收逗号，用户粘贴「1,234.56」时整段都会被拒、
 * 框里什么都不出现，也没有任何提示。这里先放行，最终合法性交给保存时的
 * yuanToFen 判定 —— 它会拒绝「1,2,3」这种分组错误，**不会静默算成 123**。
 */
const PARTIAL_RE = /^\d*(?:,\d{0,3})*(?:\.\d{0,2})?$/

/**
 * 金额输入框。
 *
 * 用键盘直接打字——这是在电脑上记账最快的方式。
 * 光标由父组件在挂载和保存后重新聚焦，保证可以一直不碰鼠标。
 */
const AmountInput = forwardRef<AmountInputHandle, AmountInputProps>(function AmountInput(
  { value, onChange, onEnter, invalid, testId = 'amount' },
  ref
): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus(): void {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }))

  return (
    <div className="flex items-baseline justify-center gap-2">
      <span aria-hidden="true" className="text-3xl text-slate-400">
        ￥
      </span>
      <input
        ref={inputRef}
        value={value}
        data-testid={testId}
        aria-label="金额"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        onChange={(e) => {
          // 先把全角转成半角再判断。这一步必须在判断之前 ——
          // 中文输入法下很容易打出全角数字（２８），
          // 不先转换的话它们会被下面的规则直接拒掉，用户以为自己打了字、
          // 屏幕上却什么都没有，完全不知道哪里出了问题。
          const next = toHalfWidth(e.target.value)
          // 只放行形如数字/一个小数点/最多两位小数的输入；
          // 其它按键（字母、第二个小数点）直接不理会，输入框保持原样。
          if (next === '' || PARTIAL_RE.test(next)) onChange(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
        }}
        className={`w-64 border-b-2 bg-transparent pb-1 text-center text-5xl font-semibold tabular-nums outline-none transition-colors placeholder:text-slate-300 dark:placeholder:text-slate-600 ${
          invalid
            ? 'border-red-400 text-red-600 dark:text-red-400'
            : 'border-slate-300 text-slate-900 focus:border-blue-500 dark:border-slate-600 dark:text-slate-50'
        }`}
      />
    </div>
  )
})

export default AmountInput
