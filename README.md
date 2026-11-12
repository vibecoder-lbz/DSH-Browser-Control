# DSH Browser Use

让 DSH 中的 Agent 控制真实的 Chrome / Edge 浏览器。支持按页面元素操作，也支持截图、坐标点击、键盘、滚动和拖拽，适合搜索、填表、后台管理及网页流程自动化。

这是 **DSH 服务端插件**，安装后模型会获得 7 个浏览器工具，包含 Chrome 副本接管与 JumpServer / xterm 网页终端操作。DSH 运行时，随附 Chrome 扩展安装后自动连接，**无需配对码**；选定页面后，在原窗口后台创建或复用唯一副本并标记“被接管”，不新开窗口、不自动切换标签页，控制副本而不操作原页面。启动独立浏览器无需扩展，两种模式都不需要额外 MCP 服务。

当前版本：`0.4.3`。适配 **DSH `0.2.2-rc.1`** 和 Node.js `>=24.9.0`。浏览器驱动使用 `playwright-core`，优先使用本机 Chrome，其次 Edge，也可指定 Chromium 路径；不自动下载浏览器。

安装或升级请先看 [更新与使用手册](./docs/update-manual.md)，其中包含 Chrome 扩展更新、DSH 插件升级、更新验证、故障处理和回退步骤。

## 安装

### 本地开发

在项目目录运行：

```powershell
npm install --ignore-scripts
npm run check
npm test
```

将目录作为组合包安装进 DSH。将 `web` 替换为你实际使用的 profile：

```powershell
dsh plugin --profile web add "D:\project\dsh_plugin"
```

也可以在 DSH 左侧“插件”页面选择安装本地包，输入这个目录的绝对路径。

配置支持实时重载时会直接应用；如果返回需要重启，请重启原有 DSH 进程。插件是服务端工具，不需要启动另一个 Web 服务。安装影响使用该 profile 的会话。

### 安装打包版本

```powershell
npm run pack:plugin
dsh plugin --profile web add "D:\project\dsh_plugin\dsh-browser-use-0.4.3.tgz"
```

如果已安装旧版组合包，先使用 `dsh plugin --profile web remove dsh-browser-use` 移除，再添加新版安装包；如提示需要重启，重启原有 DSH 进程。

发布到 npm 后可改用 `dsh plugin --profile web add dsh-browser-use`。本项目目前仅提供本地源码与安装包，没有发布到公共注册表。

## 开始使用

安装后直接在对话中描述任务，例如：

> 打开浏览器，访问 https://example.com，告诉我页面上有什么。

> 打开浏览器访问我的测试系统，等我登录后，帮我填写这张表单，并在提交前把内容展示给我。

> 对当前浏览器页面截图，点击画布中的蓝色按钮，然后检查结果。

接管当前 Chrome：按 [副本接管指南](./docs/existing-chrome.md) 加载 [扩展目录](./chrome-extension/)，扩展会自动连接正在运行的 DSH；无需填写令牌。说“复制并接管当前 Chrome 里的 JumpServer 页面”，Agent 按网址 / 标题匹配原页面，在同一窗口后台创建唯一副本；重复接管、重连和换会话会复用它，已占用时提示而不再复制。原页面不会被输入或关闭。副本共享网站登录与后台数据，但不保证保留未提交表单、JavaScript 内存或现有 SSH 会话。

新开浏览器：`browser_open` 启动**可见的独立浏览器窗口**。可以手动登录或处理验证码，再让 Agent 继续。该模式登录信息只保留在本次浏览器会话的临时配置目录内，关闭浏览器或闲置 15 分钟后清理。

DOM 页面文本和元素引用适用于纯文本模型。截图会通过 DSH 附件服务传递给支持图片输入的模型；当前模型不支持图片时，插件返回文字提示和 DOM 快照。

## 工具

