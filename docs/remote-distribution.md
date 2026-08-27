# NodeGet 远程主题分发

## 地址格式

每个允许的 GitHub 仓库对应一个稳定主题站点地址：

```text
https://<WORKER_DOMAIN>/themes/github/<OWNER>/<REPOSITORY>/latest
```

示例：

```text
https://adapter.example/themes/github/sanrokamlan-prog/komari-theme-Glassmorphism/latest
```

NodeGet 会在该基址后请求 `nodeget-theme.json`、`nodeget-theme-files.json` 和清单中的每个文件。不要把 GitHub ZIP 下载地址直接填入 NodeGet。

Worker 返回的是轻量安装清单。NodeGet 只下载入口 HTML、兼容运行时、配置、预览等少量文件；原主题的构建资源由入口引用下面的内部固定版本地址：

```text
https://<WORKER_DOMAIN>/themes/github/<OWNER>/<REPOSITORY>/releases/<ASSET_ID>/v2/...
```

这个固定地址由 Worker 自动生成，不需要手动导入 NodeGet。它避免 NodeGet 串行拉取几百个主题文件，也保证安装不会在 `latest` 指向新 Release 后丢失当前资源。末尾的 `v2` 是当前资源改写协议；协议或转换逻辑升级时会使用新的缓存键，不会继续复用旧 R2 数据包。

## Release 选择

Worker 调用 GitHub `releases/latest` 获取最新正式 Release。公共 GitHub API 返回限流或临时服务错误时，会回退读取该仓库的公开 Latest Release 跳转和附件列表；公开主题不需要 GitHub Token。GitHub 自动生成的 Source code ZIP 不属于 Release assets，不会被选中。

- 只有一个上传的 ZIP 时直接使用。
- 多个 ZIP 时优先包含 `komari`、`theme` 和 `build` 的资源。
- 最高分相同会返回 `release_zip_ambiguous`，避免静默选择错误文件。
- ZIP 必须在根目录包含 `komari-theme.json` 和 `dist/index.html`。

精确版本下载地址不会自动跟随新 Release，因此远程分发使用仓库加 `latest`，而不是把特定版本 ZIP URL 编码进地址。

## R2 缓存

第一次请求主题文件时，Worker 会：

1. 检查仓库是否位于 `ALLOWED_GITHUB_REPOSITORIES`。
2. 解析 GitHub 最新 Release 并下载 ZIP。
3. 转换主题，将文件合并成一个连续 R2 数据包和一个索引。
4. 为 NodeGet 生成少量本地安装文件，并把源主题静态资源改写到固定 Release 地址。
5. 按文件偏移使用 R2 Range 响应 NodeGet 和浏览器请求。

`latest/config.json` 会按当前部署环境动态加入可选 ACG 背景默认值；主题 Logo 指向同一 Worker 的 `/nodeget-logo.png`。因此修改开关后需要重新远程更新配置，而替换 Logo 文件只需重新部署 Worker。更新 ACG 配置时应选择采用新的 `user_preferences`、保留旧的 `site_tokens`，避免公开包中的空 Token 数组覆盖已有服务器授权。

最新 Release 默认每 300 秒重新检查一次，可用 `RELEASE_CHECK_TTL_SECONDS` 调整到 60 至 86400 秒。GitHub 临时不可用时，如果 R2 已有缓存，会继续提供上一次成功版本。

R2 桶名固定为 `komari-nodeget-theme-cache`，由 GitHub Actions 自动创建并通过 `THEME_CACHE` 绑定。桶不需要也不应开启 `r2.dev` 公共访问。

R2 内容是可重建缓存。即使手动清空后 Worker 内存中仍残留旧索引，下一次访问 `latest` 文件也会检测数据包缺失，并从对应 GitHub Release 自动重建一次；不需要上传备份文件。清空过程中已经发出的请求仍可能失败，重试远程导入即可。

每次生产部署完成后，workflow 会遍历白名单并请求清单、预览、入口、运行时、配置和一个 `v2` 固定资源。该步骤既会触发首次转换写入 R2，也会在任何主题转换失败、资源缺失或 ACG 配置未注入时让部署任务失败。手动只执行 `wrangler deploy` 不会预热，R2 会在第一次主题请求时懒加载。

## 配置白名单

在 GitHub Actions Repository Variables 中设置：

```text
ALLOWED_GITHUB_REPOSITORIES=owner/theme-one,owner/theme-two
```

使用逗号分隔，不要加入空格。白名单为空时远程分发关闭。
代码支持显式 `*`，但公开部署不应使用，否则任何人都能触发下载、CPU 和 R2 存储消耗。

新增主题无需改 workflow 或适配器源码：把新的 `owner/repository` 追加到变量并重新运行部署即可。前提是该仓库的 Latest Release 有可唯一选择的 ZIP，且 ZIP 根目录符合 Komari 主题契约。

“在 NodeGet 导入”按钮默认使用官方面板，也可以在同一位置配置自己的面板根地址：

```text
NODEGET_DASHBOARD_URL=https://dash.nodeget.com
```

该值随 GitHub Actions 部署为 Worker 环境变量，并通过 `/api/config` 提供给转换器页面。只接受不含账号密码的 HTTP(S) URL；无效值会回退官方地址。

## 更新行为

NodeGet 远程导入会把轻量清单中的文件复制进本地主题桶。转换后的 `nodeget-theme.json` 会记录稳定 Worker 地址为 `dist_page`，因此上游更新后可以在主题管理中点击“从远程更新”。更新后的入口会指向新 Release ID，未更新的安装仍指向旧 Release ID。

NodeGet 当前不会定时检查或静默覆盖已安装主题。兼容层也不持有 NodeGet 管理 Token，因此不会主动修改主题桶。

远程安装后的源主题 JS、CSS、图片和字体依赖 Worker 与 R2 保持可访问。需要安装后完全离线或不依赖 Worker 时，在转换器中上传 Release ZIP 并使用生成的完整 NodeGet ZIP。

## 运行限制

- 远程 ZIP：32 MiB。
- 解压和转换内容：72 MiB。
- 文件数：5,000。
- R2：每个 Release 一个数据包和索引，历史版本不会自动清理。

首次转换需要执行 ZIP 解压和清单转换，可能超过 Workers Free 每请求 10 ms CPU 限制。缓存命中后的文件读取开销较低；大型主题或稳定公开服务建议使用 Workers Paid。
