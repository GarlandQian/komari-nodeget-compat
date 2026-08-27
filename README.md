# Komari NodeGet Compatibility Layer

将遵循 Komari 公共主题规范的主题 ZIP 转换为 NodeGet 可导入主题包。项目提供浏览器转换器、Bun CLI，以及可供 NodeGet 直接导入的 Cloudflare Worker 远程分发地址，采用 MIT 许可证开源。

本地 ZIP 模式只在访问者浏览器中解压、转换和重新打包，文件不会上传。远程分发模式由 Worker 下载白名单内的公开 GitHub Release ZIP，将转换结果保存为私有 R2 数据包，并为 NodeGet 提供轻量安装清单；两种模式都不接收或保存 NodeGet Token。

## 当前能力

- 转换根目录包含 `komari-theme.json` 和 `dist/` 的 Komari 主题 ZIP。
- 生成 `nodeget-theme.json`、`nodeget-theme-files.json`、`config.json` 和 NodeGet 安装 ZIP。
- 注入公共 HTTP、RPC2 与实时状态兼容运行时，无需主题源码。
- 转换 Komari managed 主题设置为 NodeGet `user_preferences_form`。
- 将主题页面中独立出现的可见 `Komari` 品牌文字转换为 `NodeGet`，保留兼容协议、API 和代码标识中的技术名称。
- 将 GitHub 最新 Release 映射为稳定的 NodeGet 主题站点 URL，并使用 R2 缓存。
- 支持多个 NodeGet 站点，并为跨站点节点生成无冲突 ID。
- 自动识别 NodeGet `extension-traffic` 的节点配置，仅在识别后把扩展保存的 GB 流量额度换算为 Komari 使用的字节。
- 按 Komari 语义映射实时累计流量、逐采样流量增量、Metric Store 分桶聚合及 Ping/TCPing 数据。
- 拒绝管理员、登录、终端及写操作，不把它们透传到 NodeGet。

完整协议范围见 [docs/protocol-scope.md](docs/protocol-scope.md)，当前真实 Release 验证结果见 [docs/theme-compatibility.md](docs/theme-compatibility.md)。

## Token 配置

转换产物中的 `config.json` 始终保留空数组：

```json
{
  "site_tokens": []
}
```

导入主题后，在 NodeGet 的 `主题管理 -> 对应主题 -> Token 授权` 中添加“本机 纯监控”或“本机 监控+ping”预设并点击“确定”。也可以手动填写 NodeGet 面板中的后端地址和只读 Token；运行时同时接受面板保存的 `http(s)://` 站点地址、无路径的 `ws(s)://` 地址和完整的 `ws(s)://.../nodeget/rpc` 地址。转换器、Cloudflare Worker、GitHub Actions 与仓库均不需要真实 Token。

转换产物默认 Token 为空是有意的安全行为。主题能打开但没有服务器信息时，先检查上述 `Token 授权` 页面；未配置 `site_tokens` 时运行时不会连接任何 NodeGet 后端。修改后刷新主题页面即可。

### NodeGet 流量扩展

