import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryKind, CategoryNode } from '@shared/types'
import { sortByRecency } from '@shared/recentCategories'
import CategoryIconPicker from './CategoryIconPicker'

interface CategoryPickerProps {
  readonly kind: CategoryKind
  readonly selectedId: number | null
  readonly onSelect: (id: number) => void
  /** 记账页当前是不是正在显示的那一页。切回来时要重新拉数据。 */
  readonly active: boolean
  /** 每次成功记账后 +1，用来让「最近用过」的置顶顺序跟上。 */
  readonly refreshKey: number
}

/**
 * 两级分类选择器。
 *
 * 上面一排是大类图标，选中后下面出现它的小类标签。
 * 小类标签末尾有「＋ 新建」，可以就地建一个小类并自动选中 ——
 * 不用先跑去设置页建好再回来。
 *
 * 排序上把「最近用过的」置顶，因为用户每天记的就是那几类。
 */
export default function CategoryPicker({
  kind,
  selectedId,
  onSelect,
  active,
  refreshKey
}: CategoryPickerProps): JSX.Element {
  const [tree, setTree] = useState<readonly CategoryNode[]>([])
  const [recentIds, setRecentIds] = useState<readonly number[]>([])
  const [activeMajorId, setActiveMajorId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('❓')

  const reload = useCallback(async () => {
    const [list, recent] = await Promise.all([
      window.ht.categories.list(),
      window.ht.transactions.recentCategoryIds()
    ])
    setTree(list)
    setRecentIds(recent)
  }, [])

  /**
   * 拉数据的时机：
   * - 组件挂载时（第一次打开软件）
   * - active 从 false 变成 true（用户从别的页面切回来）
   * - refreshKey 变化（刚记完一笔，「最近用过」的顺序要跟上）
   *
   * **必须包含 active**：四个页面常驻挂载，只在挂载时拉一次的话，
   * 用户在设置页新建的大类在记账页里根本看不到 —— 而大类只能从设置页创建，
   * 这是常规操作，用户会以为软件把数据弄丢了。
   */
  useEffect(() => {
    if (!active) return
    reload().catch((e: unknown) => setError((e as Error).message))
  }, [reload, active, refreshKey])

  // 只留当前收支类型的分类，再按「最近用过」重排
  const majors = useMemo(
    () => sortByRecency(tree.filter((n) => n.kind === kind), recentIds),
    [tree, kind, recentIds]
  )

  // 选中的分类所属的大类要自动展开 —— 否则用户选完切回来会看不到自己选了啥
  useEffect(() => {
    if (selectedId === null) return
    const owner = majors.find((m) => m.id === selectedId || m.children.some((c) => c.id === selectedId))
    if (owner) setActiveMajorId(owner.id)
  }, [selectedId, majors])

  // 收支类型换了，之前选中的大类就不适用了
  useEffect(() => {
    setActiveMajorId(null)
    setCreating(false)
    setNewName('')
  }, [kind])

  const activeMajor = majors.find((m) => m.id === activeMajorId) ?? null

  async function createLeaf(): Promise<void> {
    if (!activeMajor) return
    const name = newName.trim()
    if (name === '') return
    try {
      const created = await window.ht.categories.create({
        kind,
        parentId: activeMajor.id,
        name,
        icon: newIcon
      })
      await reload()
      onSelect(created.id) // 新建完直接选中，不用再点一次
      setCreating(false)
      setNewName('')
      setNewIcon('❓')
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2" data-testid="pick-major-grid">
        {majors.map((major) => {
          const active = major.id === activeMajorId
          return (
            <button
              key={major.id}
              type="button"
              data-testid={`pick-major-${major.id}`}
              aria-pressed={active}
              onClick={() => {
                setActiveMajorId(major.id)
                setCreating(false)
                setNewName('')
                setError('')
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  : 'border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-700'
              }`}
            >
              <span aria-hidden="true">{major.icon}</span>
              <span>{major.name}</span>
            </button>
          )
        })}
        {majors.length === 0 && (
          <p data-testid="pick-no-majors" className="text-sm text-slate-400">
            还没有{majorLabel(kind)}分类。去「设置 → 分类管理」加一个吧。
          </p>
        )}
      </div>

      {activeMajor && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex flex-wrap gap-2" data-testid="pick-leaf-list">
            {activeMajor.children.map((child) => {
              const active = child.id === selectedId
              return (
                <button
                  key={child.id}
                  type="button"
                  data-testid={`pick-leaf-${child.id}`}
                  aria-pressed={active}
                  onClick={() => onSelect(child.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  <span aria-hidden="true">{child.icon}</span>
                  <span>{child.name}</span>
                </button>
              )
            })}

            {activeMajor.children.length === 0 && !creating && (
              <p data-testid="pick-no-leaves" className="text-sm text-slate-400">
                这个大类下面还没有小类，点右边「＋ 新建」加一个
              </p>
            )}

            {creating ? (
              <span className="flex items-center gap-1 rounded-lg border border-blue-400 px-2 py-1">
                <CategoryIconPicker value={newIcon} onChange={setNewIcon} testId="leaf-new-icon" />
                <input
                  autoFocus
                  value={newName}
                  data-testid="pick-leaf-create-input"
                  aria-label="新小类名称"
                  placeholder="新小类名字"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createLeaf()
                    }
                    if (e.key === 'Escape') {
                      setCreating(false)
                      setNewName('')
                    }
                  }}
                  className="w-28 rounded border-none bg-transparent px-1 py-0.5 text-sm outline-none"
                />
                <button
                  type="button"
                  data-testid="pick-leaf-create-confirm"
                  onClick={() => void createLeaf()}
                  className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white"
                >
                  建
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-testid="pick-leaf-create"
                onClick={() => {
                  setCreating(true)
                  setError('')
                }}
                className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-500 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-slate-600 dark:text-slate-400"
              >
                ＋ 新建
              </button>
            )}
          </div>
        </div>
      )}

      {error !== '' && (
        <p
          role="alert"
          data-testid="pick-error"
          className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}
    </div>
  )
}

function majorLabel(kind: CategoryKind): string {
  return kind === 'expense' ? '支出' : '收入'
}
