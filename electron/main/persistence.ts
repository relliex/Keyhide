import { openSync, writeFileSync, readFileSync, fsyncSync, closeSync, renameSync, unlinkSync, copyFileSync, existsSync } from 'fs'
import { dirname, basename, join } from 'path'
import { randomBytes } from 'crypto'

/** Replace a file only after a complete write; a failed write leaves the original intact. */
export function atomicWriteFile(path: string, contents: Buffer | string, backup = false): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, contents)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (backup && existsSync(path)) {
      // Never truncate the previous backup while constructing its replacement either.
      atomicWriteFile(`${path}.bak`, readFileSync(path))
    }
    renameSync(temporary, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Preserve damaged data before recovery, instead of silently replacing it with defaults. */
export function quarantineFile(path: string): string | null {
  if (!existsSync(path)) return null
  const destination = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
  copyFileSync(path, destination)
  unlinkSync(path)
  return destination
}