| 工具 | 功能 |
| --- | --- |
| `browser_connect` | 自动连接扩展、匹配源页面、复制并标记受控副本、释放连接 |
| `browser_open` | 启动浏览器、导航到网址、可选新标签页与截图 |
| `browser_observe` | 返回当前网址、标题、可见交互元素、各 frame 的文本和标签页列表 |
| `browser_act` | 点击、双击、悬停、填入、输入、按键、滚动、拖拽、选择下拉选项、前进、后退、刷新、短暂等待 |
| `browser_tabs` | 列出、新建、切换、关闭标签页 |
| `browser_terminal` | 发现 iframe 内的网页终端、逐键输入、单独回车、读取可访问输出、等待结果与截图 |
| `browser_close` | 已有 Chrome 模式仅释放控制、保留网页；独立模式关闭浏览器并清理临时配置 |

每次操作返回新的页面观察。可交互元素具有 `s3e2` 一类的引用 ID，以及名称、角色、状态和位置。引用与当时的真实元素绑定，每次观察后更新；旧引用会报错，避免页面改变后误点另一个元素。

### 调用示例

```jsonc
// 已有 Chrome：扩展自动连接；按查询复制并接管目标网页
browser_connect({ "action": "status" })
browser_connect({ "action": "select", "query": "JumpServer", "screenshot": true })

// 或启动新的独立浏览器
browser_open({ "url": "https://example.com", "screenshot": true })

// 使用最近一次观察返回的 ref；具体 ID 以实际结果为准
browser_act({ "action": "click", "ref": "s1e3" })

// 也可以使用唯一的 Playwright selector
browser_act({ "action": "fill", "selector": "input[name='email']", "text": "hello@example.com" })
browser_act({ "action": "press", "key": "Tab" })
browser_act({ "action": "press", "key": "ControlOrMeta+A" })

// 坐标基于浏览器可视区域左上角，使用 CSS 像素
browser_act({ "action": "click", "x": 420, "y": 280, "screenshot": true })
browser_act({ "action": "scroll", "deltaY": 600 })
browser_act({ "action": "drag", "x": 100, "y": 200, "toX": 400, "toY": 200 })

// 下拉选项和标签页
browser_act({ "action": "select", "selector": "select[name='city']", "value": "sh" })
browser_tabs({ "action": "new", "url": "https://example.org" })
browser_tabs({ "action": "switch", "tabId": "tab1" })
browser_close({})
```

`fill` 替换输入框现有内容；`type` 在光标处插入文字；`press` 用于 Enter 等按键。`wait` 的 `waitMs` 范围为 1–5000 ms，默认 500 ms，可用于等待异步页面更新。`ref`、`selector` 与 `x/y` 三种目标只能选择一种。iframe 与开放的 Shadow DOM 可以通过元素引用操作。

截图默认关闭，开启时只截取可视区域。截图在保存为 DSH 附件时可能被缩小，返回文字会给出图片坐标转 CSS 坐标的比例。

## JumpServer 与 Kubernetes

进入 JumpServer 的 Web SSH 后，使用 `browser_terminal` 定位终端。命令文字与 Enter 分开发送；输出优先读取 xterm 的无障碍 DOM 或 DOM 渲染行。Canvas / WebGL 没有可读行时会明确返回 `textReadable=false`，需要支持图片输入的模型查看截图。

更新 Kubernetes 镜像需要进入已配置 `kubectl` 并具备对应 RBAC 权限的管理环境。JumpServer 的直接 Pod / 容器终端不代表拥有工作负载更新权限。完整流程、工具调用和命令模板见 [JumpServer / Kubernetes 指南](./docs/jumpserver-kubernetes.md)。本地测试通过不代表已经连接或验证了你的实际集群。

## 配置

组合包入口 [cordis.patch.yml](./cordis.patch.yml) 提供默认配置。需要覆盖时，在当前 profile 的配置补丁中添加：

```yaml
- id: browser-use
  config:
    headless: false
    # executablePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    viewportWidth: 1280
    viewportHeight: 800
    actionTimeoutMs: 10000
    navigationTimeoutMs: 30000
    launchTimeoutMs: 30000
    idleTimeoutMs: 900000
    maxElements: 100
    maxTextChars: 12000
    bridgePort: 19876
```

也可以用环境变量 `DSH_BROWSER_EXECUTABLE` 指定浏览器。`browser_open` 的 `headless` 参数可以覆盖新启动浏览器的显示方式；已有浏览器的显示方式不变，需先关闭再重开。

