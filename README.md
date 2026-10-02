# Pi Skill 管理器 · v1.0.0

一个中文、轻量、只监听本机的个人 Pi Skill 管理工具。Node.js HTTP 服务 + 原生 HTML/CSS/JavaScript；没有账号、商店、云同步、数据库或模型调用，不执行 Skill 和附件。

## 功能

- 暖白三栏工作台：搜索／正文搜索、筛选、收藏、分组标签、备注、常用视图与时间排序；窄屏列表／详情切换。
- 按 Pi 原生规则发现 Skill、精准开启／关闭、解释加载状态；不自动安装包，也不控制运行中的 Pi 会话。
- 编辑原文、安全文本预览、草稿／历史对比、版本保护、备份恢复；保留原换行和未知 YAML 元数据。
- 新建、完整复制、单 Skill ZIP 导入／导出、多选打包；不覆盖同名或已有文件。
- 只读附件浏览、批量分组／标签、整组改名；分组名和精确视图引用同步，成员和 Skill 内容不变。
- 可恢复删除、回收站恢复、单条／全量永久清理，使用独立预览和输入确认。

## 安装与启动

已验证基线：**Windows、Node.js 24.14.0、Pi 1.0.0**。Node 最低 22.19；其他 Pi 版本和 macOS/Linux 未作本次完整验收，不承诺内部接口长期稳定。

1. 安装 Node.js，并确保本机已有 Pi（`@earendil-works/pi-coding-agent`）。工具不需要模型登录或 API key。
2. 下载本仓库或 Release 源码包并解压。在项目目录运行：

```sh
npm ci --ignore-scripts
npm run check
npm start
```

3. 打开 **http://127.0.0.1:3470**。Windows 也可双击 `启动Skill管理.cmd` 自动打开浏览器。

保持启动窗口打开；关闭窗口或 Ctrl+C 停止。不会自动下载安装依赖、修改 Pi 插件或联网更新。

找不到 Pi 时设置 `PI_PACKAGE_DIR`，指向含 `package.json` 和 `dist/` 的 Pi 包目录；可用 `npm root -g` 查看全局模块位置。例如 PowerShell：

```powershell
$env:PI_PACKAGE_DIR = Join-Path (npm root -g) '@earendil-works/pi-coding-agent'
npm run check
npm start
```

`npm run check` 只检查 Node、Pi 内部入口和 ZIP 依赖，不发现 Skill、不写配置、不启动服务。入口存在不等于所有行为兼容；更新 Pi 后应先跑测试。

自定义端口或显式项目视图：

```sh
node server.mjs --port 3471 --open
node server.mjs --project "path/to/your/project" --open
node server.mjs --agent-dir "path/to/your/agent-directory"
```

默认是个人全局视图，支持 `PI_CODING_AGENT_DIR`。项目管理不替代 Pi 自己的项目信任决定。

## 日常使用

点击 Skill 查看概览，切到「原文」编辑。主窗口 Ctrl+S 只在原文标签保存；弹窗有独立草稿与确认。分组标题旁 **✎** 可改已有分组名，包括仅有暂未发现成员的已存组，不合并或覆盖目标组。

修改 Skill 文件或原生加载开关后，在使用它的 Pi 中 `/reload`；备注、收藏、分组和常用视图不需要。未保存草稿应先处理再刷新网页。

详细说明：[使用指南](docs/USER_GUIDE.md) · [备份与恢复](docs/BACKUP_RESTORE.md) · [测试与兼容性](docs/TESTING.md)

## 安全与范围

- 只监听 `127.0.0.1`；写接口有 Host／Origin／同源标识检查。**不要反向代理或对公网开放服务**；GitHub 公开的是源码，不是个人服务。
- Skill、备注、附件、路径和差异按文本显示，不渲染陌生 HTML，也不执行 scripts、安装包或加载扩展。
- 写前校验版本、加锁、备份；对创建／复制／导入／恢复拒绝覆盖。完成后刷新失败会保留成功回执，不自动重试。
- 永久清理不可撤销、不进入系统回收站、不是安全擦盘。异常／链接／未知内容保留，不递归强制扫除。
- 不是防御同账户恶意程序竞态的操作系统权限沙箱。ZIP 与整理 JSON、备份和截图可能含私密内容，分享前自行检查。

## 开发与验证

```sh
npm run check
npm test
# 可选：已有 Playwright 和浏览器时，不自动下载
npm run test:browser
```

v1.0.0 发布准备回归：**133 项 Node／110 项 Chrome 流程**，写操作仅隔离 fixture。此前真实个人服务 GET／取消验收未修改 Skill、配置或偏好。LSP 的无错误结果仍可能 inconclusive；手机为 viewport 模拟，普通文件 symlink／POSIX 分支未作完整本次验证。环境检查不模拟完整升级兼容测试。

可选浏览器工具不属于运行依赖。支持 `PLAYWRIGHT_PACKAGE_DIR` 指向能解析已安装 Playwright 的 package.json 目录，以及 `BROWSER_EXECUTABLE` 指向已有浏览器。测试生成的 `verification/` 不纳入版本库；发布不依赖本机历史验收 JSON。

## 来源与许可

复用已安装 Pi 的资源解析、配置、frontmatter、锁、YAML 和 jsdiff；ZIP 固定使用 yauzl 3.4.0／yazl 3.3.1。没有打包 Pi 或第三方源码，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

**源码公开，但本项目尚未指定开源许可证。** 不因 GitHub 可见而默认授予 MIT 等许可；依赖分别适用自己的许可证。npm `private: true` 防止误发 npm 包，不影响 GitHub 源码仓库公开。
