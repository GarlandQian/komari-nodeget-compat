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

## Release 选择

Worker 调用 GitHub `releases/latest` 获取最新正式 Release。GitHub 自动生成的 Source code ZIP 不属于 Release assets，不会被选中。

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
4. 按文件偏移使用 R2 Range 响应 NodeGet 请求。

最新 Release 默认每 300 秒重新检查一次，可用 `RELEASE_CHECK_TTL_SECONDS` 调整到 60 至 86400 秒。GitHub 临时不可用时，如果 R2 已有缓存，会继续提供上一次成功版本。

R2 桶名固定为 `komari-nodeget-theme-cache`，由 GitHub Actions 自动创建并通过 `THEME_CACHE` 绑定。桶不需要也不应开启 `r2.dev` 公共访问。

## 配置白名单

在 GitHub Actions Repository Variables 中设置：

```text
ALLOWED_GITHUB_REPOSITORIES=owner/theme-one,owner/theme-two
```

使用逗号分隔，不要加入空格。白名单为空时远程分发关闭。代码支持显式 `*`，但公开部署不应使用，否则任何人都能触发下载、CPU 和 R2 存储消耗。

## 更新行为

NodeGet 远程导入会把文件复制进本地主题桶。转换后的 `nodeget-theme.json` 会记录稳定 Worker 地址为 `dist_page`，因此上游更新后可以在主题管理中点击“从远程更新”。

NodeGet 当前不会定时检查或静默覆盖已安装主题。兼容层也不持有 NodeGet 管理 Token，因此不会主动修改主题桶。

## 运行限制

- 远程 ZIP：32 MiB。
- 解压和转换内容：72 MiB。
- 文件数：5,000。
- R2：每个 Release 一个数据包和索引，历史版本不会自动清理。

首次转换需要执行 ZIP 解压和清单转换，可能超过 Workers Free 每请求 10 ms CPU 限制。缓存命中后的文件读取开销较低；大型主题或稳定公开服务建议使用 Workers Paid。
