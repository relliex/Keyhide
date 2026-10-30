import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron'
import { join } from 'node:path'
import { createWindow, getMainWindow, setQuitting } from './window'
import { registerIpc } from './ipc'
import { loadData, flushData } from './database'
import { startProxy, stopProxy, setEmitCallbacks } from './proxy-server'

let tray: Tray | null = null
let shutdownComplete = false
let shutdownStarted = false
let dataTimer: ReturnType<typeof setTimeout> | undefined

if (process.env.KEYHIDE_USER_DATA_DIR) app.setPath('userData', process.env.KEYHIDE_USER_DATA_DIR)

function showWindow(): void {
  const win = getMainWindow() || createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')).resize({ width: 20, height: 20 })
  tray = new Tray(icon)
  tray.setToolTip('Keyhide — 本地密钥代理')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Keyhide', click: showWindow }, { type: 'separator' }, { label: '退出并停止代理', click: () => app.quit() }]))
  tray.on('click', showWindow)
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    try {
      loadData()
      setEmitCallbacks(
        (log) => {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) win.webContents.send('log-added', log)
        },
        (running) => {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) win.webContents.send('proxy-status-changed', running)
        },
        () => {
          if (!dataTimer) dataTimer = setTimeout(() => {
            dataTimer = undefined
            const current = getMainWindow()
            if (current && !current.isDestroyed()) current.webContents.send('data-changed')
          }, 400)
        }
      )
      registerIpc()
      const win = createWindow()
      createTray()
      if (loadData().settings.autoStartProxy) {
        const result = await startProxy()
        const toast = () => { if (!win.isDestroyed()) win.webContents.send('toast', { type: result.success ? 'success' : 'error', message: result.message }) }
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', toast)
        else toast()
      }
    } catch (error) {
      dialog.showErrorBox('Keyhide 无法启动', error instanceof Error ? error.message : String(error))
      app.quit()
    }
  })
  app.on('before-quit', (event) => {
    setQuitting(true)
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    clearTimeout(dataTimer)
    void stopProxy().finally(() => {
      try { flushData() } catch (error) { console.error('Could not save final statistics:', error) }
      shutdownComplete = true
      tray?.destroy()
      app.quit()
    })
  })
  app.on('window-all-closed', () => { if (!loadData().settings.minimizeToTray) app.quit() })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) showWindow() })
}
Menu.setApplicationMenu(null)
