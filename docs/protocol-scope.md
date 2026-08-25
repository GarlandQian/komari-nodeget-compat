# Protocol Scope

## 支持目标

兼容层针对遵循 Komari 文档约定的公共监控主题，重点覆盖：

- `GET /api/public`
- `GET /api/version`
- `GET /api/me`
- `GET /api/nodes`
- `GET /api/recent/:uuid`
- `GET /api/task/ping`
- HTTP/WebSocket `/api/rpc2`
- WebSocket `/api/clients`
- 公共节点、最新状态、历史记录、Metric Store 和 Ping RPC

## 明确不支持

- 登录、OAuth、会话伪造
- `/api/admin/*` 与 `admin:*` RPC
- 远程终端、命令执行、文件管理
- Komari 插件私有路由
- 主题自行约定且未进入 Komari 公共规范的后端接口

这些调用必须返回拒绝或方法不存在，不能直接转发到 NodeGet。

## 配置转换

Komari `managed` 配置中的 `string`、`number`、`select`、`switch` 和 `title` 可直接转换为 NodeGet `user_preferences_form`。`textbox`、`richtext`、`nodes` 与 `pingtasks` 会降级为字符串配置，并由运行时解析逗号分隔值。`raw` 和 `redirect` 配置不自动执行。

## 兼容等级

- Level A：公共首页、节点详情、最新状态。
- Level B：历史负载、Metric Store、Ping/TCPing、主题设置。
- Level C：主题使用的非标准公开扩展，需要独立插件。

转换器只承诺 Level A/B 的协议行为。每个主题仍需经过浏览器兼容测试，尤其是绝对资源路径、Service Worker 和自定义路由。
