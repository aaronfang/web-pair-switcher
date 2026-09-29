# 网页双页切换器

网页双页切换器（Web Pair Switcher）是一个 Manifest V3 Chrome 扩展，配合一个轻量 macOS Native Messaging 助手使用。它可以在任意两个自定义 URL 页面之间切换，聚焦目标 Chrome 窗口，尝试播放目标页的视频，并暂停另一页的视频。

## 安装

1. 打开 Chrome 的 `chrome://extensions`，开启“开发者模式”。
2. 选择“加载已解压的扩展程序”，选中这个目录。
3. 在扩展详情中打开“扩展程序选项”，设置页面 A、页面 B 和全局快捷键。
4. 安装 macOS 全局快捷键助手：

   ```sh
   cd /path/to/web-pair-switcher
   zsh native-host/install-native-host.sh
   ```

   这个脚本会构建助手，并注册 Chrome Native Messaging host。需要安装 Xcode Command Line Tools 或 Swift 工具链。

Chrome 需要保持打开；Chrome 窗口可以在后台，甚至位于另一个 Space。Chrome 完全退出时没有可切换的标签页。

普通组合键使用 macOS 系统热键注册 API，不需要“辅助功能”或“输入监控”权限。只有启用“右侧 Option（单击）”模式时，才需要允许助手监听左右修饰键。

## 自定义页面

在扩展选项中填写 Chrome URL match pattern，例如：

- `*://*.douyin.com/*`
- `https://www.bilibili.com/video/*`
- `https://example.com/watch*`

保存时 Chrome 会请求访问这些页面的权限。两个页面不要求同一网站，也不要求一定有视频；没有 HTML `<video>` 时仍会切换窗口，但不会有播放控制效果。

## 自定义快捷键

扩展选项中的“全局快捷键”输入框支持点击后直接按组合键，例如 `⌥⇧Y`。也可以在输入框中单独按一下右侧 Option，把 `RightAlt` 设置为专用切换键；左侧 Option 不会触发。它由 macOS 助手捕获，所以 Chrome 不在前台时也能工作。

首次保存 `RightAlt` 时，macOS 会要求辅助功能权限。请在“系统设置 → 隐私与安全性 → 辅助功能”中允许：

`~/Library/Application Support/WebPairSwitcher/web-pair-switcher-global-hotkey`

授权后在 `chrome://extensions` 重新加载扩展。右 Option 与其他按键组合使用时不会切换，只有单独按下并松开才会触发。

另外，Chrome 内部快捷键仍可在 `chrome://extensions/shortcuts` 设置；它只在 Chrome 有焦点时可用。全局助手和 Chrome 内部命令同时收到同一个按键时，扩展会去重，避免切换两次。

## macOS Spaces 说明

扩展会通过 Chrome API 聚焦目标标签所在的窗口，但 Chrome 扩展和 Native Messaging 都没有直接操作 Mission Control 的 API。是否自动跳到目标窗口所在 Space 由 macOS 的窗口切换设置决定；如果没有切换，请检查“系统设置 → 桌面与程序坞 → Mission Control”中的相关选项，并确认两个 Chrome 窗口确实位于不同 Space。

## 设置与诊断记录

点击扩展图标即可打开设置，切换页面和快捷键设置不必进入扩展管理器；也可以从扩展详情页打开独立选项页。

调试日志默认关闭。需要排查问题时，在设置中打开“收集调试日志”；此后才会记录最近 300 条快捷键和切换流程事件，Service Worker 重启后仍可查看。开始测试前可先清空记录；复现几次后点击“刷新”和“复制记录”，把记录发给我分析。日志包含事件时间、来源、目标 tab/window ID、执行阶段和错误，不记录页面 URL 或页面内容。若完全没有 `native.message` 的 `hotkey` 事件，扩展侧无法判断耳机/键盘事件是否到达 macOS Native Host；但 `native.connected` 和 `native.message` 中的配置状态可用于确认助手是否已连接并注册快捷键。

## 故障排查

- 扩展选项页显示“macOS 常驻助手未连接”：重新运行 `native-host/install-native-host.sh`，然后在 `chrome://extensions` 点击扩展的重新加载。安装脚本必须显示 `Native host installation verified`。
- 设置右 Option 后提示需要辅助功能权限：按上面的路径授权，然后重新加载扩展；左 Option 不需要也不会触发。
- 快捷键能切换窗口但不能播放：浏览器自动播放策略可能拦截了 `video.play()`；先在目标页面手动播放一次，再重试。
- 目标页面找不到：确认 URL match pattern 正确，并在扩展详情中允许访问该网站。

## 开发

运行项目级检查（JavaScript/JSON/shell 语法、Node 单元测试和 SwiftPM 构建）：

```sh
./script/check.sh
```

修改 Native Host 名称或可执行文件后，需要重新运行 `zsh native-host/install-native-host.sh`，再从 `chrome://extensions` 重新加载扩展。
