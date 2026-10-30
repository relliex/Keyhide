import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './ui'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="flex h-full items-center justify-center bg-bg-primary p-8"><div className="max-w-md text-center"><AlertTriangle className="mx-auto mb-5 h-8 w-8 text-warning" /><h1 className="text-xl font-semibold">界面暂时无法显示</h1><p className="mt-3 text-sm leading-relaxed text-text-muted">本地配置未被清除。重新加载界面后可继续操作；后台代理服务不受此界面错误影响。</p><Button className="mt-6" onClick={() => window.location.reload()}>重新加载界面</Button></div></div>
    return this.props.children
  }
}
