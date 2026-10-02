# 测试与兼容性

## 基线

v1.0.0 在 Windows、Node 24.14.0、Pi 1.0.0 上准备发布。运行依赖锁定 ZIP 包；Pi 是外部已安装依赖，内部 dist API 不是长期公共兼容承诺。

```sh
npm ci --ignore-scripts
npm run check
npm test
```

133 个 Node 测试（原功能 129＋4 个环境检查）。所有写入测试使用随机 fixture；不要给测试脚本传真实 Skill／设置路径。环境检查只核验入口，不执行原生发现或写设置；旧 Node／缺 API 明确失败。

GitHub Actions 在临时 Windows runner 上安装固定 Pi 1.0.0，设置 PI_PACKAGE_DIR 后运行上述检查；不提供账号、模型密钥或个人配置。

## 可选浏览器回归

已有 Playwright 和浏览器时：

```sh
npm run test:browser
```

七个套件共 110 项：基础32、整理15、清理7、易用性13、工作区14、三栏集成20、分组改名9。使用可见导航和真实隔离 fixture API；不自动下载浏览器或安装工具。复用本地可解析 Playwright，或设置 PLAYWRIGHT_PACKAGE_DIR 指向可解析它的 package.json 目录，BROWSER_EXECUTABLE 指向现有浏览器。

测试生成 verification 报告／截图，全部忽略，不入 Git。三栏测试从本次源码建立开始／结束摘要，不依赖作者本机历史 baseline JSON。历史静态 prototype、真实个人只读脚本、原生 Explorer 的本机证据不属于公开发布集合。

## 诚实边界

- LSP 无错误可能仍 inconclusive，不能当成已确认类型检查全绿。
- 手机是 viewport 模拟，不是真机验收。
- Windows junction 拒绝有实际 fixture 测试；普通文件 symlink 可能因权限 EPERM 无法测试，POSIX 分支不冒充已在 Windows 验证。
- 大规模／故障／时钟边界有注入测试，不等于实际制造每一种极端规模或外部竞态。
- 独立审查是源码／证据检查，不宣称审查者独立执行了全部测试。
- 不修补或分发本机 Pi 子代理插件。管理器不依赖它；开发过程中的插件兼容处理不是产品安装步骤。

升级 Pi 时先备份，在隔离环境运行测试；不兼容时停止使用，不自动迁移或猜测原配置意义。
