import { useAppStore } from '../stores/app'
import { APP_VERSION } from '../../electron/shared/version'
import { clientBaseUrl } from '../lib/utils'

export function TitleBar() {
  const running = useAppStore((state) => state.proxyRunning)
  const data = useAppStore((state) => state.data)
  return <div className="titlebar titlebar-drag"><span className="font-medium text-text-secondary">Keyhide</span><span className="h-3 w-px bg-border" /><span>本地工作空间</span><span className="ml-auto titlebar-status flex items-center gap-2"><span className={`status-dot ${running ? 'active' : ''}`} />{running && data ? clientBaseUrl(data.proxy) : `v${APP_VERSION}`}</span></div>
}
