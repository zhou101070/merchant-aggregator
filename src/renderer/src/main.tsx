import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './styles/tokens.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'

// 平台标记：darwin 下侧栏为红绿灯留白并承担窗口拖拽(见 app.css)
document.documentElement.dataset.platform = navigator.platform.startsWith('Mac')
  ? 'darwin'
  : navigator.platform.startsWith('Win')
    ? 'win32'
    : 'linux'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
)
