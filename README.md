# Komari NodeGet Compatibility Layer

将遵循 Komari 公共主题规范的主题 ZIP 转换为 NodeGet 可导入主题包。项目同时提供 Cloudflare Worker 在线转换器和 Bun CLI，采用 MIT 许可证开源。

在线版只在访问者浏览器中解压、转换和重新打包主题。Cloudflare Worker 负责静态资源托管与公开功能配置，不接收主题文件，也不保存 NodeGet Token。

## 当前能力

- 转换根目录包含 `komari-theme.json` 和 `dist/` 的 Komari 主题 ZIP。
- 生成 `nodeget-theme.json`、`nodeget-theme-files.json`、`config.json` 和 NodeGet 安装 ZIP。
- 注入公共 HTTP、RPC2 与实时状态兼容运行时，无需主题源码。
- 转换 Komari managed 主题设置为 NodeGet `user_preferences_form`。
- 支持多个 NodeGet 站点，并为跨站点节点生成无冲突 ID。
- 拒绝管理员、登录、终端及写操作，不把它们透传到 NodeGet。

完整协议范围见 [docs/protocol-scope.md](docs/protocol-scope.md)。

## Token 配置

转换产物中的 `config.json` 始终保留空数组：

```json
{
  "site_tokens": []
}
```

导入主题后，在 NodeGet 主题管理面板配置 RPC 地址和只读 Token。转换器、Cloudflare Worker、GitHub Actions 与仓库均不需要真实 Token。

NodeGet 当前会把主题配置提供给访问者浏览器，因此公开主题 Token 仍然可见，必须使用最小只读权限。参考 [docs/nodeget-minimal-token.md](docs/nodeget-minimal-token.md)。

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
bun run deploy
```

项目使用 Workers Static Assets，部署目录为 `dist/web`。`/api/config` 只返回公开功能开关，`/api/health` 返回运行状态；不存在 NodeGet 代理接口。

### GitHub Actions

推送到 `main` 或手动运行 `Deploy Cloudflare Worker` workflow 会执行完整检查并部署。需要在 GitHub 仓库的 Actions secrets 或 `production` environment 中配置：

- `CLOUDFLARE_API_TOKEN`：可编辑目标 Worker 的 Cloudflare API Token。
- `CLOUDFLARE_ACCOUNT_ID`：目标 Cloudflare Account ID。

可选功能使用 GitHub Actions repository variables 配置：

- `ACG_BACKGROUND_ENABLED`：设为 `true` 时启用 ACG 背景；未配置或其他值均按 `false` 部署。

Pull Request 和非 `main` 分支由 `CI` workflow 执行类型检查、测试、构建及 Wrangler dry run，不部署。

### ACG 背景开关

开源默认值为关闭，前端不会请求第三方图片。需要开启时，在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions -> Variables` 中增加：

```text
ACG_BACKGROUND_ENABLED=true
```

保存变量后重新运行部署 workflow。GitHub Actions 会在每次部署时把它同步为 Worker 环境变量；桌面使用横图接口，手机使用竖图接口。页面不提供临时关闭按钮。

本地调试时可以复制 `.dev.vars.example` 为 `.dev.vars` 并修改值；`.dev.vars` 已被 Git 忽略。

背景来自 [夜轻随机二次元图片 API](https://blog.yeqing.net/acg-api/)，只远程引用，不进入仓库或转换产物。该服务不保证 SLA，图片来源与版权状态由上游维护；转换器始终保留纯色回退。

## 安全边界

- 浏览器转换上限为 64 MB，核心转换器上限为 100 MB 输入、250 MB 解压内容和 10,000 个文件。
- ZIP 路径遍历、重复路径、缺失主题清单与缺失入口会被拒绝。
- 转换后的运行时只实现公共监控读取能力。
- 真实 Token、`.dev.vars`、`.env`、构建产物和 Wrangler 本地状态不会进入 Git。

发现安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 参与开发

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目根据 [MIT License](LICENSE) 发布。