浏览器控制按 DSH 会话管理，同一会话中的操作顺序执行。已有 Chrome 模式下，一个副本只能被一个会话占用；原标签页不会被附加或关闭。取消 / 超时 / 卸载只释放副本控制并移除接管标识，保留原页面和副本。独立模式下，插件卸载、DSH 正常退出或工具取消会关闭插件拥有的浏览器并清理临时配置。远程 SSH 命令可能在浏览器断开后继续运行，关闭连接或 Ctrl+C 不等同于回滚 Kubernetes 更新。

## 本地演示与验证

```powershell
npm run demo
```

该命令运行一个本地演示页面，在浏览器中填写表单并提交，生成 [demo.png](./.artifacts/demo.png) 和 [demo.json](./.artifacts/demo.json) 后关闭浏览器和本地服务。设置 `$env:DEMO_HEADLESS='1'` 可以隐藏演示窗口。

`npm test` 使用真实的本机 Chrome / Edge，验证表单提交、选择框、引用过期处理、iframe、Shadow DOM、坐标操作、键盘、滚动、标签页、不同会话隔离以及取消和关闭时的资源清理。另使用真实 xterm.js 5.5 与 WebGL 渲染器验证终端单行输入、回车、控制键、异步输出等待、多个 SSH 会话选择和无文本时的截图回退。测试只使用本地页面和模拟命令，没有连接真实集群。

主要源文件：

- [index.js](./src/index.js)：DSH 配置、工具注册、模型图片能力检测、附件与结果渲染。
- [browser.js](./src/browser.js)：浏览器进程、独立会话、操作和取消清理。
- [snapshot.js](./src/snapshot.js)：可见元素和文本快照、frame / Shadow DOM 识别及引用管理。
- [terminal.js](./src/terminal.js)：网页终端发现、键盘输入、输出观察与轮询。
- [url.js](./src/url.js)：在网址元数据中隐藏 JumpServer 连接令牌。
- [终端测试](./test/terminal.test.js)：真实 xterm / WebGL 的浏览器兼容性验证。
- [浏览器测试](./test/browser.test.js) 和 [插件集成测试](./test/plugin.test.js)：本地页面操作与 DSH / Cordis 接口验证。

## 当前范围

- 支持 Chrome、Edge 和 Chromium 网页操作；不提供 Windows 桌面、原生文件选择器或其他应用的控制。
- 已有 Chrome 通过固定身份扩展自动连接仅绑定本机的桥，副本显示标题前缀、标签组和页面角标；独立模式使用临时配置和本机 CDP。Chrome 扩展要求 125 及以上。
- 副本通过 `active:false` 在源窗口后台打开同网址，不调用会短暂激活页面的原生复制接口。共享 Cookie、localStorage 和服务器数据，不复制导航历史、表单或实时 JS / SSH 状态。
- 某些 Chrome 不绘制被遮挡的后台页面；截图不可用时返回说明，不通过切前台或开窗口获取画面。DOM 操作仍可继续，纯画布终端则需手动选中副本才能视觉核对。
- 模型导航接口接受 HTTP(S) URL；没有提供任意 JavaScript 执行工具。
- DOM 快照列出当前可视区域的交互元素，并返回有限长度的页面文字。页面更新后可重新观察；隐藏内容需展开或滚动查看。关闭的 Shadow DOM 或自绘控件可结合截图和坐标操作。
- 独立模式中的 JavaScript 弹窗会自动关闭并记录，下载会取消；已有 Chrome 模式不注册独立模式的下载拦截。Playwright 可能自动处理阻塞对话框。本版本未实现上传与下载流程。
- 页面内容始终作为外部数据返回。表单提交、发送、购买等操作的授权由 Agent 根据用户指令处理，插件不增加逐次确认弹窗。
- 当前组合包将工具注册到整个 profile；如需仅在某一预设中使用，可将插件条目放入自定义预设的 `config.plugins`。
- DSH 版本匹配限制为当前验证的 `0.2.2-rc.1`。升级 DSH 时应先验证工具与附件接口，再调整版本声明。

卸载：

```powershell
dsh plugin --profile web remove dsh-browser-use
```

## License

MIT
