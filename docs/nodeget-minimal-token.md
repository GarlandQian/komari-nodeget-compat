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

## NodeGet 0.6.0 原生流量（可选）

适配层支持正式版 0.6.0 的 `agent_query_traffic_current` 和 `agent_query_traffic`。希望使用原生累计流量、以及已配置的 `extension-traffic` 计费周期用量时，在主题 Token 原有 `permissions` 中追加下面这一项，并让对应 Scope 覆盖需要展示的节点：

```json
{ "dynamic_monitoring": { "read": "network" } }
```

面板的“本机 纯监控 / 监控+ping”预设不会自动增加这项权限。没有它时，适配层继续使用监控摘要和扩展元数据，不影响 CPU、内存、网速及 Ping。

- Server 和 Agent 均需支持 0.6.0 的新流量字段，并启用完整动态上报 `agent_report_dynamic`；仅摘要上报或旧 Agent 无法生成原生累计。
- 当前累计来自服务端内存，不要求快照 Worker；它从新统计开始时累加，不能补回启用之前的流量。
- 周期用量需要服务端运行 `traffic-snapshot-worker`，且每块网卡在周期起点及之后已有快照。适配层按 `metadata_traffic_period_start` 查询，保留各方向的独立用量，不减去旧扩展的累计基线。
- 周期结果采用 0.6.0 的 `total` 查询，省略 `end_time`，使用落库后的累计值，通常有约 60 秒写入延迟；该接口不返回落库时间，客户端缓存期限无法检测服务端写入停滞。起点按快照对齐，默认快照间隔 15 分钟，不能视为精确到秒的用量。
- 新接口在后台刷新，首次响应可先显示原有结果。它们共享最多 2 个请求的队列、重复请求合并和 10 秒缓存；失败会退避，旧原生结果最多复用 30 秒。空结果、缺字段、网卡覆盖不完整或有已报告数据丢失的周期结果均回退，不当作 `0B`。
- 原生累计中任一网卡的上报时间落后监控摘要超过 2 分钟时，会保守回退；停用或更名后仍保留旧累计的网卡也可能触发此回退。
- 原生流量只覆盖当前状态的累计/周期数值；实时网速、历史图表及逐次采样增量继续使用摘要。公开主题 Token 无需快照写入、清理或 Worker 管理权限。

接口依据：[0.6.0 流量说明](https://github.com/NodeSeekDev/NodeGet/blob/v0.6.0/docs/guide/features/traffic.md)。0.6.0 上游在单方向计数器重置时可能重复累计另一方向，适配层无法校正服务端已累计的数据；该问题在后续预发布版修复。本次仅接入 0.6.0 的流量查询协议。

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
