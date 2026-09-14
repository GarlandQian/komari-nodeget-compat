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

Metric Store 支持每指标聚合方式、每指标最大点数、标签过滤、空区间边界/断点、全局比例抽样和 30 天保留范围。`traffic.up` / `traffic.down` 表示相邻 Agent 采样之间的增量；`net.total.up` / `net.total.down` 表示累计量，启用 `extension-traffic` 配额时改为当前周期用量。

Ping 延迟聚合只计成功样本，丢包单独统计全部探测；摘要平均延迟按有效样本数加权。降采样后的分位数、极值、最新值与标准差基于聚合桶，仍是近似值。全站 Ping 查询触及 NodeGet 单次 10,000 条上限时按毫秒边界拆分窗口，每轮查询最多增加 128 次细分请求；同一毫秒仍满额、预算耗尽或细分失败时明确报告数据不完整，需缩短时间范围或减少节点，不静默返回被截断的历史。

多个 NodeGet 数据源并行读取。单个数据源暂时失败时保留其他来源的数据；全部来源失败时返回错误，不把权限或网络故障伪装成空数据。重复原始 UUID 会生成稳定公开 ID，数据源离线再恢复时不会改变。

## 明确不支持

- 登录、OAuth、会话伪造
- `/api/admin/*` 与 `admin:*` RPC
- 远程终端、命令执行、文件管理
- Komari 插件私有路由
- 主题自行约定且未进入 Komari 公共规范的后端接口
- NodeGet 动态摘要没有提供的系统温度、GPU 设备详情、GPU 显存和 GPU 温度

这些调用必须返回拒绝或方法不存在，不能直接转发到 NodeGet。

## 配置转换

Komari `managed` 配置只有在全部字段及默认值可由 NodeGet 原生控件无损表达时，才生成 `user_preferences_form`。缺少设置定义，或包含 `textbox`、`richtext`、`nodes`、`pingtasks`、对象/数组默认值、其他无法原生表达的类型时，整个表单为空，交由 NodeGet 原生 JSON 编辑器保存完整设置。多行文本、数字数组和嵌套对象保留原类型；旧安装的逗号分隔数组字符串仍可读取。`raw` 和 `redirect` 配置不自动执行。

适配器只提供实际映射到公共配置的 `site_name` / `site_description` 默认项，不再生成无生效通路的独立页面标题和页脚选项。主题自身声明的 `footer` 作为主题设置透传。可选 Ping 发现失败不再阻止静态公开设置加载；后续公开配置请求会重新尝试。

## 兼容等级

- Level A：公共首页、节点详情、最新状态。
- Level B：历史负载、Metric Store、Ping/TCPing、主题设置。
- Level C：主题使用的非标准公开扩展，需要独立插件。

转换器只承诺 Level A/B 的协议行为。主题请求未出现在 `public:listMetricDefinitions` 中的指标时，应像 Komari 官方主题一样隐藏对应图表；适配层不会用伪造的零值声明系统温度或 GPU 详细指标可用。

转换器会处理 Vite 常见相对/根资源路径、`/themes/<short>/dist/` 路径、PWA JSON/Webmanifest 和固定 Release 资源。每个新主题仍需经过浏览器兼容测试，尤其是 Service Worker、自定义公开接口和运行时拼接的非标准资源路径。生产 workflow 会对所有白名单主题执行基础转换和资源验收。
