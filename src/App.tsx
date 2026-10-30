import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createHashRouter, RouterProvider, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Loader2, AlertTriangle, Home } from 'lucide-react'
import { useAppStore } from './stores/app'
import { Sidebar, navItems } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { ToastContainer } from './components/Toast'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Button, EmptyState } from './components/ui'
import { Dashboard } from './pages/Dashboard'

const Platforms = lazy(() => import('./pages/Platforms').then((module) => ({ default: module.Platforms })))
const Models = lazy(() => import('./pages/Models').then((module) => ({ default: module.Models })))
const ProxyPage = lazy(() => import('./pages/Proxy').then((module) => ({ default: module.ProxyPage })))
const Logs = lazy(() => import('./pages/Logs').then((module) => ({ default: module.Logs })))
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })))

function Loading() { return <div className="flex min-h-[320px] items-center justify-center gap-3 text-sm text-text-muted" role="status"><Loader2 className="h-5 w-5 animate-spin" />正在加载本地工作空间…</div> }

function Workspace() {
  const location = useLocation()
  const navigate = useNavigate()
  const mainRef = useRef<HTMLElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const data = useAppStore((state) => state.data)
  const loading = useAppStore((state) => state.loading)
  const error = useAppStore((state) => state.error)
  const loadData = useAppStore((state) => state.loadData)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
    document.title = `Keyhide · ${navItems.find((item) => item.path === location.pathname)?.label || '工作台'}`
  }, [location.pathname])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true) }
      if (event.altKey && /^[1-6]$/.test(event.key)) { event.preventDefault(); navigate(navItems[Number(event.key) - 1].path) }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [navigate])
  return <><div id="app-shell" className="app-shell">
    <a href="#main-content" className="skip-link button button-primary button-md" onClick={(event) => { event.preventDefault(); mainRef.current?.focus() }}>跳转到主内容</a>
    <TitleBar />
    {import.meta.env.VITE_BROWSER_PREVIEW === 'true' && <div className="bg-warning/10 px-5 py-2 text-xs text-warning">界面预览：使用模拟数据，不会启动真实代理或调用上游服务。</div>}
    <div className="flex min-h-0 flex-1"><Sidebar onSearch={() => setSearchOpen(true)} /><main id="main-content" ref={mainRef} tabIndex={-1} className="workspace">
      {error && data && <div role="alert" className="mx-8 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning"><span>刷新本地数据失败：{error}</span><Button variant="ghost" size="sm" onClick={loadData}>重试</Button></div>}
      {loading && !data ? <Loading /> : !data ? <EmptyState icon={<AlertTriangle className="h-6 w-6" />} title="无法读取本地配置" description={error || '请确认桌面应用已正常启动，然后重试。'} action={<Button onClick={loadData}>重新读取</Button>} /> : <Suspense fallback={<Loading />}><Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/platforms" element={<Platforms />} />
        <Route path="/models" element={<Models />} />
        <Route path="/proxy" element={<ProxyPage />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<EmptyState icon={<Home className="h-6 w-6" />} title="这个页面不存在" description="本地地址可能已经失效。你的平台配置仍然保留，可从工作台继续。" action={<Button onClick={() => navigate('/dashboard', { replace: true })}>回到工作台</Button>} />} />
      </Routes></Suspense>}
    </main></div>
  </div><CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} /><ToastContainer /></>
}

const router = createHashRouter([{ path: '*', element: <Workspace /> }])

export default function App() {
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void useAppStore.getState().loadData(), 250) }
    const cleanup = [
      window.api.onLogAdded((log) => useAppStore.getState().addLog(log)),
      window.api.onProxyStatusChanged((running) => { useAppStore.getState().setProxyRunning(running); scheduleRefresh() }),
      window.api.onToast((toast) => useAppStore.getState().showToast(toast)),
      window.api.onDataChanged(scheduleRefresh)
    ]
    void useAppStore.getState().loadData()
    return () => { cleanup.forEach((unsubscribe) => unsubscribe()); clearTimeout(refreshTimer) }
  }, [])
  return <ErrorBoundary><RouterProvider router={router} /></ErrorBoundary>
}
