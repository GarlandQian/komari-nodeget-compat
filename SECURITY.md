# Security Policy

## Supported versions

安全修复只针对 `main` 分支和最新发布版本。

## Reporting a vulnerability

请使用 GitHub Security Advisory 的私密报告功能，不要在公开 Issue 中披露可利用细节、Token、站点地址或用户数据。

报告应包含受影响版本、复现步骤、预期影响和建议修复。维护者确认后会协调修复与披露时间。

## Security model

- Cloudflare Worker 不接收主题 ZIP 或 NodeGet Token。
- 在线转换在访问者浏览器的独立 Web Worker 中完成。
- 转换包不会预置 Token；Token 由 NodeGet 主题管理配置。
- 公开主题配置对浏览器可见，因此只能使用文档中的最小只读 Token。
- 管理接口、终端、命令执行和写操作不属于兼容范围。
