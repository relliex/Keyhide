import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Loader2, X, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

const buttonVariants = {
  primary: 'button-primary',
  secondary: 'button-secondary',
  danger: 'button-danger',
  ghost: 'button-ghost'
}
const buttonSizes = { sm: 'button-sm', md: 'button-md', lg: 'button-lg' }

export function Button({ variant = 'primary', size = 'md', className, children, loading, disabled, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={clsx('button', buttonVariants[variant], buttonSizes[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{children}
  </button>
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export function Input({ label, error, hint, id, className, ...props }: InputProps) {
  const generatedId = useId()
  const inputId = id || generatedId
  return <div className="min-w-0 space-y-1.5">
    {label && <label htmlFor={inputId} className="field-label">{label}</label>}
    <input id={inputId} className={clsx('input', error && 'input-error', className)} aria-invalid={!!error || undefined} aria-describedby={error || hint ? `${inputId}-description` : undefined} {...props} />
    {(error || hint) && <p id={`${inputId}-description`} className={clsx('text-xs leading-relaxed', error ? 'text-danger' : 'text-text-muted')}>{error || hint}</p>}
  </div>
}

interface SelectProps {
  label?: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export function Select({ label, value, onChange, options, className, disabled, 'aria-label': ariaLabel }: SelectProps) {
  const id = useId()
  return <div className="min-w-0 space-y-1.5">
    {label && <label htmlFor={id} className="field-label">{label}</label>}
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label={ariaLabel || (!label ? options[0]?.label : undefined)} className={clsx('input cursor-pointer', className)}>
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
  </div>
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label?: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label || '切换设置'} disabled={disabled} className={clsx('toggle', checked && 'active')} onClick={() => onChange(!checked)}><span /></button>
}

export function Card({ children, className, hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return <div className={clsx('card p-5', hover && 'card-interactive', className)}>{children}</div>
}

const badgeVariants = {
  default: 'badge-default',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  accent: 'badge-accent'
}

export function Badge({ children, variant = 'default', className }: { children: ReactNode; variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent'; className?: string }) {
  return <span className={clsx('badge', badgeVariants[variant], className)}>{children}</span>
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  busy?: boolean
}

export function Modal({ open, onClose, title, children, footer, width = '600px', busy = false }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const page = document.getElementById('app-shell')
    const wasInert = page?.inert || false
    if (page) page.inert = true
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || []).filter((element) => element.getClientRects().length > 0)
    const initial = dialog?.querySelector<HTMLElement>('[data-autofocus]') || focusable().find((element) => element.tagName === 'INPUT') || dialog
    initial?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) onCloseRef.current()
      }
      if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); dialog?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      if (page) page.inert = wasInert
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} tabIndex={-1} className="modal-panel" style={{ maxWidth: width }}>
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4"><h2 id={titleId} className="text-base font-semibold">{title}</h2><Button variant="ghost" size="sm" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X className="h-4 w-4" /></Button></header>
      <div className="modal-content">{children}</div>
      {footer && <footer className="flex flex-wrap justify-end gap-3 border-t border-border px-6 py-4">{footer}</footer>}
    </div>
  </div>, document.body)
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel, variant = 'danger', busy = false }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; description: ReactNode; confirmLabel: string; variant?: 'danger' | 'primary'; busy?: boolean }) {
  return <Modal open={open} onClose={onClose} title={title} busy={busy} width="480px" footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button variant={variant} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
    <div className="flex items-start gap-4"><AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-warning" /><div className="text-sm leading-relaxed text-text-secondary">{description}</div></div>
  </Modal>
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state-icon">{icon}</div><h3 className="text-base font-semibold">{title}</h3><p className="mt-2 max-w-md text-sm leading-relaxed text-text-muted">{description}</p>{action && <div className="mt-5">{action}</div>}</div>
}

export function StatCard({ label, value, icon, trend }: { label: string; value: string | number; icon: ReactNode; trend?: string; color?: 'accent' | 'success' | 'warning' | 'danger' }) {
  return <div className="stat-item"><div className="flex items-center gap-2 text-text-muted"><span aria-hidden="true">{icon}</span><span className="text-xs">{label}</span></div><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>{trend && <p className="mt-1 text-xs text-text-muted">{trend}</p>}</div>
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    setBusy(true)
    try {
      await window.extraApi.clipboardWrite(text)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    } catch (error) {
      useAppStore.getState().showToast({ type: 'error', message: `复制失败：${errorMessage(error)}` })
    } finally { setBusy(false) }
  }
  return <Button variant="ghost" size="sm" onClick={copy} disabled={busy || !text} aria-label={copied ? '已复制' : label || '复制'} title={copied ? '已复制' : label || '复制'}>
    {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}{label && (copied ? '已复制' : label)}
  </Button>
}

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <header className="page-header"><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm leading-relaxed text-text-muted">{description}</p></div>{action && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{action}</div>}</header>
}

export function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div className="min-w-0"><p className="text-sm font-medium">{title}</p><p className="mt-1 max-w-xl text-xs leading-relaxed text-text-muted">{description}</p></div><div className="flex-shrink-0">{children}</div></div>
}
