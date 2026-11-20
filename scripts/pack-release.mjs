import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const run = (args, cwd) => execFileSync('pnpm', args, {
  cwd, stdio: 'inherit', shell: process.platform === 'win32',
})
const directories = ['.', ...['packages', 'plugins'].flatMap((parent) =>
  readdirSync(parent).map((name) => join(parent, name)).filter((dir) => existsSync(join(dir, 'package.json'))))]
const manifests = directories.map((dir) => readJson(join(dir, 'package.json')))
const versions = new Map(manifests.map(({ name, version }) => [name, version]))
const release = resolve('dist/npm')
const build = join(release, 'build')
mkdirSync('dist', { recursive: true })
if (realpathSync('dist') !== join(realpathSync(root), 'dist') ||
    (existsSync(release) && realpathSync(release) !== release)) {
  throw new Error('The release output must be inside the repository dist directory.')
}
rmSync(release, { recursive: true, force: true })
mkdirSync(join(release, 'tarballs'), { recursive: true })

run(['run', 'db:generate'])
run(['exec', 'vue-tsc', '--noEmit', 'false', '--declaration', '--rootDir', '.', '--outDir', 'dist/npm/build'])
run(['run', 'build'])

function copy(source, destination, filter) {
  mkdirSync(resolve(destination, '..'), { recursive: true })
  cpSync(source, destination, { recursive: true, filter })
}

const isProduction = (file) => !/[\\/](?:test|tests|node_modules)(?:[\\/]|$)|\.test\.[a-z.]+$|\.vue\.js$/.test(file)
const sourceFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter((file) => file && existsSync(file) && (
    /^(?:apps|bin|packages|plugins|prisma|scripts)\//.test(file) ||
    /^(?:LICENSE|README(?:\.en)?\.md|\.env\.example|compose\.yaml|package\.json|pnpm-(?:lock|workspace)\.yaml|prisma\.config\.ts|tsconfig(?:\.server)?\.json)$/.test(file)))

function compiledExport(target) {
  return target.endsWith('.ts')
    ? { types: target.replace(/\.ts$/, '.d.ts'), default: target.replace(/\.ts$/, '.js') }
    : target
}

for (const [index, dir] of directories.entries()) {
  const { scripts, devDependencies, packageManager, private: workspaceOnly, exports, ...manifest } = manifests[index]
  const destination = join(release, 'stage', manifest.name.split('/')[1])
  mkdirSync(destination, { recursive: true })
  copy('LICENSE', join(destination, 'LICENSE'))
  copy(existsSync(join(dir, 'README.md')) ? join(dir, 'README.md') : 'README.md', join(destination, 'README.md'))
  if (dir === '.') {
    for (const folder of ['api', 'worker']) copy(join(build, 'apps', folder), join(destination, 'apps', folder), isProduction)
    for (const file of readdirSync(join(build, 'apps')).filter((name) => name.endsWith('.js'))) {
      copy(join(build, 'apps', file), join(destination, 'apps', file))
    }
    for (const name of ['admin-user', 'plugin-release-manifest', 'migrate']) {
      copy(join(build, 'scripts', name + '.js'), join(destination, 'scripts', name + '.js'))
    }
    copy('bin/rica.js', join(destination, 'bin/rica.js'))
    copy('apps/admin/dist', join(destination, 'admin'))
    copy('prisma', join(destination, 'prisma'))
    copy(join(build, 'prisma.config.js'), join(destination, 'prisma.config.js'))
    copy('.env.example', join(destination, 'env.example'))
    copy('compose.yaml', join(destination, 'compose.yaml'))
  } else {
    copy(join(build, dir), destination, isProduction)
    const entries = typeof exports === 'string' ? { '.': exports } : exports
    manifest.exports = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, compiledExport(value)]))
    if (entries['./rica/prisma']) {
      const configDirectory = dirname(entries['./rica/prisma'])
      const relativeDirectory = join(dir, configDirectory)
      copy(join(relativeDirectory, 'schema.prisma'), join(destination, configDirectory, 'schema.prisma'))
      copy(join(relativeDirectory, 'migrations'), join(destination, configDirectory, 'migrations'))
    }
    if (entries['./rica/bootstrap']) {
      const configDirectory = dirname(entries['./rica/bootstrap'])
      copy(join(dir, configDirectory, 'bootstrap'), join(destination, configDirectory, 'bootstrap'))
    }
    for (const file of sourceFiles.filter((file) => file.startsWith(dir.replaceAll('\\', '/') + '/') && /\.(?:vue|css)$/.test(file))) {
      copy(file, join(destination, file.slice(dir.length + 1)))
    }
  }
  const prefix = dir.replaceAll('\\', '/') + '/'
  for (const file of sourceFiles) {
    if (dir === '.' || file.startsWith(prefix)) copy(file, join(destination, 'source', dir === '.' ? file : file.slice(prefix.length)))
  }
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[key] ?? {})) {
      if (!range.startsWith('workspace:')) continue
      if (range !== 'workspace:*' || !versions.has(name)) throw new Error('Unsupported workspace dependency: ' + name + '@' + range)
      manifest[key][name] = versions.get(name)
    }
  }
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  run(['pack', '--silent', '--pack-destination', '../../tarballs'], destination)
}
