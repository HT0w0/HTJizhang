import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { RestorePreview } from '@shared/types'
import { buildRestoreWarning, restoreDoneNotice } from '@shared/backup'
import { formatMonthForDisplay } from '@shared/month'
import { ACTIVE_PAGE_KEY, RESTORE_NOTICE_KEY } from '../sessionKeys'
import ConfirmDialog from './ConfirmDialog'

/** '全部账单' 在下拉框里的取值。空串而不是 null —— <select> 的 value 只能是字符串。 */
const ALL_MONTHS = ''

export default function DataBackup(): JSX.Element {
  /** 有账的月份，从新到旧。用来填「导出表格」的月份下拉框。 */
  const [months, setMonths] = useState<readonly string[]>([])
  /** 导出表格时选中的月份。空串表示全部账单。 */
  const [csvMonth, setCsvMonth] = useState<string>(ALL_MONTHS)
  /** 正在进行的操作名（空串表示闲着）。用来把按钮置灰。 */
  const [busy, setBusy] = useState('')
  /** 成功的提示语。不自动消失 —— 用户得来得及看清存到哪儿了。 */
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  /** 用户选好了备份文件、正等着确认替换（null 表示没弹确认框）。 */
  const [pendingRestore, setPendingRestore] = useState<RestorePreview | null>(null)

  /**
   * 防连点闸门。必须用 useRef 而不是 state（CLAUDE.md §5.22）：
   * setState 是异步的，React 要等下一次渲染才更新，同一瞬间的两次点击
   * 读到的都还是旧值，函数开头的拦截和按钮的 disabled **两道防线都会失效**。
   *
   * 这里的后果尤其重：连点两下「从备份恢复」会弹两个文件框；连点两下「导出」
   * 会弹两个保存框，用户在第二个框里选完，第一个框还在后面等着。
   */
  const busyRef = useRef(false)

  // 重载之后把恢复成功的提示接过来显示。
  useEffect(() => {
    const carried = sessionStorage.getItem(RESTORE_NOTICE_KEY)
    if (carried !== null) {
      sessionStorage.removeItem(RESTORE_NOTICE_KEY)
      setNotice(carried)
    }
  }, [])

  // 拉了月份，下拉框里才列得出「有哪些月份可以导」。
  useEffect(() => {
    let cancelled = false
    window.ht.transactions
      .months()
      .then((list) => {
        if (!cancelled) setMonths(list)
      })
      .catch(() => {
        // 月份拉不到只影响下拉框能选什么，不该挡住导出全部账单这条路，
        // 所以这里刻意不显示错误：下拉框会只剩「全部账单」一项，功能仍然可用。
        if (!cancelled) setMonths([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 所有按钮的统一入口：先过闸门，再把错误收成一句中文。
   *
   * fn 返回 false 表示「用户取消了」，那不是失败，不该弹红色的东西 ——
   * 一次误弹报错会让用户以为自己的账本出了问题。
   */
  const run = async (name: string, fn: () => Promise<void | false>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(name)
    setError('')
    // 先清掉上一次的提示：上一次导出的路径还挂在屏幕上，用户会以为这次也存到那儿了
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy('')
    }
  }

  const exportDatabase = (): Promise<void> =>
    run('db', async () => {
      const result = await window.ht.backup.exportDatabase()
      // 用户在保存框里点了取消：正常操作，什么都不说
      if (result.cancelled) return false
      setNotice(`备份已保存到：${result.path}`)
    })

  const exportCsv = (): Promise<void> =>
    run('csv', async () => {
      const month = csvMonth === ALL_MONTHS ? null : csvMonth
      const result = await window.ht.backup.exportCsv(month)
      if (result.cancelled) return false
      setNotice(`表格已保存到：${result.path}（可以用 Excel 或 WPS 打开）`)
    })

  const openFolder = (): Promise<void> =>
    run('folder', async () => {
      await window.ht.backup.openDataFolder()
    })

  const pickRestore = (): Promise<void> =>
    run('pick', async () => {
      const preview = await window.ht.backup.pickRestoreFile()
      // 取消，或者选了个不是备份的文件（那种情况 pickRestoreFile 会抛错，走 catch）
      if (preview === null) return false
      setPendingRestore(preview)
    })

  const confirmRestore = async (): Promise<void> => {
    const preview = pendingRestore
    if (preview === null || busyRef.current) return
    busyRef.current = true
    setBusy('restore')
    setError('')
    try {
      // 自动备份的名字用预览时给用户看过的那个，不在这里重新取时间 ——
      // 重新取会让确认框里写的名字和磁盘上的差一秒，用户照着找会找不到。
      const done = await window.ht.backup.restore(preview.path, preview.autoBackupFileName)
      sessionStorage.setItem(RESTORE_NOTICE_KEY, restoreDoneNotice(done.fileName, done.count))
      // 重载之后必须回到设置页：提示就挂在下面这一页上。不写这一下，重载会落到
      // 默认的「记一笔」页，而提示在被 hidden 的设置页里 —— 用户什么也看不到。
      sessionStorage.setItem(ACTIVE_PAGE_KEY, 'settings')
      // 必须重新载入：四个页面都常驻挂载、各自存着上一个账本的数据，
      // 原地刷新会有页面漏掉，用户会看到「账单页还是旧的、统计页是新的」。
      location.reload()
    } catch (e) {
      setPendingRestore(null)
      setError(e instanceof Error ? e.message : String(e))
      busyRef.current = false
      setBusy('')
    }
  }

  return (
    <div data-testid="backup-section">
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        数据只存在这台电脑上。建议隔一段时间导出一份备份，存到 U 盘或网盘里。
      </p>

      <div className="mt-4 space-y-4">
        {/* ---- 导出备份文件 ---- */}
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="text-sm font-medium">导出备份文件</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            把整个账本导出成一个文件。以后换电脑、重装系统，用它就能把账全部恢复回来。
          </p>
          <button
            type="button"
            data-testid="export-db"
            disabled={busy !== ''}
            onClick={() => void exportDatabase()}
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            导出备份文件
          </button>
        </div>

        {/* ---- 导出表格 ---- */}
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="text-sm font-medium">导出表格</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            导出成表格文件，可以用 Excel、WPS 打开看。这个文件只能看，不能拿它恢复账本。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="csv-month" className="text-sm text-slate-600 dark:text-slate-300">
              导出范围
            </label>
            <select
              id="csv-month"
              data-testid="csv-month"
              value={csvMonth}
              disabled={busy !== ''}
              onChange={(e) => setCsvMonth(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
            >
              <option value={ALL_MONTHS}>全部账单</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonthForDisplay(m)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="export-csv"
              disabled={busy !== ''}
              onClick={() => void exportCsv()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              导出表格
            </button>
          </div>
        </div>

        {/* ---- 数据文件夹 ---- */}
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="text-sm font-medium">数据文件夹</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            账本文件就放在这个文件夹里。点开看看，那里也能找到自动留存的备份。
          </p>
          <button
            type="button"
            data-testid="open-folder"
            disabled={busy !== ''}
            onClick={() => void openFolder()}
            className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            打开数据文件夹
          </button>
        </div>

        {/* ---- 从备份恢复 ---- */}
        <div className="rounded-lg border border-red-200 p-4 dark:border-red-900">
          <h3 className="text-sm font-medium">从备份恢复</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            用一份备份文件<strong className="font-medium">替换</strong>现在的账本。替换之后，
            现在账本里的内容就变成备份里的内容了。替换前会自动把当前账本另存一份，
            选错了还能换回来。
          </p>
          <button
            type="button"
            data-testid="restore-pick"
            disabled={busy !== ''}
            onClick={() => void pickRestore()}
            className="mt-3 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
          >
            从备份恢复
          </button>
        </div>
      </div>

      {notice !== '' && (
        <p
          role="status"
          data-testid="backup-notice"
          className="mt-4 break-all rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
        >
          ✓ {notice}
        </p>
      )}

      {error !== '' && (
        <p
          role="alert"
          data-testid="backup-error"
          className="mt-4 whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <ConfirmDialog
        open={pendingRestore !== null}
        danger
        title="确定要用这份备份替换当前账本吗？"
        confirmLabel="替换"
        message={
          pendingRestore === null
            ? ''
            : buildRestoreWarning({
                fileName: pendingRestore.fileName,
                backupCount: pendingRestore.backupCount,
                currentCount: pendingRestore.currentCount,
                autoBackupName: pendingRestore.autoBackupFileName
              })
        }
        onConfirm={() => void confirmRestore()}
        onCancel={() => setPendingRestore(null)}
      />
    </div>
  )
}
