# 在 NodeGet 编辑转换后的主题设置

## 编辑入口

打开 NodeGet“主题管理 → 对应主题 → 用户配置”。适配器按配置能力自动选择原生表单或 JSON 编辑器，不按主题名称判断。

简单 managed 设置可用表单。缺少设置定义、包含多行文本、数组、对象或不能无损映射的字段时，使用原生 JSON。NodeGet 的表单只保存已声明字段，因此不能用几项站点字段代替完整主题配置。

JSON 编辑的是整个 `user_preferences` 对象，**不要添加外层 `user_preferences` 或 `site_tokens`**。Token 仍在独立的“Token 授权”页维护。

```json
{
  "site_name": "NodeGet",
  "site_description": "我的节点监控"
}
```

在当前对象中合并需要修改的字段，保留其他已有字段。布尔值为 `true` / `false`，数字不加引号，数组和对象保持结构；字符串换行写作 `\n`。不要把完整配置或嵌套对象再次转成带引号的 JSON 字符串。

## 设置字段来自哪里

有 managed 定义的主题会把全部默认值写入配置，例如 Glassmorphism 和 GlassOps 的卡片列表、公告等多行字段。编辑器会按 JSON 规范保留换行。

没有定义的主题无法自动推断每个设置的名称、范围和含义。参考上游主题文档或设置源码；转换器不会通过执行主题管理代码、伪造登录或增加管理 Token 来猜测设置。

以 LuminaPlus `v1.3.3` 为例，[上游设置源码](https://github.com/shanyang242/Komari-Theme-LuminaPlus/blob/7c8e353d60a219b2d553aea674d3cdb9fc6fe29e/src/utils/themeSettings.ts)定义了背景、布局等字段。以下字段可合并进当前 JSON，地址替换为实际 Worker 域名；ACG 需先通过 GitHub 变量启用并部署：

```json
{
  "enableBackgroundImage": true,
  "backgroundMediaType": "image",
  "backgroundImage": "https://<WORKER_DOMAIN>/api/acg-background",
  "backgroundImageMobile": "https://<WORKER_DOMAIN>/api/acg-background",
  "surfaceOpacity": 85
}
```

这只是文档示例，适配器不会按 LuminaPlus 名称注入专属表单。透明度等取值由原主题解释。后台保存按钮依赖 Komari 管理接口，不能在只读兼容运行时内使用；请在 NodeGet 保存配置后刷新主题。

## 从旧版本更新

`0.4.13` 修改了转换后的设置清单。已有远程主题需要做一次“从远程更新”，将以下两项都选为“保留旧配置”：

- 主题配置（`user_preferences`）
- Token（`site_tokens`）

更新会更换主题文件及 `nodeget-theme.json`，保留现有设置和授权。只刷新主题页面不能改变 NodeGet 已安装的设置表单。R2 缓存按新的转换版本自动重建，不需要手动删除。

若背景字段此前已经被旧表单删除，保留旧配置不会凭空恢复它们。可在新 JSON 编辑器补回背景字段，或在确认不再需要旧自定义设置时选择采用新的主题配置；Token 仍应保留。

`site_name` 控制公开站点名称，主题通常也用它作为页面标题；`site_description` 映射公开描述。不再生成此前没有生效通路的独立“页面标题”和“页脚文本”选项。主题自己定义的同名页脚设置仍可保存、透传。
