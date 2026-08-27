# NodeGet 最小只读 Token

兼容层运行在访问者浏览器中，`config.json` 和其中的 Token 对访问者可见。必须为状态页单独创建只读 Token，不能使用 SuperToken 或管理 Token。

NodeGet 当前版本可使用下面的 `token_limit`。它允许列出节点并读取兼容层实际使用的监控、Ping/TCPing 和公开元数据，不包含任何写权限：

```json
[
  {
    "scopes": ["global"],
    "permissions": [
      { "monitoring_uuid": "list" },
      { "static_monitoring": { "read": "cpu" } },
      { "static_monitoring": { "read": "system" } },
      { "dynamic_monitoring_summary": "read" },
      { "task": { "read": "ping" } },
      { "task": { "read": "tcp_ping" } },
      { "kv": { "read": "metadata_*" } }
    ]
  }
]
```

对应 RPC 方法：

- `agent-uuid_list_all`
- `agent_static_data_multi_last_query`
- `agent_dynamic_summary_multi_last_query`
- `agent_query_dynamic_summary`
- `task_query`，仅查询 `ping` 与 `tcp_ping`
- `kv_get_multi_value`，仅读取 `metadata_*`

适配层不会请求 NodeGet 当前动态摘要协议中不存在的系统温度或 GPU 设备详情字段。主题若包含这些图表，运行时会通过 Metric 定义列表将其标记为不可用，而不是要求扩大 Token 权限。

旧版 NodeGet 如果不支持 `agent-uuid_list_all`，将自动回落到 `nodeget-server_list_all_agent_uuid`。旧版 Token 可能还需要将 `{ "monitoring_uuid": "list" }` 替换为 `{ "node_get": "list_all_agent_uuid" }`；优先使用新版权限。

不要授予 `Task::Create/Write/Delete`、KV 写入/删除、Terminal、Crontab 写入、配置读写、执行命令、WebShell、HTTP Request、自更新、JS Worker 或数据库权限。

## 在 NodeGet 中配置

转换包的 `config.json` 会故意保留空的 `site_tokens`，不要在转换器、GitHub 或 Cloudflare 中配置真实 Token。导入后打开：

```text
主题管理 -> 对应主题 -> Token 授权
```

优先点击 NodeGet 已生成的“本机 纯监控”或“本机 监控+ping”预设，再点击“确定”。本地上传不会自动选择预设；没有授权配置时主题可以显示界面，但不会读取服务器和节点信息。

手动配置时可直接填写 NodeGet 面板使用的后端地址。兼容运行时接受以下形式，并会在需要时转换协议、补全 `/nodeget/rpc`：

- `https://nodeget.example`
- `wss://nodeget.example`
- `wss://nodeget.example/nodeget/rpc`

站点配置示例：

```json
{
  "site_tokens": [
    {
      "name": "公开状态页",
      "backend_url": "https://nodeget.example",
      "token": "TOKEN_KEY:TOKEN_SECRET"
    }
  ]
}
```

多站点时为每个 NodeGet 后端分别创建最小只读 Token，并各自增加一项。真实 Token 不应提交到仓库。保存后刷新主题页面；仍无数据时，先在浏览器开发者工具中检查 WebSocket 是否连接到 `wss://<域名>/nodeget/rpc`，再核对 Token 权限。

公开主题的每个访客都需要连接 NodeGet RPC。适配器会在一批只读查询完成后自动释放空闲连接，但 NodeGet 的 `jsonrpc_max_connections` 仍须覆盖 Agent、管理面板和并发访客的短时连接数。WebSocket 握手返回 `429 Too Many Requests` 或 `Too many connections` 时，应先关闭旧页面或重启 NodeGet 释放连接，再按实际并发量提高该配置。
