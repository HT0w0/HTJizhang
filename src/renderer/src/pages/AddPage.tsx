import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryKind, PaymentMethod } from '@shared/types'
import { formatYuan, yuanToFen } from '@shared/money'
import { formatLocalDateForDisplay } from '@shared/localDate'
import AmountInput from '../components/AmountInput'
import type { AmountInputHandle } from '../components/AmountInput'
import CategoryPicker from '../components/CategoryPicker'
import PaymentMethodPicker from '../components/PaymentMethodPicker'
import SaveToast from '../components/SaveToast'

export default function AddPage({ active }: { active: boolean }): JSX.Element {
  const [kind, setKind] = useState<CategoryKind>('expense')
  const [amountText, setAmountText] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [occurredOn, setOccurredOn] = useState('')
  const [note, setNote] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('wechat')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [categoryName, setCategoryName] = useState('')
  /** 每记完一笔 +1，用来让分类选择器的「最近用过」置顶顺序跟上。 */
  const [recentKey, setRecentKey] = useState(0)

  /**
   * 用户有没有手动改过日期。
   *
   * 用来处理「跨零点记账」：用户 23:59 打开页面没关，00:01 才按保存，
   * 日期必须是新的一天。他没手动改过，就说明期望的是「今天」。
   */
  const dateTouched = useRef(false)
  const amountRef = useRef<AmountInputHandle>(null)

  /**
   * 防连点的闸门。**必须是 ref，不能用 state。**
   *
   * setSaving(true) 是异步的，React 要等下一次渲染才更新 ——
   * 同一瞬间的两次点击读到的 state 都还是 false，两道防线（函数开头的
   * if (saving) return 和按钮的 disabled={!canSave}）全都拦不住，
   * 于是同一笔账被记两次。而重复记账是**当场看不出来的错**：
   * 等月底发现账目对不上时，已经找不到多出来的是哪一笔。
   *
   * ref 的赋值是同步生效的，第二次点击进来立刻就能看到 true。
   * 这是实测出来的 —— 验证脚本里连点两下确实记了两笔。
   */
  const savingRef = useRef(false)

  const focusAmount = useCallback(() => {
    amountRef.current?.focus()
  }, [])

  // 打开页面就把光标放进金额框，可以一直不碰鼠标
  useEffect(() => {
    focusAmount()
    window.ht.transactions
      .today()
      .then(setOccurredOn)
      .catch((e: unknown) => setError((e as Error).message))
  }, [focusAmount])

  async function save(): Promise<void> {
    // 硬性防连点。用 ref 判断而不是 state —— state 的更新是异步的，
    // 同一瞬间的第二次点击读到的还是旧值，拦不住（详见 savingRef 的注释）。
    if (savingRef.current) return

    const fen = yuanToFen(amountText)
    if (fen === null || fen <= 0) {
      setError('请输入金额')
      focusAmount()
      return
    }
    if (categoryId === null) {
      setError('请先选择一个分类')
      return
    }

    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      // 用户没手动改过日期时，重新取一次「今天」—— 解决跨零点的问题
      let dateToUse = occurredOn
      if (!dateTouched.current) {
        dateToUse = await window.ht.transactions.today()
        setOccurredOn(dateToUse)
      }

      const created = await window.ht.transactions.create({
        kind,
        amountFen: fen,
        categoryId,
        occurredOn: dateToUse,
        note,
        paymentMethod
      })

      // 用户确认过：清掉金额、备注、分类（分类必须清，否则忘了改就会静默记错），
      // 保留支付方式（一顿饭之内通常不变，留着能少点两下）
      setToast(`已记下：${categoryName || '这笔'} ${formatYuan(created.amountFen)} 元`)
      setAmountText('')
      setNote('')
      setCategoryId(null)
      setCategoryName('')

      // 日期只保留「今天」：把日期重新设成今天并清掉手动改过的标记。
      // 用户确认过这个取舍 —— 补记一笔旧账后如果日期一直留着，
      // 后面每一笔都会被静默记到那个旧日期，等月底对总账才发现，
      // 而且已经找不到是哪几笔。宁可让他重新选一次。
      const today = await window.ht.transactions.today()
      setOccurredOn(today)
      dateTouched.current = false

      setRecentKey((n) => n + 1)
      focusAmount()
    } catch (e) {
      // 失败时**保留所有已填内容** —— 不能让用户填好的账凭空消失
      setError((e as Error).message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const fen = yuanToFen(amountText)
  // 只在「确实算出了 0 元」时标红。打字中间态（"12."、"."）算不出数，
  // 但那不算错，标红只会让人以为打错了。
  const amountInvalid = fen !== null && fen <= 0
  const canSave = fen !== null && fen > 0 && categoryId !== null && !saving

  function switchKind(next: CategoryKind): void {
    if (next === kind) return
    setKind(next)
    // 分类是分收支的，切了之后原来的选中就不适用了
    setCategoryId(null)
    setCategoryName('')
    setToast('')
    setError('')
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">记一笔</h1>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {(['expense', 'income'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              data-testid={`kind-${k}`}
              onClick={() => switchKind(k)}
              className={`rounded-md px-5 py-1.5 text-sm transition-colors ${
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

      <div className="mt-8">
        <AmountInput
          ref={amountRef}
          value={amountText}
          onChange={(next) => {
            setAmountText(next)
            setError('')
            setToast('')
          }}
          onEnter={() => void save()}
          invalid={amountInvalid}
        />
        <p
          data-testid="amount-preview"
          className="mt-2 text-center text-sm text-slate-400"
        >
          {fen !== null && fen > 0 ? `= ${formatYuan(fen)} 元` : ''}
        </p>
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">选择分类</h2>
        <CategoryPicker
          kind={kind}
          selectedId={categoryId}
          active={active}
          refreshKey={recentKey}
          onSelect={(id) => {
            setCategoryId(id)
            setError('')
            setToast('')
            void resolveCategoryName(id).then(setCategoryName)
          }}
        />
      </div>

      <div className="mt-6 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
        <label htmlFor="occurred-on" className="text-sm text-slate-500 dark:text-slate-400">
          日期
        </label>
        <div className="flex items-center gap-3">
          <input
            id="occurred-on"
            type="date"
            data-testid="date"
            value={occurredOn}
            onChange={(e) => {
              dateTouched.current = true
              setOccurredOn(e.target.value)
              setError('')
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
          />
          <span data-testid="date-display" className="text-sm text-slate-400">
            {formatLocalDateForDisplay(occurredOn)}
          </span>
        </div>

        <label htmlFor="note" className="text-sm text-slate-500 dark:text-slate-400">
          备注
        </label>
        <input
          id="note"
          data-testid="note"
          value={note}
          placeholder="可以不填"
          maxLength={200}
          onChange={(e) => {
            setNote(e.target.value)
            setError('')
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
        />

        <span className="text-sm text-slate-500 dark:text-slate-400">支付</span>
        <PaymentMethodPicker
          value={paymentMethod}
          onChange={(next) => {
            setPaymentMethod(next)
            setError('')
          }}
        />
      </div>

      <div className="mt-6 space-y-3">
        {error !== '' && (
          <p
            role="alert"
            data-testid="add-error"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        )}
        <SaveToast text={toast} />
      </div>

      <div className="mt-6 flex flex-col items-center gap-2">
        <button
          type="button"
          data-testid="save"
          disabled={!canSave}
          onClick={() => void save()}
          className="rounded-xl bg-blue-600 px-16 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保 存'}
        </button>

        {/*
          按钮禁用时必须说清「还差什么」。
          浏览器不会给禁用的按钮派发点击事件，所以鼠标用户点了毫无反应、
          屏幕上也没有任何字告诉他缺了什么，只能自己猜。
        */}
        <p data-testid="save-hint" className="text-xs text-slate-400">
          {missingRequirement(fen, categoryId) ?? '在金额框里按回车也能保存'}
        </p>
      </div>
    </section>
  )
}

/**
 * 保存按钮为什么不能点。都满足时返回 null。
 *
 * 存在的理由：浏览器的禁用按钮不会派发点击事件，不给提示的话
 * 鼠标用户点了完全没反应、也不知道缺什么。
 */
function missingRequirement(fen: number | null, categoryId: number | null): string | null {
  if (fen === null || fen <= 0) return '还差一步：请输入金额'
  if (categoryId === null) return '还差一步：请选择分类'
  return null
}

/** 取分类名字，用于保存后的确认条。取不到就返回空串，不影响记账。 */
async function resolveCategoryName(id: number): Promise<string> {
  try {
    const tree = await window.ht.categories.list()
    for (const major of tree) {
      if (major.id === id) return major.name
      const child = major.children.find((c) => c.id === id)
      if (child) return `${major.name} · ${child.name}`
    }
  } catch {
    /* 只是显示用，取不到就算了 */
  }
  return ''
}
