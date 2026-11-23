# Make Spire 图片生成 API

API 接收卡牌或遗物编辑器导出的 JSON，返回带透明背景的 PNG。公开入口无需登录或 API 密钥，支持第三方网页跨域提交。

| 环境 | 基础地址 |
| --- | --- |
| 本地渲染服务 | `http://127.0.0.1:3001` |
| 正式站点 | `https://makespire.app` |

所有生成请求使用 `POST`，并发送 `Content-Type: application/json`。本地启动方式见 [README](../README.md)。

## 生成单张图片

**`POST /api/v1/render-image`**

请求体是一个卡牌或遗物对象，可直接使用相应编辑器导出的 JSON 文件。成功返回 `200 OK` 和 `Content-Type: image/png`，响应体是 PNG 二进制。卡牌尺寸为 648 × 856，遗物尺寸为 1040 × 1296。

从仓库根目录运行以下 PowerShell 命令，可取模板的第一项生成卡牌图片。

```powershell
$baseUrl = 'http://127.0.0.1:3001'
$items = Get-Content .\md\render-images.json -Raw -Encoding UTF8 | ConvertFrom-Json
$cardJson = $items[0] | ConvertTo-Json -Depth 20
$cardPath = Join-Path (Get-Location).Path 'card.json'
[IO.File]::WriteAllText($cardPath, $cardJson, [Text.UTF8Encoding]::new($false))
curl.exe --fail "$baseUrl/api/v1/render-image" -H "Content-Type: application/json" --data-binary "@$cardPath" -o card.png
```

## 批量生成图片

**`POST /api/v1/render-images`**

请求体是包含 1 至 6 个对象的 JSON 数组，可混合卡牌和遗物，也可直接提交 Gallery「JSON 打包」导出的数组。超过 6 项或 8 MiB 时需要拆分请求，Gallery 的「批量生成」会自动分组。

```powershell
$baseUrl = 'http://127.0.0.1:3001'
curl.exe --fail --no-buffer "$baseUrl/api/v1/render-images" -H "Content-Type: application/json" --data-binary "@md/render-images.json" -o render-results.ndjson
```

批次受理后返回 `200 OK` 和 `Content-Type: application/x-ndjson`。服务按输入顺序逐项渲染，每一行是一个结果对象。用从 0 开始的 `index` 对应请求数组中的位置。

| 条目结果 | 响应字段 |
| --- | --- |
| 成功 | `index` 和 `png`。对 `png` 做 Base64 解码即可得到 PNG 文件 |
| 失败 | `index`、数字 `status` 和错误文本 `error`。服务继续处理后续条目 |

调用方应逐行判断结果。Gallery 会将成功图片下载为一个 ZIP，部分失败时在 ZIP 中附上 `errors.json`。直接调用接口时，可用以下命令将每条成功结果保存为单独的 PNG。

```powershell
Get-Content .\render-results.ndjson -Encoding UTF8 | ForEach-Object {
  $result = $_ | ConvertFrom-Json
  if ($result.png) {
    $pngPath = Join-Path (Get-Location).Path ("item-{0}.png" -f $result.index)
    [IO.File]::WriteAllBytes($pngPath, [Convert]::FromBase64String($result.png))
  } else {
    Write-Warning ("第 {0} 项失败（{1}）{2}" -f ($result.index + 1), $result.status, $result.error)
  }
}
```

## 请求字段

字段名和枚举值区分大小写。卡牌必须提供 `object: "card"` 和非空字符串 `title`。遗物必须提供 `object: "relic"` 和非空字符串 `name`。其他字段可按需提供。

| 字段 | 适用对象 | 类型与用途 |
| --- | --- | --- |
| `description` | 两者 | 效果文字。支持颜色标记，如 `[blue]8[/blue]`，以及能量图标标记，如 `*star_energy*` |
| `typeText` | 两者 | 图片上显示的类型或稀有度文字 |
| `rarity` | 两者 | 卡牌可用 `Basic`、`Common`、`Uncommon`、`Rare`、`Ancient`、`Curse`、`Event`、`Quest`、`Status`。遗物可用 `Starter`、`Common`、`Uncommon`、`Rare`、`Shop`、`Ancient`、`Curse`、`Event`、`Quest`、`Status` |
| `language`、`watermark` | 两者 | `language` 为 `zh` 或 `en`，默认 `zh`。`watermark: true` 生成带水印的图片 |
| `type`、`cardPool` | 卡牌 | `type` 可用 `Attack`、`Skill`、`Power`。`cardPool` 可用 `ironclad`、`silent`、`regent`、`necrobinder`、`defect`、`fool`、`colorless`、`ancient`、`status`、`curse`、`quest`、`custom` |
| `cost`、`upgradedCost`、`upgradedDescription`、`upgraded` | 卡牌 | 费用和升级效果均用字符串，如 `"1"` 或 `"X"`。`upgraded: true` 生成升级版，空的升级费用或效果沿用普通值 |
| `starEnergyEnabled`、`starEnergyCost` | 卡牌 | 星能显示开关和费用文字，分别为布尔值和字符串 |
| `flavor` | 遗物 | 遗物故事文字 |
| `style` | 两者 | 可包含插画、卡框、能量图标和 HSV 外观配置 |

`style.thumbnail` 用于插画。卡牌可通过 `cardPool: "custom"` 和 `style.cardPoolCustomAsset` 使用自定义卡框。能量图标使用 `style.energy.type`，可填卡池值或 `none`。选择 `custom` 时，图片放在 `style.energy.customAsset`。图片字段可填 `null`，或填含 `dataUrl` 的对象。可选数字字段 `scale`、`offsetX` 和 `offsetY` 控制缩放与位移。

`dataUrl` 使用 `data:image/png;base64,…` 形式，支持 PNG、JPEG、WebP、GIF、AVIF 和 SVG。SVG 素材必须自包含。自定义色彩可通过 `style.rarityHsv` 和卡牌的 `style.borderHsv` 提供，各用 `h`、`s`、`v` 数值描述。

正文中的 `<术语>` 会以金色显示。API 返回卡牌或遗物的主体图，编辑器会在网页导出时合成 `extraDescriptions` 里的说明面板。

## 状态码和限额

正式站点的 HTTP 错误体为 JSON，形如 `{"error":"A title is required."}`。批量请求成功受理后，请检查响应中每个条目的 `status`。

| 状态码 | 含义 |
| --- | --- |
| `400` | JSON、请求结构、字段或图片无效 |
| `405` / `415` | 生成请求需使用 `POST`，请求类型需为 `application/json` |
| `408` / `504` | 上传超时或渲染超时 |
| `413` | 请求体过大 |
| `422` | 文字超出版式，请缩短文字 |
| `429` | 触发频率限制或达到渲染额度 |
| `503` | 渲染服务繁忙或暂时不可用 |

- 正式站点的单张和批量请求体上限均为 8 MiB。本地单张请求上限为 24 MiB，批量仍为 8 MiB。
- 正式站点的单张和批量请求共享每 IP 限额。每 10 秒最多 6 项，每 60 秒最多 30 项，批次内每项单独计数。全站另有每分钟 60 次、每日 1000 次的渲染额度。
- HTTP 响应带有 `Retry-After` 时，按该响应头的秒数等待再试。批次已返回部分结果时，可只重新提交失败的条目。
- 正式站点会逐张归档成功生成的 PNG，并计入导出统计。

## JSON 模板

模板包含一张卡牌和一件遗物，可整份提交给批量接口，也可取其中任一对象提交给单张接口。素材字段默认为 `null`，下载后即可试跑。[下载 render-images.json](./render-images.json)
