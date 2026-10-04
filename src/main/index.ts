import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { disposeDatabaseIn, initDatabaseIn } from './db'
import { registerIpcHandlers, type DatabaseHolder } from './ipc-register'

/**
 * 当前打开的数据库。
 *
 * 由主进程持有唯一一份引用，通过 IPC 提供给界面 ——
 * 渲染进程永远碰不到数据库和文件系统（CLAUDE.md §5.3）。
 *
 * ⚠️ 第 6 阶段的「从备份恢复」会把连接整个换掉，所以这里持有的是
 * 一个**可变的对象**而不是数据库本身：IPC 层拿到这个对象的引用之后，
 * 恢复时改的是 `holder.db`，这里和 IPC 层看到的是同一个新连接。
 * 换成两个各自独立的变量就会各指各的，退出时关的是已经作废的那个。
 */
let holder: DatabaseHolder | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'HT记账',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 等界面渲染完再显示，避免用户看到一闪而过的空白窗口
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 界面里出现的站外链接一律用系统浏览器打开，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 显式锁定程序名。
 *
 * 必须在任何一次 app.getPath('userData') 之前调用。
 *
 * 为什么不能省：数据目录是「系统应用数据目录 + 程序名」拼出来的，
 * 而程序名默认是从 package.json 的 productName 推断的。只要推断失败
 * （例如用 `electron.exe out/main/index.js` 直接启动，读不到 package.json），
 * Electron 会静默退回成默认名 "Electron"，数据库就被写到
 * %APPDATA%\Electron\ 下 —— 用户会以为账本凭空消失了。
 *
 * 这意味着「数据目录取决于怎么启动程序」，是记账软件绝不能接受的。
 * 写死这一行，让任何启动方式都落到同一个目录（CLAUDE.md §5.7、§5.8）。
 */
app.setName('HTJizhang')

// 单实例锁：防止两个窗口同时打开同一份数据（CLAUDE.md §5.14）
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.ht.jizhang')

    try {
      holder = {
        db: initDatabaseIn(app.getPath('userData')),
        userDataDir: app.getPath('userData')
      }
      registerIpcHandlers(holder)
    } catch (error) {
      // 数据库都打不开，界面起来也没用。给一句用户能看懂的中文，
      // 并告诉他数据文件在哪，方便把文件发给开发者排查。
      const detail = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox(
        'HT记账 启动失败',
        [
          '程序打不开你的记账数据文件，因此无法启动。',
          '',
          `数据文件位置：${app.getPath('userData')}`,
          '',
          `错误详情：${detail}`,
          '',
          '常见原因：数据文件正被网盘同步、被其他程序占用，或磁盘已满。'
        ].join('\n')
      )
      app.quit()
      return
    }

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('will-quit', () => {
    if (holder) {
      // 关的是 holder 里**此刻**那个连接 —— 如果用户中途恢复过备份，
      // 这个字段已经被换成新连接了，这里必须跟着换（见上面的说明）。
      disposeDatabaseIn(holder.db)
      holder = null
    }
  })

  app.on('window-all-closed', () => {
    // macOS 上关掉所有窗口不退出应用，这是系统惯例
    if (process.platform !== 'darwin') app.quit()
  })
}
