import type { JSX } from 'react'

interface SaveToastProps {
  /** 空串表示不显示 */
  readonly text: string
}

/**
 * 保存成功后的确认条。
 *
 * 为什么要有：保存后表单会清空，如果没有任何反馈，用户不确定到底记上没有，
 * 很可能再记一遍 —— 而重复记一笔是当场看不出来的错误，
 * 等月底发现账目对不上时已经找不到是哪一笔了。
 *
 * 刻意**不自动消失**：自动消失会让用户来不及看清就没了，
 * 反而更不确定。由父组件在用户开始下一笔时清掉。
 */
export default function SaveToast({ text }: SaveToastProps): JSX.Element | null {
  if (text === '') return null
  return (
    <p
      role="status"
      data-testid="save-toast"
      className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
    >
      ✓ {text}
    </p>
  )
}
