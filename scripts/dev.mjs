import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

const require = createRequire(import.meta.url)
const targets = new Map([
  ['api', ['watch', 'apps/api/main.ts']],
  ['worker', ['watch', 'apps/worker/main.ts']],
  ['simulation', ['apps/worker/simulation.ts']],
  ['admin', ['--config', 'apps/admin/vite.config.ts']],
])
const [target, ...args] = process.argv.slice(2)
const windows = process.platform === 'win32'
const serviceColors = { api: 36, worker: 33, simulation: 35, admin: 32 }
const levels = new Map([
  [10, 'TRACE'], [20, 'DEBUG'], [30, 'INFO'], [40, 'WARN'], [50, 'ERROR'], [60, 'FATAL'],
])
const logMetadata = new Set(['event', 'level', 'time', 'pid', 'hostname'])

function formatMessage(name, line, colored) {
  if (!line.startsWith('{')) return line
  try {
    const record = JSON.parse(line)
    if (typeof record.event !== 'string' || !/^[\w.-]+$/.test(record.event)) return line
    const fields = Object.entries(record).filter(([key, value]) =>
      !logMetadata.has(key) && !(key === 'service' && value === name))
    const level = levels.get(record.level)
    const label = level ? `[${level}] ` : ''
    const color = record.level === 40 ? 33 : record.level >= 50 ? 31 : 0
    const message = [record.event, ...fields.map(([key, value]) => {
      const text = typeof value === 'string' && /^[\w./:@-]+$/.test(value) ? value : JSON.stringify(value)
      return `${key}=${text}`
    })].join(' ')
    return (colored && color ? `\x1b[${color}m${label}\x1b[0m` : label) + message
  } catch {
    return line
  }
}

function writeLog(name, line, output) {
  const plain = stripVTControlCharacters(line)
  if (!plain.trim()) return
  const colored = !Object.hasOwn(process.env, 'NO_COLOR') && process.env.FORCE_COLOR !== '0' &&
    (output.isTTY || Object.hasOwn(process.env, 'FORCE_COLOR'))
  const time = new Date().toTimeString().slice(0, 8)
  const label = colored ? `\x1b[${serviceColors[name]}m[${name}]\x1b[0m` : `[${name}]`
  output.write(`${time} ${label} ${formatMessage(name, plain, colored)}\n`)
}

function command(name) {
  const cli = name === 'admin'
    ? join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')
    : require.resolve('tsx/cli')
  return [cli, ...targets.get(name)]
}

function startAll() {
  // Give each service and its watcher their own process group on POSIX.
  const commands = [...targets.keys()].map((name) => [name, command(name)])
  const children = new Set()
  let stopping = false
  let forceStop

  function stop(exitCode) {
    if (stopping) return
    stopping = true
    process.exitCode = exitCode
    for (const child of children) {
      if (!child.pid) continue
      if (windows) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        signalGroup(child.pid, 'SIGTERM')
      }
    }
    if (!windows && children.size) {
      forceStop = setTimeout(() => {
        for (const child of children) if (child.pid) signalGroup(child.pid, 'SIGKILL')
      }, 5000).unref()
    }
  }

  process.on('SIGINT', () => stop(130))
  process.on('SIGTERM', () => stop(143))
  for (const [name, argv] of commands) {
    const child = spawn(process.execPath, argv, { detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      createInterface({ input, crlfDelay: Infinity }).on('line', (line) => writeLog(name, line, output))
    }
    child.once('error', (error) => {
      writeLog(name, error.message, process.stderr)
      stop(1)
    })
    child.once('close', (code, signal) => {
      children.delete(child)
      if (!stopping) {
        writeLog(name, `exited (${signal ?? code})`, process.stderr)
        stop(code || 1)
      }
      if (!children.size) clearTimeout(forceStop)
    })
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

if (!target) {
  startAll()
} else if (targets.has(target)) {
  const result = spawnSync(process.execPath, [...command(target), ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  console.log('Usage: pnpm dev [api|worker|admin|simulation]')
  process.exitCode = target !== '--help' && target !== '-h' ? 1 : 0
}
