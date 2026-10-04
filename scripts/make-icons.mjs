/**
 * 把设计好的图形渲染成图片文件（开发用的一次性脚本，不是软件的一部分）。
 *
 * 为什么走 Electron 而不是图像库：项目里**没有装任何图像库**（sharp / canvas 都没有，
 * 它们都要编译原生模块，正是这个项目一路在躲的东西）。而 Electron 自带 Chromium ——
 * 它本来就是个渲染器：载入一段内联 SVG，`capturePage()` 拿回位图。
 *
 * 产出两处：
 *   1. `图标方案/*.png` —— 给用户挑选用的候选图（一次性产物，已 gitignore）。
 *   2. `build/icon.png` + `build/icon.ico` —— 用户选定的那个，供 electron-builder 打包用。
 *
 * 用法（`ELECTRON_RUN_AS_NODE` 必须去掉，否则 Electron 退化成普通 Node、不建窗口）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/make-icons.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, '图标方案')
const BUILD_DIR = join(ROOT, 'build')

/**
 * 强制 1 倍缩放。
 *
 * 不加这一句，在显示缩放 125% / 150% 的 Windows 上 `capturePage()` 拿到的位图
 * 会比窗口**大**（要 256 给 384）—— 写进 .ico 就是错的尺寸，
 * 而 Windows 只会把图标显示得糊一点，不会报任何错。
 * 必须在 app ready 之前设置。
 */
app.commandLine.appendSwitch('force-device-scale-factor', '1')

/**
 * ⚠️ 这一行不能删。
 *
 * Electron 的默认行为是「最后一个窗口关掉 → 整个程序退出」。本脚本是
 * 「渲一个 → 关掉窗口 → 再渲下一个」，于是关掉第一个窗口之后程序就开始退出，
 * 后面新建的窗口**刚载入就被中止**，报的却是 `ERR_FAILED (-2)` ——
 * 一个完全指不到原因的错误（现象是「第一个图标成功，后面全部失败」）。
 *
 * 2026-10-04 在这上面绕了两圈：先怀疑 `data:` 网址太长，改成写临时文件，
 * 照样失败才想明白跟网址无关 —— **是程序在退出**。
 */
app.on('window-all-closed', () => {
  // 故意什么都不做：渲染期间允许「一个窗口都没有」
})

/**
 * 候选方案。
 *
 * 共同约束：**图形必须是「画」出来的，不能用文字**。
 * 图标里的字要靠系统字体渲染，而每台电脑装的字体不一样 ——
 * 同一个 ¥ 在您的机器上和在别人机器上可能长得不同，甚至渲染成方框。
 * 所以 ¥ 是拿五条线拼的，不是打出来的字符。
 */
const ICONS = [
  {
    file: '1-蓝色-人民币符号.png',
    svg: `<svg width="SIZE" height="SIZE" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#2563eb"/>
  <g stroke="#ffffff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M188 152 L256 242 M324 152 L256 242 M256 242 L256 384"/>
    <path d="M194 294 H318 M194 344 H318"/>
  </g>
</svg>`
  },
  {
    file: '2-绿色-账本.png',
    svg: `<svg width="SIZE" height="SIZE" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#059669"/>
  <g stroke="#ffffff" stroke-width="34" fill="none" stroke-linejoin="round">
    <rect x="150" y="112" width="212" height="288" rx="26"/>
  </g>
  <path d="M212 134 L212 378" stroke="#ffffff" stroke-width="34" stroke-linecap="round"/>
</svg>`
  },
  {
    file: '3-橙色-柱状图.png',
    svg: `<svg width="SIZE" height="SIZE" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#ea580c"/>
  <g fill="#ffffff">
    <rect x="128" y="300" width="62" height="100" rx="16"/>
    <rect x="225" y="222" width="62" height="178" rx="16"/>
    <rect x="322" y="138" width="62" height="262" rx="16"/>
  </g>
</svg>`
  }
]

/** **用户 2026-10-04 选定方案 1**（蓝色 ¥）。换图标只要改这个下标，然后重跑本脚本。 */
const CHOSEN = 0

