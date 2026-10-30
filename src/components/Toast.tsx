import { useAppStore } from '../stores/app'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'

const icons = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
const colors = { success: 'text-success', error: 'text-danger', warning: 'text-warning', info: 'text-accent' }

export function ToastContainer() {
  const toasts = useAppStore((state) => state.toasts)
  const removeToast = useAppStore((state) => state.removeToast)
  return <div className="pointer-events-none fixed bottom-5 right-5 z-[100] max-w-[calc(100vw-32px)] space-y-2" aria-label="操作反馈">
    {toasts.map((toast) => {
      const Icon = icons[toast.type]
      return <div key={toast.id} className="toast pointer-events-auto" role={toast.type === 'error' ? 'alert' : 'status'}><Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${colors[toast.type]}`} /><p className="flex-1 break-words text-sm leading-relaxed">{toast.message}</p><button onClick={() => removeToast(toast.id)} aria-label="关闭通知" className="rounded p-1 text-text-muted hover:text-text-primary"><X className="h-4 w-4" /></button></div>
    })}
  </div>
}
