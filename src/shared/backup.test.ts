import { test, expect } from 'vitest'
import {
  autoBackupFileName,
  backupFileName,
  backupStamp,
  buildRestoreWarning,
  isAutoBackupFileName
} from './backup'

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

test('备份文件名带「HT记账」前缀和当天日期，用户在下载文件夹里一眼能找到', () => {
  expect(backupFileName('2026-10-04')).toBe('HT记账-备份-2026-10-04.db')
})

test('恢复前自动另存的那份，名字里写明它是干什么的', () => {
  const name = autoBackupFileName('2026-10-04-153012')
  expect(name).toContain('导入前自动备份')
  expect(name).toContain('2026-10-04-153012')
  expect(name.endsWith('.db')).toBe(true)
})

test('自动另存的文件名精确到秒 —— 同一天恢复两次不会互相覆盖', () => {
  expect(autoBackupFileName('2026-10-04-153012')).not.toBe(
    autoBackupFileName('2026-10-04-153013')
  )
})

test('时间戳是本地时间，不是 UTC（否则 GMT+8 的凌晨会记成前一天）', () => {
  // 2026-10-04 15:30:12 本地时间
  const stamp = backupStamp(new Date(2026, 9, 4, 15, 30, 12))
  expect(stamp).toBe('2026-10-04-153012')
})

test('时间戳的月、日、时、分、秒都补零到两位（3 时 5 分要写成 030005）', () => {
  expect(backupStamp(new Date(2026, 0, 2, 3, 5, 6))).toBe('2026-01-02-030506')
})

// ---------------------------------------------------------------------------
// 恢复前的确认文案 —— 用户按下「替换」之前读到的最后一段话
// ---------------------------------------------------------------------------

const base = {
  fileName: 'HT记账-备份-2026-10-04.db',
  backupCount: 130,
  currentCount: 128,
  autoBackupName: 'HT记账-导入前自动备份-2026-10-04-153012.db'
}

test('正文里写明要用哪个文件替换（用户手上可能有好几个备份）', () => {
  expect(buildRestoreWarning(base)).toContain('HT记账-备份-2026-10-04.db')
})

test('把「当前有几笔、备份里有几笔」都说出来 —— 用户靠这个判断自己选没选错文件', () => {
  const text = buildRestoreWarning(base)
  expect(text).toContain('128')
  expect(text).toContain('130')
})

test('明说当前账本会被换掉，不能含糊成「导入数据」（导入听着像合并，实际是替换）', () => {
  const text = buildRestoreWarning(base)
  expect(text).toContain('替换')
  expect(text).not.toContain('合并')
})

test('告诉用户当前账本会先自动另存一份，并且把那份的名字写出来（敢按下去的关键）', () => {
  const text = buildRestoreWarning(base)
  expect(text).toContain('HT记账-导入前自动备份-2026-10-04-153012.db')
})

test('备份里一笔账都没有时，额外提醒一句「账本会变空」', () => {
  const text = buildRestoreWarning({ ...base, backupCount: 0 })
  expect(text).toContain('变空')
})

test('当前账本是空的、但备份不是空的时，不加「账本会变空」那句', () => {
  const text = buildRestoreWarning({ ...base, currentCount: 0 })
  expect(text).not.toContain('变空')
  expect(text).toContain('130')
})

// ---------------------------------------------------------------------------
// 自动备份文件名这道关
//
// 恢复时这个名字要**从界面传回主进程**（确认框里显示的那个，必须就是最后真正
// 写盘的那个 —— 否则用户照提示去数据文件夹里找会找不到）。而主进程拿到一个
// 界面给的字符串就往数据目录里拼路径，得先确认它确实是「我们自己产出的那种名字」。
// ---------------------------------------------------------------------------

test('认得出自己产出的自动备份文件名', () => {
  expect(isAutoBackupFileName(autoBackupFileName(backupStamp(new Date())))).toBe(true)
  expect(isAutoBackupFileName('HT记账-导入前自动备份-2026-10-04-173930.db')).toBe(true)
})

test('不认路径、不认别的文件名（主进程不能拿界面给的字符串随便往数据目录里拼）', () => {
  expect(isAutoBackupFileName('..\\..\\别的地方.db')).toBe(false)
  expect(isAutoBackupFileName('../../etc/passwd')).toBe(false)
  expect(isAutoBackupFileName('C:\\Windows\\System32\\x.db')).toBe(false)
  expect(isAutoBackupFileName('HT记账-导入前自动备份-2026-10-04.db')).toBe(false)
  expect(isAutoBackupFileName('HT记账-导入前自动备份-2026-10-04-173930.db.exe')).toBe(false)
  expect(isAutoBackupFileName('')).toBe(false)
})
