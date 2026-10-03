import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './assets/main.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('页面缺少 #root 节点，无法挂载界面')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
