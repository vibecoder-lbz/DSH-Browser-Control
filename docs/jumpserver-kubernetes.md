# 通过 JumpServer 网页终端操作 Kubernetes

适用插件版本：`dsh-browser-use 0.5.1`。本指南提供操作方式与命令模板，自动化回归使用本地模拟终端；实际环境中的发布仍需明确目标和授权。

## 连接到正确的资产

可以使用插件独立浏览器登录 JumpServer，也可以加载 Chrome 扩展后自动连接并复制已登录页面。副本模式只在同一浏览器窗口中标记“被接管”的后台副本操作，不新开窗口或自动切前台；现有 SSH 会话不保证随网页复制，需要在副本重新选择资产。独立模式无需扩展，复制接管模式需要随附扩展，两者都需满足 JumpServer 的 MFA、审批、资产授权与网络 / VPN 要求。

镜像更新需要能够使用 `kubectl` 并具备相应 Kubernetes RBAC 权限的远程环境。常见入口是 JumpServer 中已配置好 `kubectl` 与 kubeconfig 的运维机 / 管理节点资产。

**JumpServer 的 Kubernetes 容器终端与集群管理终端需要区分。** 进入某个 Pod / 容器，仅代表连接到这个容器；不能据此推断其中装有 `kubectl` 或账号拥有更新 Deployment 的权限。应使用你实际授权的管理入口。

## 终端工具

使用 `browser_open` 打开 JumpServer，通过普通浏览器工具选择资产并进入 Web SSH。网页终端可能在 iframe 中，`browser_terminal` 会跨 frame 查找 `.xterm` 元素。

```jsonc
// 查看当前标签页中的终端，选择正确的资产 / 会话
browser_terminal({ "action": "list", "screenshot": true })

// terminalId 以实际返回值为准；文字输入不自动提交
browser_terminal({ "action": "type", "terminalId": "terminal1", "text": "kubectl config current-context" })
browser_terminal({ "action": "press", "terminalId": "terminal1", "key": "Enter" })

// 等待并读取；没有 waitForText 时只等待指定时间后观察
browser_terminal({ "action": "wait", "terminalId": "terminal1", "timeoutMs": 1000, "screenshot": true })
browser_terminal({ "action": "read", "terminalId": "terminal1", "screenshot": true })
```

`terminalId` 绑定真实的终端 DOM 元素和所在浏览器标签页。重新执行 `list` 或不带 ID 的自动发现会更新 ID，旧 ID 将报错。存在多个终端时必须先明确选择，工具不会替你猜测资产。

终端 `type` 使用键盘事件，支持 1–4096 个可打印 ASCII 字符，拒绝换行与控制字符。命令、回车、Ctrl 等按键分开传递。不要用普通输入框的 `fill` 操作终端，也不要把 Ctrl+A 当作全选；在常见 shell 中，Ctrl+A 表示移动到行首。确认 shell 正在等待输入后，可用 `Control+U` 清除当前输入行。

输入结果 `input.dispatched` 只表示浏览器已派发输入，不能证明远端收到、命令退出或发布成功。观察失败后应先检查当前状态，不能自动重发回车，以免重复执行命令。任何输入调用被中断或取消时，都应视为可能已经部分或全部送达；传输确认丢失会返回 `delivery=unknown`，截图附件故障也会保留已知输入结果。

## 终端文字与截图

JumpServer 不同版本的终端渲染方式可能不同。插件支持：

- xterm 的无障碍 DOM 行：`outputSource=accessibility`。
- xterm 的 DOM 渲染行：`outputSource=dom`。
- Canvas / WebGL 且没有无障碍 DOM：`outputSource=visual-only`，返回 `textReadable=false`。

在第三种情况下，需要支持图片输入的模型查看终端截图。纯文本模型无法据此自动验证终端输出。工具不会访问 xterm 私有对象、提取 kubeconfig 或绕开 JumpServer 的授权连接。

读取的 DOM 文字是当前可访问的终端行，长度受 `maxTextChars` 限制，不是完整 SSH 转录或历史缓冲。长输出应缩小查询范围，或通过页面滚动 / 终端命令分页查看。

`wait` 的 `timeoutMs` 轮询预算最大为 30000 ms。浏览器调用和输出读取也需要时间；页面渲染线程卡住时，等待可能超过该预算，此时应取消工具，插件会关闭它拥有的浏览器。带 `waitForText` 时返回 `matched` 或 `timedOut`；没有可读文字时返回 `unsupported=true`。这只是浏览器端观察时长，不会终止远端命令。文本匹配可能命中屏幕上的旧内容，也不能替代退出码。验证某次命令时应使用本次独有的结果标记，并核对实际资源状态。

