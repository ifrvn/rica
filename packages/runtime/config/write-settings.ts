import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeSettings(directory: string, path: string, record: object) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, randomUUID() + '.tmp')
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(record))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
