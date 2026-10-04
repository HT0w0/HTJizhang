import { useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryKind, PaymentMethod, TransactionListItem } from '@shared/types'
import { formatYuan, yuanToFen } from '@shared/money'
import { formatLocalDateForDisplay } from '@shared/localDate'
import AmountInput from './AmountInput'
import CategoryPicker from './CategoryPicker'
import PaymentMethodPicker from './PaymentMethodPicker'
import ConfirmDialog from './ConfirmDialog'

interface EditTransactionDialogProps {
  /** 要改的那一笔。null 表示窗口不显示。 */
  readonly item: TransactionListItem | null
  readonly onClose: () => void
  /** 保存成功。父组件负责刷新列表。 */
  readonly onSaved: () => void
  /** 删除成功。父组件负责刷新列表。 */
  readonly onDeleted: () => void
}

/**
 * 改一笔账的弹窗。
 *
 * 调用方必须传 key={item.id}，这样换一笔账时组件会整个重建、
 * 各个输入框自动回到那一笔的初始值。否则 React 会复用旧实例，
 * 用户点开第二笔时会看到第一笔的内容 —— 一保存就把第二笔改成了第一笔的样子。
 *
 * 防连点用的是 useRef 而不是 useState（CLAUDE.md §5.22）：
 * setState 要等下一次渲染才生效，同一瞬间的两次点击读到的都是旧值。
 */
export default function EditTransactionDialog({
  item,
  onClose,
  onSaved,
  onDeleted
}: EditTransactionDialogProps): JSX.Element | null {
  const [kind, setKind] = useState<CategoryKind>(item?.kind ?? 'expense')
  const [amountText, setAmountText] = useState(item === null ? '' : formatYuan(item.amountFen))
  const [categoryId, setCategoryId] = useState<number | null>(item?.categoryId ?? null)
  const [occurredOn, setOccurredOn] = useState(item?.occurredOn ?? '')
  const [note, setNote] = useState(item?.note ?? '')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(item?.paymentMethod ?? 'wechat')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const busyRef = useRef(false)

  if (item === null) return null

  const fen = yuanToFen(amountText)
  const amountInvalid = fen !== null && fen <= 0
  const canSave = fen !== null && fen > 0 && categoryId !== null && occurredOn !== '' && !working

  function switchKind(next: CategoryKind): void {
    if (next === kind) return
    setKind(next)
    // 分类是分收支的，切了之后原来选的那个就不适用了。
    // 不清空的话，用户会拿一个支出分类去存一笔收入 ——
    // 数据库触发器会拦下来，但那时用户只看到一句莫名其妙的报错。
    setCategoryId(null)
    setError('')
  }

  async function save(): Promise<void> {
    if (busyRef.current) return
    if (fen === null || fen <= 0) {
      setError('请输入金额')
      return
    }
    if (categoryId === null) {
      setError('请先选择一个分类')
      return
    }

    busyRef.current = true
    setWorking(true)
    setError('')
    try {
      await window.ht.transactions.update({
        id: item!.id,
        kind,
        amountFen: fen,
        categoryId,
        occurredOn,
        note,
        paymentMethod
      })
      onSaved()
    } catch (e) {
      // 失败时**不关窗口、不清内容** —— 用户改好的东西不能凭空消失
      setError((e as Error).message)
    } finally {
      busyRef.current = false
      setWorking(false)
    }
  }

  async function remove(): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setWorking(true)
    setError('')
    try {
      await window.ht.transactions.remove(item!.id)
      onDeleted()
    } catch (e) {
      setConfirmingDelete(false)
      setError((e as Error).message)
    } finally {
      busyRef.current = false
      setWorking(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-6"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="修改这笔账"
          data-testid="edit-dialog"
          className="my-5 w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl dark:bg-slate-800"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">修改这笔账</h2>
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
              {(['expense', 'income'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  data-testid={`edit-kind-${k}`}
                  aria-pressed={kind === k}
                  onClick={() => switchKind(k)}
                  className={`rounded-md px-4 py-1 text-sm transition-colors ${
                    kind === k
                      ? 'bg-white font-medium text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-400'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {k === 'expense' ? '支出' : '收入'}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <AmountInput
              testId="edit-amount"
              value={amountText}
              onChange={(next) => {
                setAmountText(next)
                setError('')
              }}
              onEnter={() => void save()}
              invalid={amountInvalid}
            />
            <p className="mt-1 text-center text-xs text-slate-400">
              {fen !== null && fen > 0 ? `= ${formatYuan(fen)} 元` : ''}
            </p>
          </div>

          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">分类</h3>
            {/*
              这笔账挂着的分类已经被「删除」（归档）了。
              归档的分类不会出现在下面的选择器里，所以必须在这里单独告诉用户
              原来是什么——否则他只看到「保存失败」，既不知道原因，也认不出
              该不该重选。只改金额/备注时保持原样就好（§5.11）。
            */}
            {item.categoryArchived && categoryId === item.categoryId && (
              <p
                data-testid="edit-archived-category"
                className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              >
                这笔账原来记在「{item.categoryName}」下，这个分类已经被删除了。
                保持原样的话，它仍然记在这个分类下；也可以在下面另选一个。
              </p>
            )}
            {/*
              CategoryPicker 内部的 data-testid 是 pick- 前缀，与记账页重名。
              验证脚本必须先定位到 [data-testid="edit-dialog"] 再在子树里找。
            */}
            <CategoryPicker
              kind={kind}
              selectedId={categoryId}
              active
              refreshKey={0}
              onSelect={(id) => {
                setCategoryId(id)
                setError('')
              }}
            />
          </div>

          <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
            <label htmlFor="edit-date" className="text-sm text-slate-500 dark:text-slate-400">
              日期
            </label>
            <div className="flex items-center gap-3">
              <input
                id="edit-date"
                type="date"
                data-testid="edit-date"
                value={occurredOn}
                onChange={(e) => {
                  setOccurredOn(e.target.value)
                  setError('')
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
              />
              <span className="text-sm text-slate-400">{formatLocalDateForDisplay(occurredOn)}</span>
            </div>

            <label htmlFor="edit-note" className="text-sm text-slate-500 dark:text-slate-400">
              备注
            </label>
            <input
              id="edit-note"
              data-testid="edit-note"
              value={note}
              maxLength={200}
              placeholder="可以不填"
              onChange={(e) => {
                setNote(e.target.value)
                setError('')
              }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
            />

            <span className="text-sm text-slate-500 dark:text-slate-400">支付</span>
            <PaymentMethodPicker
              testIdPrefix="edit-payment"
              value={paymentMethod}
              onChange={(next) => {
                setPaymentMethod(next)
                setError('')
              }}
            />
          </div>

          {error !== '' && (
            <p
              role="alert"
              data-testid="edit-error"
              className="mt-4 whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              data-testid="edit-delete"
              disabled={working}
              onClick={() => setConfirmingDelete(true)}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              删除
            </button>

            <div className="flex gap-3">
              <button
                type="button"
                data-testid="edit-cancel"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="edit-save"
                disabled={!canSave}
                onClick={() => void save()}
                className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
              >
                {working ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        danger
        title="删除这笔账？"
        message={
          `${item.categoryName}　${formatYuan(item.amountFen)} 元\n` +
          `${formatLocalDateForDisplay(item.occurredOn)}${item.note === '' ? '' : `　${item.note}`}\n\n` +
          '删除后无法恢复。'
        }
        confirmLabel="删除"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  )
}
