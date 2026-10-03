import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // node:sqlite 是 Electron 内置模块，不能让 Vite 当浏览器模块打包，
        // 否则报 "Module node:sqlite has been externalized for browser compatibility"
        // （CLAUDE.md §5.5）
        external: ['node:sqlite', 'electron']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: { alias: sharedAlias },
    plugins: [react(), tailwindcss()]
  }
})
