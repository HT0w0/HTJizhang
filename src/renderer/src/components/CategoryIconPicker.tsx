import { useState } from 'react'
import type { JSX } from 'react'

/**
 * 供选择的图标。
 *
 * 全部是各系统自带的表情符号 —— 不联网、不依赖任何图标库文件，
 * 离线也一定显示得出来（本软件不联网）。
 */
export const ICON_CHOICES: readonly string[] = [
  '🍜', '🍚', '🍲', '🥐', '🍰', '☕', '🥤', '🍻', '🥬', '🍎',
  '🚌', '🚇', '🚕', '🚲', '🚄', '✈️', '⛽', '🅿️', '🚗', '🛵',
  '🛍️', '👕', '👟', '💄', '🧴', '🛋️', '🍼', '📚', '✏️', '🖥️',
  '📱', '💻', '🎧', '🌐', '📞', '📦', '🏠', '🔑', '🏢', '💡',
  '🔧', '🎮', '🎬', '🎤', '🏃', '🏖️', '🕹️', '🎫', '🐱', '🐶',
  '💊', '🏥', '🩺', '🦷', '🧬', '🎓', '📝', '📖', '🎁', '🧧',
  '🤝', '🏦', '🛡️', '📉', '📊', '🧾', '💰', '💵', '🏆', '💼',
  '✍️', '📈', '🏘️', '💌', '🎉', '📥', '↩️', '🍀', '❓', '🚨'
]

interface CategoryIconPickerProps {
  readonly value: string
  readonly onChange: (icon: string) => void
  /** 用于测试与无障碍定位，每个实例传不同的值 */
  readonly testId: string
}

/**
 * 图标选择器。
 *
 * 默认收起，只显示当前选中的那一个；点一下才展开网格。
 * 常驻展开会让「新增分类」这一小块占掉大半个屏幕，
 * 而挑图标是低频操作。
 */
export default function CategoryIconPicker({
  value,
  onChange,
  testId
}: CategoryIconPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        aria-label="选择图标"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-lg hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
      >
        {value}
      </button>

      {open && (
        <div
          data-testid={`${testId}-grid`}
          className="mt-1 grid max-h-44 grid-cols-10 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-600"
        >
          {ICON_CHOICES.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={`图标 ${icon}`}
              aria-pressed={icon === value}
              data-testid={`${testId}-opt-${icon}`}
              onClick={() => {
                onChange(icon)
                setOpen(false)
              }}
              className={`flex h-7 w-7 items-center justify-center rounded text-base transition-colors ${
                icon === value
                  ? 'bg-blue-100 ring-2 ring-blue-500 dark:bg-blue-900'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              {icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
