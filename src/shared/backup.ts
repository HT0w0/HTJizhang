/**
 * 备份/恢复的纯逻辑：文件名与恢复前的确认文案。
 *
 * 这里没有一处碰数据库或文件系统（CLAUDE.md §5.15），但它是整个备份功能里
 * **最该测**的一部分：真正做导入的是 src/main/db/backup.ts，出错会抛异常、看得见；
 * 而文件名和确认文案写错了，程序不会报任何错 —— 用户只是把备份存成了同一个名字
 * 互相覆盖，或者在一句没读明白的提示下点掉了「替换」。
 */

/**
 * 备份文件名用的时间戳：本地时间的 `YYYY-MM-DD-HHmmss`。
 *
 * 必须取**本地**时间。用 UTC 的话，GMT+8 的用户在早上 8 点前备份，
 * 文件名上的日期会是他昨天 —— 补零到秒是因为同一天可能恢复好几次。
 */
export function backupStamp(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** 导出备份时的默认文件名。today 形如 '2026-10-04'。 */
export function backupFileName(today: string): string {
  return `HT记账-备份-${today}.db`
}

/**
 * 恢复前自动另存当前账本时用的文件名。
 *
 * 名字里刻意写明「导入前自动备份」：用户过几个月翻到数据文件夹里这一堆文件时，
 * 得能一眼看出哪一份是软件自动留的、哪一份是自己手动导出的。
 */
export function autoBackupFileName(stamp: string): string {
  return `HT记账-导入前自动备份-${stamp}.db`
}

export interface RestoreWarningInput {
  /** 用户选中的备份文件名。 */
  readonly fileName: string
  /** 备份文件里有几笔账。 */
  readonly backupCount: number
  /** 当前账本里有几笔账。 */
  readonly currentCount: number
  /** 替换前自动另存的那一份叫什么名字。 */
  readonly autoBackupName: string
}

/**
 * 恢复（用备份替换当前账本）前的确认框正文。
 *
 * 这是用户按下「替换」之前读到的最后一段话，而**这一步是不可逆的**：
 * 按下去，他现在账本里的内容就没了。所以四件事缺一不可：
 *
 * 1. **用哪个文件替换** —— 用户手上可能有好几个备份，选错了不会有人拦住他；
 * 2. **两边各有几笔账** —— 这是他判断「选没选错文件」的唯一依据；
 * 3. **说「替换」不说「导入」** —— 「导入」听起来像把备份的数据**加**到现有账本里，
 *    很多软件确实是这个意思。这里是把现有账本整个换掉，措辞含糊会让人丢数据；
 * 4. **当前账本会先自动另存一份，并写出那份的名字** —— 这句是用户敢按下去的关键。
 *
 * 措辞不要随手改。改之前先想清楚：少说了哪一条，用户会在什么情况下丢掉数据。
 */
export function buildRestoreWarning({
  fileName,
  backupCount,
  currentCount,
  autoBackupName
}: RestoreWarningInput): string {
  const first = `将用「${fileName}」替换当前账本。`

  const second = `备份里有 ${backupCount} 笔账，当前账本里有 ${currentCount} 笔账。替换后，账本会变成备份里的内容。`

  // 备份是空的 → 替换后账本会变空。这是最容易让人事后后悔的一种情况
  // （比如选了一个刚建好、还没记过账的备份），必须单独点出来。
  const empty = backupCount === 0 ? '\n\n注意：这份备份里一笔账都没有，替换后你的账本会变空。' : ''

  const safe = `\n\n替换前，当前账本会自动另存为「${autoBackupName}」放在数据文件夹里。万一选错了，还能用它换回来。`

  return `${first}\n\n${second}${empty}${safe}`
}

/** 恢复成功后的提示。软件会紧接着自己重新载入，这句话是重载之后才显示的。 */
export function restoreDoneNotice(fileName: string, count: number): string {
  return `已从「${fileName}」恢复，账本现在是 ${count} 笔账。`
}
