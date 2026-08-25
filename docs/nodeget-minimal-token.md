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

旧版 NodeGet 如果不支持 `agent-uuid_list_all`，将自动回落到 `nodeget-server_list_all_agent_uuid`。旧版 Token 可能还需要将 `{ "monitoring_uuid": "list" }` 替换为 `{ "node_get": "list_all_agent_uuid" }`；优先使用新版权限。

不要授予 `Task::Create/Write/Delete`、KV 写入/删除、Terminal、Crontab 写入、配置读写、执行命令、WebShell、HTTP Request、自更新、JS Worker 或数据库权限。

站点配置示例：

```json
{
  "site_tokens": [
    {
      "name": "公开状态页",
      "backend_url": "wss://nodeget.example/nodeget/rpc",
      "token": "TOKEN_KEY:TOKEN_SECRET"
    }
  ]
}
```

多站点时为每个 NodeGet 后端分别创建最小只读 Token，并各自增加一项。真实 Token 不应提交到仓库。
