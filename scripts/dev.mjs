import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const targets = new Map([
  ['api', ['watch', 'apps/api/main.ts']],
  ['worker', ['watch', 'apps/worker/main.ts']],
  ['simulation', ['apps/worker/simulation.ts']],
  ['admin', ['--config', 'apps/admin/vite.config.ts']],
])
const [target, ...args] = process.argv.slice(2)
const windows = process.platform === 'win32'

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
    const child = spawn(process.execPath, argv, { detached: !windows, stdio: ['ignore', 'inherit', 'inherit'] })
    children.add(child)
    child.once('error', (error) => {
      console.error(`[${name}] ${error.message}`)
      stop(1)
    })
    child.once('close', (code, signal) => {
      children.delete(child)
      if (!stopping) {
        console.error(`[${name}] exited (${signal ?? code})`)
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