/** 窗口尺寸 = 图形尺寸，四边不留白，否则 PNG 边上会多出一圈透明。 */
function html(svg, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px;
                 background: transparent; overflow: hidden; }
    svg { display: block; }
  </style></head><body>${svg.replaceAll('SIZE', String(size))}</body></html>`
}

/** 渲染一张，返回 PNG 的字节。 */
async function renderPng(svg, size, scratch, tag) {
  const page = join(scratch, `${tag}.html`)
  writeFileSync(page, html(svg, size), 'utf8')

  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    // 圆角外侧必须是**透明**的，不能是白色方块底
    transparent: true,
    backgroundColor: '#00000000'
  })

  try {
    await win.loadFile(page)
    // 等一帧再截：刚载入完还可能是空白
    await new Promise((resolve) => setTimeout(resolve, 300))

    const image = await win.webContents.capturePage()

    // 尺寸必须**断言**，不能假设。截图尺寸受显示缩放影响，
    // 而尺寸错了不会有任何报错 —— 只会得到一个糊的图标。
    const { width, height } = image.getSize()
    if (width !== size || height !== size) {
      throw new Error(`渲染 ${tag} 得到的图是 ${width}×${height}，而要求是 ${size}×${size}`)
    }

    return image.toPNG()
  } finally {
    win.destroy()
  }
}

/**
 * 把一张 PNG 包成单张图的 .ico。
 *
 * ICO 格式很简单：6 字节文件头 + 16 字节目录项 + 图像数据。
 * 图像数据可以直接放 PNG（Vista 以后的标准做法），不必用老的 BMP 格式。
 *
 * 自己拼而不是让 electron-builder 转换：转换那一步依赖它下载的外部工具链，
 * 而首选的方案是自己产出确定的字节 —— 少一个可能失败的环节。
 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // 保留位
  header.writeUInt16LE(1, 2) // 1 = 图标
  header.writeUInt16LE(1, 4) // 只有一张图

  const entry = Buffer.alloc(16)
  // 宽高各占 1 字节，256 要写成 0（这一格存不下 256）
  entry.writeUInt8(size >= 256 ? 0 : size, 0)
  entry.writeUInt8(size >= 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // 调色板数（PNG 不用）
  entry.writeUInt8(0, 3) // 保留位
  entry.writeUInt16LE(1, 4) // 色彩平面数
  entry.writeUInt16LE(32, 6) // 每像素位数
  entry.writeUInt32LE(png.length, 8) // 图像数据长度
  entry.writeUInt32LE(22, 12) // 图像数据偏移（6 + 16）

  return Buffer.concat([header, entry, png])
}

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(BUILD_DIR, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'ht-icons-'))

  try {
    // ---- 1. 候选图（给用户挑选用，512 足够看清）----
    for (const [index, icon] of ICONS.entries()) {
      const png = await renderPng(icon.svg, 512, scratch, `candidate-${index}`)
      writeFileSync(join(OUT_DIR, icon.file), png)
      console.log('候选图：' + icon.file)
    }

    // ---- 2. 选定的那个，做成正式图标 ----
    const chosen = ICONS[CHOSEN]
    if (chosen === undefined) throw new Error(`CHOSEN = ${CHOSEN} 对不上任何一个方案`)

    // 1024 给 electron-builder 当源图（macOS 的 .icns 也从它生成）
    writeFileSync(join(BUILD_DIR, 'icon.png'), await renderPng(chosen.svg, 1024, scratch, 'final-1024'))
    // 256 的 .ico 给 Windows（Windows 要求的最大尺寸就是 256）
    const png256 = await renderPng(chosen.svg, 256, scratch, 'final-256')
    writeFileSync(join(BUILD_DIR, 'icon.ico'), pngToIco(png256, 256))

    console.log('\n选定方案：' + chosen.file)
    console.log('已写入：build/icon.png（1024×1024）+ build/icon.ico（256×256）')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  app.quit()
})

// 出错要**响**，不能静静地少生成一个文件 —— 否则「生成成功」这句话
// 和实际不符，用户打开文件夹会以为少掉的那些本来就不存在。
process.on('unhandledRejection', (error) => {
  console.error('生成图标时出错：', error)
  process.exitCode = 1
  app.quit()
})
