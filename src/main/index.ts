import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

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
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS 上关掉所有窗口不退出应用，这是系统惯例
    if (process.platform !== 'darwin') app.quit()
  })
}
