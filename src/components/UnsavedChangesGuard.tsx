import { useCallback } from 'react'
import { useBeforeUnload, useBlocker } from 'react-router-dom'
import { ConfirmDialog } from './ui'

export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (dirty) { event.preventDefault(); event.returnValue = '' }
  }, [dirty]))
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)
  return <ConfirmDialog open={blocker.state === 'blocked'} onClose={() => { if (blocker.state === 'blocked') blocker.reset() }} title="离开前放弃修改？" description="当前页面有尚未保存的设置。离开后这些修改会丢失，已保存的配置不受影响。" confirmLabel="放弃并离开" onConfirm={() => { if (blocker.state === 'blocked') blocker.proceed() }} />
}
