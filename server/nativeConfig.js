import { readFile, access, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const nativeProject = fileURLToPath(new URL('../native-renderer/', import.meta.url))

export async function nativeConfig({ checkBuild = true, env = process.env } = {}) {
  let local = {}
  try { local = JSON.parse(await readFile(join(nativeProject, 'config.local.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const gameDir = env.STS2_GAME_DIR || local.gameDir
  const godotExecutable = env.GODOT_EXECUTABLE || local.godotExecutable
  if (!gameDir || !godotExecutable) throw new Error('Set STS2_GAME_DIR and GODOT_EXECUTABLE, or copy native-renderer/config.example.json to config.local.json. See README.md.')
  const assemblyDir = env.STS2_ASSEMBLY_DIR || local.assemblyDir || join(gameDir, 'data_sts2_windows_x86_64')
  const config = { gameDir: resolve(gameDir), assemblyDir: resolve(assemblyDir), godotExecutable: resolve(godotExecutable) }
  // Godot's Windows console executable is a wrapper around a second process.
  // Spawn the engine directly so timeouts and shutdown also stop its GPU work.
  if (process.platform === 'win32' && config.godotExecutable.endsWith('_console.exe')) {
    const direct = config.godotExecutable.replace(/_console\.exe$/, '.exe')
    try { await access(direct); config.godotExecutable = direct } catch { /* custom single-binary builds */ }
  }
  await Promise.all([access(config.godotExecutable), access(join(config.gameDir, 'SlayTheSpire2.pck'))])
  const dll = await readFile(join(config.assemblyDir, 'sts2.dll'))
  config.assemblyHash = createHash('sha256').update(dll).digest('hex')
  // release_info is next to sts2.dll in the installed game.
  let release
  for (const path of [join(config.assemblyDir, 'release_info.json'), join(config.gameDir, 'release_info.json')]) {
    try { release = JSON.parse(await readFile(path, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!release?.version) throw new Error('Game release_info.json is missing a version.')
  config.gameVersion = release.version
  const pack = await stat(join(config.gameDir, 'SlayTheSpire2.pck'))
  config.packStamp = `${pack.size}:${pack.mtimeMs}`
  if (checkBuild) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(nativeProject, 'build.local.json'), 'utf8')) }
    catch { throw new Error('Native renderer is not built. Run npm run build:native.') }
    if (manifest.assemblyHash !== config.assemblyHash || manifest.packStamp !== config.packStamp)
      throw new Error('The installed game changed. Run npm run build:native and test:native before serving images.')
    await access(join(nativeProject, '.godot/mono/temp/bin/Debug/NativeRenderer.dll'))
  }
  config.project = nativeProject
  config.driver = env.GODOT_RENDER_DRIVER || (process.platform === 'win32' ? 'd3d12' : 'vulkan')
  config.dotnet = env.DOTNET_EXECUTABLE || 'dotnet'
  config.godotDirectory = dirname(config.godotExecutable)
  return config
}
