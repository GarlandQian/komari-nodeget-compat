# 主题兼容验证

## 当前验证矩阵

以下版本使用真实 GitHub Release ZIP 完成了清单转换、本地 NodeGet ZIP 生成、资源路径扫描和公共 API/RPC 调用覆盖核对：

| 主题 | 验证版本 | 公共首页/节点 | 历史与流量 | Ping/Metric Store | 资源转换 |
| --- | --- | --- | --- | --- | --- |
| `sanrokamlan-prog/komari-theme-Glassmorphism` | `v3.3.7` | 通过 | 通过 | 通过 | 通过 |
| `schmidttt/komari-glassops` | `v1.0.9` | 通过 | 通过 | 通过 | 通过 |
| `shanyang242/Komari-Theme-LuminaPlus` | `v1.2.9` | 通过 | 通过 | 通过 | 通过 |

“通过”指主题实际使用的 Komari 公共读取接口已由适配器实现，转换包契约完整；不代表主题内的后台管理、登录、终端、插件或写操作可用。这些入口即使存在于上游构建包中也会被明确拒绝。

## 自动验证

生产部署会对 `ALLOWED_GITHUB_REPOSITORIES` 中每个可枚举仓库执行预热：

1. 获取 Latest Release 并选择 Komari 主题 ZIP。
2. 转换并写入私有 R2 数据包与索引。
3. 验证 NodeGet 清单、轻量文件列表和预览图。
4. 验证入口已注入兼容运行时并引用固定 `v2` Release 资源。
5. 实际读取一个固定资源，确认 Worker 到 R2 的读取路径可用。
6. ACG 开启时，验证 Glassmorphism/GlassOps 与 LuminaPlus 使用的背景配置别名都已注入。

新增兼容主题只需更新 GitHub Actions 变量中的仓库白名单并重新部署。workflow 失败时先看 `Prewarm and verify remote themes` 步骤；它会指出具体仓库和缺失的转换契约。

## 数据限制

- NodeGet 当前摘要协议没有系统温度、GPU 设备详情、GPU 显存和 GPU 温度，相关图表会隐藏或显示不可用。
- `extension-traffic` 的 GB 配额会转换为字节；启用配额周期后读取扩展维护的周期基线和已用量，未初始化周期基线时回退到 NodeGet 的真实累计流量，不显示错误的 `0B`。
- 主题没有有效的 `homepagePingBindings` 分配时，适配层会按统一规则把每个节点自动绑定到最近一条真实 Ping/TCPing 任务；发现过程使用 NodeGet 的 `last` 查询，不扫描完整任务历史，已有的非空显式绑定始终优先，不生成模拟延迟。
- 远程主题的源 JS、CSS、图片和字体依赖 Worker/R2；完全离线使用应选择本地 ZIP 转换。
