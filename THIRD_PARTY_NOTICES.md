# 第三方说明

本仓库不打包 node_modules、Pi 安装目录、第三方源码或本机插件补丁。以下组件通过正常依赖安装或既有 Pi 安装复用；它们的许可证不等于本项目许可证。

| 组件 | 版本／用途 | 许可证 |
|---|---|---|
| yauzl | 3.4.0，ZIP 读取 | MIT |
| yazl | 3.3.1，ZIP 写入 | MIT |
| pend | 1.2.0，yauzl 的传递依赖 | MIT |
| buffer-crc32 | 1.0.0，yazl 的传递依赖 | MIT |
| @earendil-works/pi-coding-agent | 已验证1.0.0，资源解析／配置／frontmatter | MIT |
| jsdiff / diff | 已验证 Pi 安装提供8.0.4，structuredPatch | BSD-3-Clause |
| proper-lockfile | 已验证 Pi 安装提供4.1.2，文件锁 | MIT |
| yaml | 已验证 Pi 安装提供2.9.0，YAML | ISC |
| Playwright | 可选、由用户已安装的工具提供，仅测试 | Apache-2.0 |

ZIP 依赖的版本、来源与完整性固定在 package-lock.json；npm ci --ignore-scripts 安装后许可证保留在各包内。Pi 内部模块只导入、不复制或分发；新 Pi 版本需重新验收。标准 GitHub Actions 工具使用各自官方分发。

来源：[Pi](https://github.com/earendil-works/pi)、[yauzl](https://github.com/thejoshwolfe/yauzl)、[yazl](https://github.com/thejoshwolfe/yazl)、[jsdiff](https://github.com/kpdecker/jsdiff)、[Playwright](https://github.com/microsoft/playwright)。本项目源码暂未指定开源许可证，未默认授予上述依赖的许可证给本项目。