适配层支持 [`extension-traffic`](https://github.com/34892002/nodeget/tree/main/extension-traffic) 的流量额度配置。扩展把 `metadata_traffic_limit` 保存为 GB，而 Komari 主题把 `traffic_limit` 当作字节；适配层会按每个节点的 `metadata_billing_mode` / `metadata_traffic_period` 配置签名自动识别，并使用 `1 GB = 1024³ B` 转换。

只有在扩展同时保存有效 `metadata_billing_mode` 和 `metadata_traffic_period` 时才会转换。仅安装扩展但未配置节点不会触发；没有完整扩展签名的自定义 `metadata_traffic_limit` 即使带周期字段也仍按字节处理，避免改变其他 NodeGet 元数据方案。扩展的按量计费模式没有对应的 Komari 公共主题额度字段，因此不会伪装成固定额度。

配额模式下，主题的“总流量”使用扩展当前计费周期的总用量，而不是 Agent 启动以来的累计字节。适配层每分钟刷新周期起点、基准和已用量；由于扩展只保存上下行合计，主题中的上下行拆分按 Agent 原始累计流量比例估算，但两者之和严格等于当前周期用量。

NodeGet 当前会把主题配置提供给访问者浏览器，因此公开主题 Token 仍然可见，必须使用最小只读权限。参考 [docs/nodeget-minimal-token.md](docs/nodeget-minimal-token.md)。

## NodeGet 远程导入

启用仓库白名单后，每个主题会获得一个稳定地址：

```text
https://<WORKER_DOMAIN>/themes/github/<OWNER>/<REPOSITORY>/latest
```

把该地址填入 NodeGet 主题管理的“从远程导入”，或使用转换器页面生成的“在 NodeGet 导入”链接。导入按钮默认打开官方 `https://dash.nodeget.com`；可以用 `NODEGET_DASHBOARD_URL` 部署变量改为自己的 NodeGet 面板。首次访问时 Worker 会解析 GitHub 最新 Release、转换唯一或最匹配的 ZIP 资源并写入 R2；后续文件直接从 R2 Range 读取。GitHub 公共 API 遇到限流时，Worker 会回退到同仓库的公开 Release 页面，不要求为公开主题配置 GitHub Token。

部署 workflow 会在 Worker 发布后遍历 `ALLOWED_GITHUB_REPOSITORIES`，预先转换每个主题并验证清单、预览、运行时、ACG 配置及一个固定 Release 资源。因此部署成功后对应数据包已经进入 R2；新增仓库只需修改白名单变量并重新运行 workflow，不需要为每个主题改代码。

为避免 NodeGet 串行下载数百个文件导致导入长时间无响应，远程清单只让 NodeGet 保存入口、兼容运行时、配置和预览等少量文件；原主题的 JS、CSS、图片和字体继续从 Worker 的固定 Release 地址加载。固定地址不会随 `latest` 改变，所以已安装版本不会被后续发布破坏。远程安装后的主题需要 Worker 保持可访问；需要完全独立于 Worker 时使用本地 ZIP 转换模式。

上游发布新版后，在 NodeGet 主题管理中点击“从远程更新”即可获取最新版；这不是后台静默自动更新。兼容运行时会从当前 Worker 部署读取，因此即使上游主题 Release 没变，远程更新也能获得适配器修复。完整说明见 [docs/remote-distribution.md](docs/remote-distribution.md)。

## 本地开发

需要 Bun 1.3.14 或更高版本：

```bash
bun install
bun run check
bun run dev
```

`bun run dev` 会构建 CLI、兼容运行时和在线转换器，然后启动本地 Wrangler 服务。

CLI 转换：

```bash
bun run build
bun run convert -- input-komari-theme.zip -o output-nodeget-theme.zip
```

## 部署到 Cloudflare

手动部署：

```bash
bun run check
bunx wrangler r2 bucket create komari-nodeget-theme-cache
bun run deploy
```

项目使用 Workers Static Assets 和私有 R2 绑定。部署目录为 `dist/web`；`/api/config` 只返回公开功能开关、NodeGet 面板地址和仓库白名单，`/api/health` 返回运行状态。远程路由只允许读取配置白名单中的公开 GitHub Release；ACG 接口只访问代码中固定的夜轻 API 域名，不存在任意 URL 或 NodeGet 代理接口。

### GitHub Actions

推送到 `main` 或手动运行 `Deploy Cloudflare Worker` workflow 会执行完整检查、部署并预热验证所有白名单主题。需要在 GitHub 仓库的 Actions secrets 或 `production` environment 中配置：

- `CLOUDFLARE_API_TOKEN`：按下方最小权限创建的 Cloudflare API Token。
- `CLOUDFLARE_ACCOUNT_ID`：目标 Cloudflare Account ID。

#### Cloudflare API Token 最小权限

在 Cloudflare 的 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 页面选择 `Create Token -> Create Custom Token`，配置以下 Account 权限：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| `Account Settings` | `Read` | 让 Wrangler 确认目标账户 |
| `Workers Scripts` | `Edit` | 创建和更新 Worker、Static Assets 与绑定 |
| `Workers R2 Storage` | `Edit` | 检查并创建 `komari-nodeget-theme-cache` R2 桶 |

`Account Resources` 选择 `Include -> Specific account -> 你的目标账户`。当前配置只部署到 `workers.dev`，不需要任何 Zone 权限，也不需要 KV、DNS、Pages、D1 或 API Token 管理权限。

如果以后在 `wrangler.jsonc` 中增加自定义域名 `routes`，再额外添加 `Zone -> Workers Routes -> Edit`，并把 `Zone Resources` 限定到对应域名。不要使用 R2 页面生成的 S3 Access Key；GitHub Actions 需要的是上述通用 Cloudflare API Token。

权限名称可对照 Cloudflare 官方的 [GitHub Actions 部署说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[API Token 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 和 [R2 Create Bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)。

可选功能使用 GitHub Actions repository variables 配置：

- `ACG_BACKGROUND_ENABLED`：设为 `true` 时启用 ACG 背景；未配置或其他值均按 `false` 部署。
- `ALLOWED_GITHUB_REPOSITORIES`：允许远程转换的公开仓库，使用不带空格的逗号分隔 `owner/repo` 列表；未配置时关闭远程分发。
- `NODEGET_DASHBOARD_URL`：“在 NodeGet 导入”按钮打开的面板根地址；未配置、不是 HTTP(S) URL 或包含账号密码时使用官方 `https://dash.nodeget.com`。
- `RELEASE_CHECK_TTL_SECONDS`：检查 GitHub 最新 Release 的间隔，允许 60–86400 秒，默认 300 秒。

部署 workflow 会幂等创建 `komari-nodeget-theme-cache` R2 桶。Pull Request 和非 `main` 分支由 `CI` workflow 执行类型检查、测试、构建及 Wrangler dry run，不部署。

### ACG 背景开关

开源默认值为关闭，前端不会请求第三方图片。需要开启时，在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions -> Variables` 中增加：

```text
ACG_BACKGROUND_ENABLED=true
```

保存变量后重新运行部署 workflow。GitHub Actions 会在每次部署时把它同步为 Worker 环境变量；桌面使用横图接口，手机使用竖图接口。页面不提供临时关闭按钮。

本地调试时可以复制 `.dev.vars.example` 为 `.dev.vars` 并修改值；`.dev.vars` 已被 Git 忽略。

背景来自 [夜轻随机二次元图片 API](https://blog.yeqing.net/acg-api/)。开启后，Worker 通过固定的 `/api/acg-background` 接口代理图片，并同时写入 Glassmorphism/GlassOps 使用的 `backgroundEnabled`、`lightBackgroundUrl`、`darkBackgroundUrl` 以及 LuminaPlus 使用的 `backgroundMediaType`、`backgroundImage`、`backgroundImageMobile`；关闭时不会请求上游。图片本身不进入仓库、R2 或转换产物，该服务不保证 SLA，转换器始终保留纯色回退。

已经安装的主题不会因环境变量变化而被静默改写。开启后请在 NodeGet 中执行“从远程更新”，并在更新选项中选择“主题配置（user_preferences） -> 采用新配置”和“Token（site_tokens） -> 保留旧配置”。这样会载入 ACG 默认值，同时保留现有服务器授权；不要把 Token 选为“采用新配置”，因为公开转换包故意提供空的 `site_tokens`。也可以保留全部旧配置，然后在主题设置中手动启用背景并填写：

```text
https://<WORKER_DOMAIN>/api/acg-background
```

### NodeGet 品牌与网站 Logo

转换器会把页面中独立出现的可见 `Komari` 文案改为 `NodeGet`，但不会改动 `KomariRpc`、`komari-theme.json`、API 路径等兼容层技术标识。

Worker 网站和转换后的主题共用以下仓库文件：

```text
src/web/nodeget-logo.png
```

要替换网站 Logo，可直接在 GitHub 网页中上传同名 PNG 覆盖该文件并提交到 `main`。推荐使用透明背景的正方形 PNG；部署 workflow 完成后，Worker 首页与引用该 Worker 的主题会使用新 Logo，不需要把图片地址放入 Secrets 或 Variables。

## 安全边界

- 浏览器转换上限为 64 MB，核心转换器上限为 100 MB 输入、250 MB 解压内容和 10,000 个文件。
- 远程分发上限为 32 MB ZIP、72 MB 转换内容和 5,000 个文件；首次转换的 CPU 消耗可能超过 Workers Free 的 10 ms 限制，大型主题可能需要 Workers Paid。
- 远程下载只接受白名单内的 GitHub Release ZIP，R2 桶保持私有；ACG 图片代理只接受固定上游域名，不提供任意 URL 代理。
- ZIP 路径遍历、重复路径、缺失主题清单与缺失入口会被拒绝。
- 转换后的运行时只实现公共监控读取能力。
- 真实 Token、`.dev.vars`、`.env`、构建产物和 Wrangler 本地状态不会进入 Git。

发现安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 参与开发

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目根据 [MIT License](LICENSE) 发布。
