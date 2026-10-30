import { BrowserWindow, shell, app, screen } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadData } from './database'

let mainWindow: BrowserWindow | null = null
let quitting = false

export function setQuitting(value: boolean): void { quitting = value }

function windowBounds(): { width: number; height: number; x?: number; y?: number } {
  const fallback = { width: 1280, height: 860 }
  try {
    const saved = JSON.parse(readFileSync(join(app.getPath('userData'), 'window-state.json'), 'utf8'))
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback
    const display = screen.getDisplayMatching({ x: Number(saved.x) || 0, y: Number(saved.y) || 0, width: saved.width, height: saved.height }).workArea
    return { width: Math.min(display.width, Math.max(760, saved.width)), height: Math.min(display.height, Math.max(600, saved.height)), x: Math.max(display.x, Math.min(Number(saved.x) || display.x, display.x + display.width - 300)), y: Math.max(display.y, Math.min(Number(saved.y) || display.y, display.y + display.height - 150)) }
  } catch { return fallback }
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...windowBounds(), minWidth: 760, minHeight: 600, show: false,
    title: 'Keyhide', icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101b2c', symbolColor: '#b8c7dd', height: 40 },
    backgroundColor: '#101b2c',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('close', (event) => {
    try { writeFileSync(join(app.getPath('userData'), 'window-state.json'), JSON.stringify(win.getNormalBounds())) } catch { /* Window placement is optional; configuration is stored separately. */ }
    if (!quitting && loadData().settings.minimizeToTray) { event.preventDefault(); win.hide() }
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL().split('#')[0]
    if (url.split('#')[0] !== current) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

export function getMainWindow(): BrowserWindow | null { return mainWindow }
