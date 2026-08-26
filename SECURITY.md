# Security Policy

## Supported versions

安全修复只针对 `main` 分支和最新发布版本。

## Reporting a vulnerability

请使用 GitHub Security Advisory 的私密报告功能，不要在公开 Issue 中披露可利用细节、Token、站点地址或用户数据。

报告应包含受影响版本、复现步骤、预期影响和建议修复。维护者确认后会协调修复与披露时间。

## Security model

- 本地 ZIP 转换在访问者浏览器的独立 Web Worker 中完成，Cloudflare Worker 不接收该文件。
- 远程分发只下载 `ALLOWED_GITHUB_REPOSITORIES` 白名单中的公开 GitHub Release ZIP，并把转换结果保存到私有 R2；不允许任意 URL 中转。
- R2 使用一个连续数据包和文件索引，不开放公共桶域名。远程安装通过 Worker 的固定 Release 路由读取源主题静态资源；旧 Release 缓存不会自动删除，以免破坏已安装主题，部署者应关注存储用量。
- Cloudflare Worker、R2 和转换器均不接收或保存 NodeGet Token。
- 转换包不会预置 Token；Token 由 NodeGet 主题管理配置。
- 公开主题配置对浏览器可见，因此只能使用文档中的最小只读 Token。
- 管理接口、终端、命令执行和写操作不属于兼容范围。
