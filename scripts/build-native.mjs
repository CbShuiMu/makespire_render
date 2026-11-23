import { spawn } from 'node:child_process'
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeConfig } from '../server/nativeConfig.js'

const config = await nativeConfig({ checkBuild: false })
const source = new URL('../src/assets/energy_tiny_icon/', import.meta.url)
const destination = join(config.project, 'editor_assets')
await mkdir(destination, { recursive: true })
for (const file of await readdir(source)) {
  if (file.endsWith('.png')) await copyFile(new URL(file, source), join(destination, file))
}
const child = spawn(config.dotnet, ['build', join(config.project, 'NativeRenderer.csproj'),
  `-p:Sts2AssemblyDir=${config.assemblyDir}`, '--nologo'], { stdio: 'inherit', windowsHide: true })
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
if (code !== 0) process.exit(code || 1)
await writeFile(join(config.project, 'build.local.json'), JSON.stringify({
  gameVersion: config.gameVersion, assemblyHash: config.assemblyHash,
  packStamp: config.packStamp, builtAt: new Date().toISOString(),
}, null, 2))
console.log(`Native renderer built against STS2 ${config.gameVersion}.`)
