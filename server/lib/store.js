import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 统一数据目录：server/data/
 * - 运行时数据（简历库、投递记录）都在这里。
 * - 已整体 gitignore（含个人简历原文与投递记录，敏感）。
 */
export const DATA_DIR = join(__dirname, '..', 'data')

export function dataPath(key) {
  return join(DATA_DIR, `${key}.json`)
}

export async function readJSON(key) {
  const filePath = dataPath(key)
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function writeJSON(key, data) {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true })
  }
  await writeFile(dataPath(key), JSON.stringify(data, null, 2), 'utf-8')
}
