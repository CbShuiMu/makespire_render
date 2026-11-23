# Make Spire 卡牌与遗物渲染器

`makespire_render` 是 [Make Spire](https://makespire.app) 的图片渲染服务。它读取《杀戮尖塔 2》卡牌或遗物编辑器导出的 JSON，通过本机游戏场景绘制，并返回透明背景 PNG。适合本地生成图片，也可通过 HTTP 接入其他工具。

| 对象 | PNG 尺寸 | 支持的内容 |
| --- | --- | --- |
| 卡牌 | 648 × 856 | 卡池、卡种、稀有度、费用、星能、普通及升级效果、自定义卡图和卡框 |
| 遗物 | 1040 × 1296 | 稀有度、效果、故事文字、自定义插画 |

两种对象均支持中英文、富文本颜色、能量图标和可选水印。渲染器使用游戏自带的场景、字体和布局，Node.js 负责接收 HTTP 请求、分配渲染任务和编码 PNG。

## 在 Windows 上运行

需要 Node.js 22.23.0 或更高版本、.NET 9 SDK、已安装的《杀戮尖塔 2》、与游戏版本兼容的 MegaDot Mono 和支持 D3D12 的图形环境。已有验证记录的组合为 STS2 v0.113.1 与 MegaDot 4.5.1-m.14 Mono。渲染需要真实图形驱动，请勿用 `--headless` 启动。游戏 PCK、DLL 和引擎由本机提供。

```powershell
git clone https://github.com/CbShuiMu/makespire_render.git
Set-Location makespire_render
npm ci
Copy-Item native-renderer/config.example.json native-renderer/config.local.json
```

编辑 `native-renderer/config.local.json`，将 `gameDir` 指向包含 `SlayTheSpire2.pck` 的游戏目录，将 `godotExecutable` 指向 MegaDot Mono 可执行文件。Windows 默认在游戏目录的 `data_sts2_windows_x86_64` 子目录查找 `sts2.dll`。也可以通过 `STS2_GAME_DIR`、`GODOT_EXECUTABLE` 和 `STS2_ASSEMBLY_DIR` 设置路径。

```powershell
npm run build:native
$env:EXPORT_ARCHIVE_DIR = Join-Path $PWD.Path 'render-archive.local'
npm run start:renderer
```

渲染进程预热后，服务在 `http://127.0.0.1:3001` 监听。在另一个终端运行 `curl.exe --fail http://127.0.0.1:3001/healthz` 查看状态。游戏更新后请重新构建并运行原生测试。

## 生成图片

将编辑器导出的 JSON 保存为 `card.json` 或 `relic.json`。两种文件都使用单张接口。

```powershell
curl.exe --fail http://127.0.0.1:3001/api/v1/render-image -H "Content-Type: application/json" --data-binary "@card.json" -o card.png
```

也可以直接提交仓库附带的卡牌与遗物示例。批量接口按输入顺序返回 NDJSON，每行成功结果的 `png` 字段为 Base64 编码的 PNG。

```powershell
curl.exe --fail http://127.0.0.1:3001/api/v1/render-images -H "Content-Type: application/json" --data-binary "@md/render-images.json" -o render-results.ndjson
```

单张本地请求上限为 24 MiB。批量请求每次最多 6 项，总上限为 8 MiB。字段、示例、错误码和 NDJSON 解码命令见 [图片生成 API](md/image-api.md)。

成功导出的图片会写入归档目录中的 `cards/` 或 `relics/`，并记录到 `exports.sqlite` 和按北京时间汇总的 `daily-exports.csv`。通过 `EXPORT_ARCHIVE_DIR` 指定位置，默认使用 `D:/makespire`。

## 开发与验证

| 路径 | 用途 |
| --- | --- |
| `native-renderer/` | C# / Godot 渲染宿主、卡牌和遗物场景适配 |
| `server/` | Node.js HTTP 接口、任务池、图片处理和归档 |
| `scripts/build-native.mjs` | 构建原生宿主并记录游戏版本 |
| `md/render-images.json` | 可直接提交给批量接口的示例 |

`npm run test:renderer` 运行图片处理与归档测试。完成原生构建后，`npm run test:native` 使用本机游戏与图形环境运行渲染和 HTTP 接口测试。

Make Spire 是同人项目。《杀戮尖塔 2》与游戏素材的权利归各自权利人所有。
