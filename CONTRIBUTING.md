# Contributing

欢迎提交针对 Komari 公共主题兼容性、NodeGet 数据映射、转换安全和 Cloudflare 部署的 Issue 或 Pull Request。

## 开发检查

```bash
bun install
bun run check
bun run deploy:check
```

新增协议映射时需要附带最小测试，并在 `docs/protocol-scope.md` 记录支持范围。不要提交 NodeGet Token、Cloudflare 凭据、`.dev.vars`、`.env`、真实站点配置或未经许可的背景图片。

兼容层必须继续拒绝 Komari 管理接口、终端、命令执行和写操作。任何扩大权限范围的变更都需要在 Pull Request 中明确说明安全理由。
