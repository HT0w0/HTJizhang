import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryKind, CategoryNode } from '@shared/types'
import { buildDeleteWarning } from '@shared/deleteWarning'
import CategoryIconPicker from './CategoryIconPicker'
import ConfirmDialog from './ConfirmDialog'

interface PendingDelete {
  readonly node: CategoryNode
  readonly childCount: number
  readonly usage: number
}

/** 上移/下移：把数组里的一项与相邻项交换。越界时原样返回。 */
function swap<T>(list: readonly T[], index: number, delta: number): T[] | null {
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return null
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export default function CategoryManager(): JSX.Element {
  const [kind, setKind] = useState<CategoryKind>('expense')
  const [tree, setTree] = useState<readonly CategoryNode[]>([])
  const [archived, setArchived] = useState<readonly CategoryNode[]>([])
  const [usage, setUsage] = useState<Record<number, number>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingIcon, setEditingIcon] = useState('❓')
  const [editingOriginalIcon, setEditingOriginalIcon] = useState('❓')

  const [newMajorName, setNewMajorName] = useState('')
  const [newMajorIcon, setNewMajorIcon] = useState('❓')
  const [newChildName, setNewChildName] = useState('')
  const [newChildIcon, setNewChildIcon] = useState('❓')

  const [draggingId, setDraggingId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    const [list, archivedList, counts] = await Promise.all([
      window.ht.categories.list(),
      window.ht.categories.listArchived(),
      window.ht.categories.usage()
    ])
    setTree(list)
    setArchived(archivedList)
    setUsage(counts)
  }, [])

  useEffect(() => {
    reload().catch((e: unknown) => setError((e as Error).message))
  }, [reload])

  const majors = useMemo(() => tree.filter((n) => n.kind === kind), [tree, kind])
  const selected = useMemo(
    () => majors.find((n) => n.id === selectedId) ?? majors[0] ?? null,
    [majors, selectedId]
  )

  /** 统一的操作包装：清提示、跑动作、重新拉数据、失败显示中文原因。 */
  async function run(action: () => Promise<unknown>, successMessage = ''): Promise<boolean> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      await reload()
      if (successMessage !== '') setNotice(successMessage)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把 ids 列表里 id 的位置挪动 delta 位，并落库。
   *
   * parentId 必须由调用方显式传入（大类的兄弟层是 null，小类的兄弟层是其父大类 id）。
   * 早先的写法是内部直接取「当前选中的大类 id」当父级，结果在大类行上按 ↑↓ 时
   * 会发出「把 11 个大类 id 排到某个大类下面」这种自相矛盾的请求，被仓库层拒绝，
   * 用户看到的是每次点都报错、顺序纹丝不动。**不要再从 selected 里推父级。**
   */
  async function moveById(
    ids: readonly number[],
    id: number,
    delta: number,
    parentId: number | null
  ): Promise<void> {
    const next = swap(ids, ids.indexOf(id), delta)
    if (!next) return
    await run(() => window.ht.categories.reorder(kind, parentId, next))
  }

  async function handleDrop(draggedId: number, targetId: number): Promise<void> {
    if (!selected || draggedId === targetId) return
    const ids = selected.children.map((c) => c.id)
    const from = ids.indexOf(draggedId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, draggedId)
    await run(() => window.ht.categories.reorder(kind, selected.id, next))
  }

  /** 开始编辑某条分类（大类和二级小类共用）。 */
  function beginEdit(node: CategoryNode): void {
    setEditingId(node.id)
    setEditingName(node.name)
    setEditingIcon(node.icon)
    setEditingOriginalIcon(node.icon)
  }

  /**
   * 保存编辑：改名 + （只有真改过才）改图标。
   *
   * 图标没变时不发第二个请求 —— 少一次无谓的写库，
   * 也少一次「明明没改却也走进失败分支」的机会。
   */
  async function saveEdit(id: number): Promise<void> {
    const name = editingName
    const icon = editingIcon
    const iconChanged = icon !== editingOriginalIcon
    const ok = await run(async () => {
      await window.ht.categories.rename(id, name)
      if (iconChanged) await window.ht.categories.setIcon(id, icon)
    })
    if (ok) setEditingId(null)
  }

  function askDelete(node: CategoryNode): void {
    const subtreeUsage = [node, ...node.children].reduce((sum, n) => sum + (usage[n.id] ?? 0), 0)
    setPendingDelete({ node, childCount: node.children.length, usage: subtreeUsage })
  }

  async function confirmDelete(): Promise<void> {
    const pending = pendingDelete
    setPendingDelete(null)
    if (!pending) return
    const ok = await run(() => window.ht.categories.archive(pending.node.id))
    if (ok && selectedId === pending.node.id) setSelectedId(null)
  }

  return (
    <div className="mt-4" data-testid="category-manager">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {(['expense', 'income'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              data-testid={`kind-tab-${k}`}
              onClick={() => {
                setKind(k)
                setSelectedId(null)
                setNotice('')
                setError('')
              }}
              className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                kind === k
                  ? 'bg-white font-medium text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-400'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {k === 'expense' ? '支出分类' : '收入分类'}
            </button>
          ))}
        </div>

        <button
          type="button"
          data-testid="restore-builtins"
          disabled={busy}
          onClick={() => {
            let added = 0
            void run(() => window.ht.categories.restoreBuiltins().then((n) => (added = n))).then(
              (ok) => {
                if (ok) setNotice(`内置分类已恢复（新补回 ${added} 条）`)
              }
            )
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
        >
          恢复内置分类
        </button>
      </div>

      {error !== '' && (
        <p
          role="alert"
          data-testid="error-banner"
          className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {notice !== '' && (
        <p
          data-testid="notice-banner"
          className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
        >
          {notice}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        {/* ---------- 左栏：一级大类 ---------- */}
        <div className="w-full shrink-0 lg:w-64">
          <ul className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
            {majors.map((major, index) => (
              <li
                key={major.id}
                className={`group flex flex-col gap-1 px-2 py-1.5 text-sm transition-colors ${
                  selected?.id === major.id
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                {/* 编辑态直接替换整行内容，不用浮层 ——
                    外层 ul 有 overflow-y-auto，浮层会被裁掉 */}
                {editingId === major.id ? (
                  <div className="flex w-full items-center gap-1">
                    <CategoryIconPicker
                      value={editingIcon}
                      onChange={setEditingIcon}
                      testId={`major-icon-${major.id}`}
                    />
                    <input
                      autoFocus
                      value={editingName}
                      aria-label="大类名称"
                      data-testid={`major-rename-input-${major.id}`}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void saveEdit(major.id)
                        }
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="min-w-0 flex-1 rounded border border-blue-500 px-2 py-0.5 text-slate-800 dark:bg-slate-700 dark:text-slate-100"
                    />
                  </div>
                ) : (
                <div className="flex w-full items-center gap-1">
                <button
                  type="button"
                  data-testid={`major-${major.id}`}
                  draggable
                  onDragStart={() => setDraggingId(major.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const ids = majors.map((m) => m.id)
                    if (draggingId === null || draggingId === major.id) return
                    const from = ids.indexOf(draggingId)
                    const to = ids.indexOf(major.id)
                    const next = [...ids]
                    next.splice(from, 1)
                    next.splice(to, 0, draggingId)
                    setDraggingId(null)
                    void run(() => window.ht.categories.reorder(kind, null, next))
                  }}
                  onClick={() => setSelectedId(major.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span aria-hidden="true">{major.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{major.name}</span>
                  <span className="shrink-0 text-xs opacity-70">{usage[major.id] ?? 0}</span>
                </button>

                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`把「${major.name}」上移`}
                    data-testid={`major-up-${major.id}`}
                    disabled={busy || index === 0}
                    onClick={() =>
                      void moveById(
                        majors.map((m) => m.id),
                        major.id,
                        -1,
                        null
                      )
                    }
                    className="rounded px-0.5 opacity-60 hover:bg-black/10 disabled:opacity-20"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`把「${major.name}」下移`}
                    data-testid={`major-down-${major.id}`}
                    disabled={busy || index === majors.length - 1}
                    onClick={() =>
                      void moveById(
                        majors.map((m) => m.id),
                        major.id,
                        1,
                        null
                      )
                    }
                    className="rounded px-0.5 opacity-60 hover:bg-black/10 disabled:opacity-20"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`重命名「${major.name}」`}
                    data-testid={`major-rename-${major.id}`}
                    onClick={() => beginEdit(major)}
                    className="rounded px-0.5 opacity-60 hover:bg-black/20"
                  >
                    ✏️
                  </button>
                  <button
                    type="button"
                    aria-label={`删除「${major.name}」`}
                    data-testid={`major-delete-${major.id}`}
                    onClick={() => askDelete(major)}
                    className="rounded px-0.5 opacity-60 hover:bg-black/20"
                  >
                    🗑️
                  </button>
                </span>
                </div>
                )}
              </li>
            ))}

            {majors.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-slate-400">这一边还没有分类</li>
            )}
          </ul>

          <div className="mt-2 flex items-start gap-2">
            <CategoryIconPicker value={newMajorIcon} onChange={setNewMajorIcon} testId="new-major-icon" />
            <input
              value={newMajorName}
              data-testid="new-major-name"
              onChange={(e) => setNewMajorName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newMajorName.trim() !== '') {
                  const name = newMajorName
                  void run(() =>
                    window.ht.categories.create({ kind, parentId: null, name, icon: newMajorIcon })
                  ).then((ok) => {
                    if (ok) setNewMajorName('')
                  })
                }
              }}
              placeholder="新增大类"
              aria-label="新增大类名称"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
            />
            <button
              type="button"
              data-testid="new-major-add"
              disabled={busy || newMajorName.trim() === ''}
              onClick={() => {
                const name = newMajorName
                void run(() =>
                  window.ht.categories.create({ kind, parentId: null, name, icon: newMajorIcon })
                ).then((ok) => {
                  if (ok) setNewMajorName('')
                })
              }}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
            >
              ＋
            </button>
          </div>
        </div>

        {/* ---------- 右栏：选中大类下的二级小类 ---------- */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <>
              <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
                {selected.icon} {selected.name} 的小类
                <span className="ml-2 text-xs text-slate-400">
                  （可拖动，也可按 ↑↓ 调整顺序）
                </span>
              </h2>

              <ul className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700">
                {selected.children.map((child, index) => (
                  <li
                    key={child.id}
                    data-testid={`child-${child.id}`}
                    draggable
                    onDragStart={() => setDraggingId(child.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (draggingId === null) return
                      void handleDrop(draggingId, child.id)
                    }}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 dark:border-slate-700"
                  >
                    <span aria-hidden="true" className="cursor-grab text-slate-300">
                      ⠿
                    </span>
                    {editingId === child.id ? (
                      <>
                        <CategoryIconPicker
                          value={editingIcon}
                          onChange={setEditingIcon}
                          testId={`child-icon-${child.id}`}
                        />
                        <input
                          autoFocus
                          value={editingName}
                          aria-label="分类名称"
                          data-testid={`rename-input-${child.id}`}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void saveEdit(child.id)
                            }
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="min-w-0 flex-1 rounded border border-blue-400 px-2 py-0.5 dark:bg-slate-700"
                        />
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true">{child.icon}</span>
                        <span className="min-w-0 flex-1 truncate">{child.name}</span>
                      </>
                    )}

                    <span className="shrink-0 text-xs text-slate-400">{usage[child.id] ?? 0} 笔</span>

                    <button
                      type="button"
                      aria-label={`把「${child.name}」上移`}
                      data-testid={`up-${child.id}`}
                      disabled={busy || index === 0}
                      onClick={() =>
                        void moveById(
                          selected.children.map((c) => c.id),
                          child.id,
                          -1,
                          selected.id
                        )
                      }
                      className="shrink-0 rounded px-1 text-slate-400 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`把「${child.name}」下移`}
                      data-testid={`down-${child.id}`}
                      disabled={busy || index === selected.children.length - 1}
                      onClick={() =>
                        void moveById(
                          selected.children.map((c) => c.id),
                          child.id,
                          1,
                          selected.id
                        )
                      }
                      className="shrink-0 rounded px-1 text-slate-400 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-700"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`重命名「${child.name}」`}
                      data-testid={`rename-${child.id}`}
                      onClick={() => {
                        beginEdit(child)
                      }}
                      className="shrink-0 rounded px-1 text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      aria-label={`删除「${child.name}」`}
                      data-testid={`delete-${child.id}`}
                      onClick={() => askDelete(child)}
                      className="shrink-0 rounded px-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    >
                      🗑️
                    </button>
                  </li>
                ))}

                {selected.children.length === 0 && (
                  <li
                    data-testid="children-empty"
                    className="px-3 py-8 text-center text-sm text-slate-400"
                  >
                    这个大类下面还没有小类，在下面加一个吧
                  </li>
                )}
              </ul>

              <div className="mt-3 flex items-start gap-2">
                <CategoryIconPicker
                  value={newChildIcon}
                  onChange={setNewChildIcon}
                  testId="new-child-icon"
                />
                <input
                  value={newChildName}
                  data-testid="new-child-name"
                  onChange={(e) => setNewChildName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newChildName.trim() !== '') {
                      const name = newChildName
                      void run(() =>
                        window.ht.categories.create({
                          kind,
                          parentId: selected.id,
                          name,
                          icon: newChildIcon
                        })
                      ).then((ok) => {
                        if (ok) setNewChildName('')
                      })
                    }
                  }}
                  placeholder="新增小类名称"
                  aria-label="新增小类名称"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700"
                />
                <button
                  type="button"
                  data-testid="new-child-add"
                  disabled={busy || newChildName.trim() === ''}
                  onClick={() => {
                    const name = newChildName
                    void run(() =>
                      window.ht.categories.create({
                        kind,
                        parentId: selected.id,
                        name,
                        icon: newChildIcon
                      })
                    ).then((ok) => {
                      if (ok) setNewChildName('')
                    })
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
                >
                  添加
                </button>
              </div>
            </>
          ) : (
            <p
              data-testid="majors-empty"
              className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-400 dark:border-slate-600"
            >
              左边还没有大类，先在左边加一个
            </p>
          )}
        </div>
      </div>

      {/* ---------- 已删除的分类 ---------- */}
      {archived.length > 0 && (
        <details className="mt-6" data-testid="archived-section">
          <summary className="cursor-pointer text-sm text-slate-500 dark:text-slate-400">
            已删除的分类（{archived.length}）
          </summary>
          <ul className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700">
            {archived.map((node) => (
              <li
                key={node.id}
                data-testid={`archived-${node.id}`}
                className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 dark:border-slate-700"
              >
                <span aria-hidden="true">{node.icon}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">
                  {node.name}
                  {node.kind === 'expense' ? '（支出）' : '（收入）'}
                  {node.children.length > 0 && (
                    <span className="ml-1 text-xs text-slate-400">
                      含 {node.children.length} 个小类
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  data-testid={`restore-${node.id}`}
                  disabled={busy}
                  onClick={() => void run(() => window.ht.categories.restore(node.id), '已恢复')}
                  className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除分类"
        message={
          pendingDelete
            ? buildDeleteWarning({
                name: pendingDelete.node.name,
                childCount: pendingDelete.childCount,
                usage: pendingDelete.usage
              })
            : ''
        }
        confirmLabel="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