## 更新 Deployment 镜像的流程

以下全部是模板，需要先替换 `CONTEXT`、`NAMESPACE`、`DEPLOYMENT`、`CONTAINER` 和 `IMAGE` 等占位符。每次向终端输入一条命令，再按 Enter；不要把多行一起发送。

1. 核对管理环境、集群上下文、命名空间与工作负载，记录当前镜像及容器名称。

```sh
kubectl config get-contexts
kubectl --context=CONTEXT --namespace=NAMESPACE get deployment DEPLOYMENT -o wide
kubectl --context=CONTEXT --namespace=NAMESPACE get deployment DEPLOYMENT -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}'
kubectl --context=CONTEXT --namespace=NAMESPACE auth can-i patch deployments.apps
```

如果服务由 Helm、Argo CD、Flux 等管理，应在对应的 chart / values / Git 声明源中更新镜像并按原流程发布，避免控制器随后恢复旧配置。以下 `set image` 示例适用于允许直接修改工作负载的部署流程。

2. 使用明确的镜像版本或 digest 更新指定容器。

```sh
kubectl --context=CONTEXT --namespace=NAMESPACE set image deployment/DEPLOYMENT CONTAINER=IMAGE
```

3. 等待滚动发布。发布可持续数分钟，终端工具的单次轮询预算最多 30 秒，应继续观察同一条命令，而非重复执行更新。

```sh
kubectl --context=CONTEXT --namespace=NAMESPACE rollout status deployment/DEPLOYMENT --timeout=300s
```

需要机器可读的结果标记时，可将下面模板作为一整行输入，并将标记替换为本次唯一值。等待 `rollout_UNIQUE_ID=0` 可以避免命中命令本身的回显；仍需继续核对资源状态。

```sh
kubectl --context=CONTEXT --namespace=NAMESPACE rollout status deployment/DEPLOYMENT --timeout=300s; rc=$?; printf '\n%s=%s\n' 'rollout_UNIQUE_ID' "$rc"
```

4. 核对工作负载中的镜像、更新副本与 Ready 副本，再按实际 Pod 标签选择器查看 Pod 的镜像 ID 和容器状态。

```sh
kubectl --context=CONTEXT --namespace=NAMESPACE get deployment DEPLOYMENT -o wide
kubectl --context=CONTEXT --namespace=NAMESPACE get deployment DEPLOYMENT -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}'
kubectl --context=CONTEXT --namespace=NAMESPACE get pods -l SELECTOR -o wide
kubectl --context=CONTEXT --namespace=NAMESPACE get pods -l SELECTOR -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.name}{"="}{.imageID}{" ready="}{.ready}{" "}{end}{"\n"}{end}'
```

StatefulSet、DaemonSet 等工作负载应使用对应的资源类型和发布策略，不能直接照搬 Deployment 名称。

关闭浏览器、中断浏览器工具或发送 Ctrl+C，不等同于撤销镜像更新。浏览器关闭只会结束其连接，远端命令是否继续由 SSH / JumpServer 决定；Ctrl+C 中断 `rollout status` 的等待也不会回滚 Deployment。回退应按已有发布流程和用户授权执行。

## 实际接入时需要的信息

- JumpServer 地址与版本，以及连接的是运维机资产还是直接容器终端。
- 集群 context、namespace、工作负载类型 / 名称和容器名称。
- 新镜像完整地址及版本 / digest。
- 现有发布方式：直接 kubectl，或 Helm / GitOps。

密码、MFA 和验证码可以在插件窗口中手动输入，无需发到聊天里。拿到上述环境信息后，先验证终端输入与输出，再按明确的发布目标操作。

## 参考实现

以下源码用于判断终端结构，具体页面以你的 JumpServer 版本为准：

- [JumpServer Luna 的 KoKo iframe 连接器（v4.10.16）](https://github.com/jumpserver/luna/blob/v4.10.16/src/app/elements/content/content-window/koko/koko.component.ts)。
- [JumpServer KoKo 的 xterm / WebGL 与输入处理（v4.10.16）](https://github.com/jumpserver/koko/blob/v4.10.16/ui/src/hooks/useTerminalSocket.ts)。
- [xterm.js 键盘输入处理（5.5.0）](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/Terminal.ts)。
- [Kubernetes Deployment 更新文档](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#updating-a-deployment)。
