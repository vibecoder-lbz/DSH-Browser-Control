# 按页面场景编辑配置与代码

适用版本：`dsh-browser-use 0.5.1`。

普通表单、网页代码编辑器和 SSH 终端接收输入的方式不同。`browser_editor` 会先识别编辑器类型和文档格式，再选择对应编辑方式。它读取编辑器真实文档，生成改动预览并校验，而不是数空格或把文字直接拼到光标处。

## 识别什么

识别依据包括编辑器公开的语言标签和实际文档内容：

| 识别结果 | 典型页面 | 可用的结构化操作 |
| --- | --- | --- |
| YAML | Nacos、Spring 配置、Kubernetes 清单 | `yaml_set`、`yaml_delete`、`replace` |
| JSON | 接口配置、应用设置 | `json_set`、`json_delete`、`replace` |
| properties / INI | Java properties、传统配置文件 | `properties_set`、`properties_delete`、`replace` |
| XML / HTML | 页面模板、XML 配置 | `replace`（唯一片段） |
| SQL | 数据库脚本 | `replace`（唯一片段） |
| JavaScript / TypeScript | 代码编辑器 | `replace`（唯一片段） |
| text | 普通多行文本 | `replace`（唯一片段） |

`list` 和 `read` 会返回 `format`、`formatConfidence` 和 `capabilities`。如果编辑器语言标签写错，例如纯文本模式的 Ace 实际装着 JSON，会优先按内容识别，避免把 JSON 当 YAML 重排。

结构化操作不会用于错误格式：例如在 JSON 文档上执行 `yaml_set` 会被拒绝，并提示使用 `json_set` 或精确替换。

## Nacos YAML 示例

假设当前配置为：

```yaml
server:
  port: 8080
env:
  EXISTING: "keep this"
```

你可以对 Agent 说：

> 在这个 Nacos 配置的 env 下新增 NEW_OPTION，字符串值为 new-value。先展示改动，不发布。

工具根据路径 `["env","NEW_OPTION"]` 生成：

```yaml
server:
  port: 8080
env:
  EXISTING: "keep this"
  NEW_OPTION: new-value
```

字段作为 `env` 的子项，与 `EXISTING` 同级。若已有缩进为 4 个空格，会沿用推断出的缩进；换行保留 LF / CRLF，常见注释、引号和锚点会保留。多行字符串会生成正确缩进的 YAML 字面量块。

YAML AST 序列化仍可能规范化流式集合的空格或空行。修改前应查看预览。工具会重新解析结果并核对目标路径和值；如果原文档使用 YAML 锚点，而本次修改会让别名引用到不同值，会拒绝操作，避免改一个字段却影响其他位置。

## JSON 与 properties

JSON 使用同样的路径语法，并保留检测到的缩进与换行：

```jsonc
// JSON: {"env":{"MODEL":"old"}}
browser_editor({
  "action": "preview",
  "editorId": "editor1",
  "expectedRevision": "<read 返回的 revision>",
  "operation": "json_set",
  "path": "[\"env\",\"NEW\"]",
  "valueJson": "\"plain\""
})
```

properties 支持 `[key]` 或 `[section,key]` 路径，新增键放在对应 section 已有键之后，并保留行内注释：

```jsonc
browser_editor({
  "action": "preview",
  "editorId": "editor1",
  "expectedRevision": "<read 返回的 revision>",
  "operation": "properties_set",
  "path": "[\"server\",\"timeout\"]",
  "value": "30"
})
```

缺少父级或 section 时默认拒绝，确认需要创建后显式设置 `createMissing:true`。禁止空路径替换整个文档。

## 操作流程

1. 在受控副本中进入目标编辑页。明确实际环境，避免同名配置。
2. `list` 识别编辑器、格式和可用操作；多个编辑器时选择 ID。
3. `read` 读取相关行，获得完整文档的 revision。
4. `preview` 生成结构化改动，校验原文和结果，返回预览与 planId。
5. 按已授权任务 `apply` 将预览写入编辑器草稿，并立即读回核对。
6. 如确需发布，再独立检查页面和用户授权，执行对应发布流程。

`preview` 不改页面；`apply` 不点击“发布”“保存”。某些网站本身会自动保存文档，工具无法把该站点的自动保存转换为本地草稿，应先了解页面行为。Nacos 的发布按钮仍是独立操作。

## 调用示例

```jsonc
browser_editor({ "action": "list" })

browser_editor({
  "action": "read",
  "editorId": "editor1",
  "startLine": 20,
  "lineCount": 60
})

browser_editor({
  "action": "preview",
  "editorId": "editor1",
  "expectedRevision": "<read 返回的 revision>",
  "operation": "yaml_set",
  "path": "[\"env\",\"NEW_OPTION\"]",
  "valueJson": "\"new-value\""
})

browser_editor({
  "action": "apply",
  "editorId": "editor1",
  "planId": "<preview 返回的 planId>"
})
```

`path` 是 JSON 数组形式的字符串，`valueJson` 是 JSON 编码的值：

| 想写入的值 | valueJson 的内容 | 示例工具参数 |
| --- | --- | --- |
| 字符串 `new-value` | `"new-value"` | `"valueJson": "\"new-value\""` |
| 数字 8080 | `8080` | `"valueJson": "8080"` |
| 布尔值 true | `true` | `"valueJson": "true"` |
| 空值 null | `null` | `"valueJson": "null"` |
| 对象 / 数组 | 对应 JSON | `"valueJson": "{\"enabled\":true}"` |

环境变量通常要求字符串；例如端口环境变量需要 `"8080"`，不要误写成数字 `8080`。

路径中的字符串表示映射键，数字表示数组索引：

```jsonc
// 字段名里带点号：整个字段名仍是一个键
{ "path": "[\"env\",\"spring.datasource.url\"]" }

// 列表内第一个容器的 image
{ "path": "[\"spec\",\"containers\",0,\"image\"]" }
```

所有格式都支持 `operation:"replace"`，要求 `oldText` 在文档中只出现一次。YAML 和 JSON 的替换结果会重新解析校验；其他格式按原文替换。没有明确唯一片段时不会猜测替换位置。

## 通用编辑器支持

| 页面控件 | 处理方式 |
| --- | --- |
| Ace（常见于 Nacos） | 读取真实 session，替换差异区域，保留撤销历史 |
| Monaco | 通过公开编辑器 / model API 读取和 executeEdits，保留撤销历史 |
| CodeMirror 5 | 公开实例的文档读取与 replaceRange |
| 普通 textarea | 原生值与 input / change 事件 |
| iframe 内以上编辑器 | 随 frame 查找并绑定实际实例 |
| CodeMirror 6、封装后未公开 API 的编辑器 | 明确不支持，需要单独适配；不会盲目填写隐藏输入框 |
| 普通单行表单 | 继续使用 browser_act 的 fill / type |
| JumpServer 网页终端 | 继续使用 browser_terminal，命令和 Enter 分开发送 |

## 并发、隐私与恢复

- revision 覆盖完整文本、真实编辑器文档对象、页面路由和 iframe 地址。切换 Nacos 配置、替换编辑器模型或有人改动内容，旧 preview / apply 都会失效。
- planId 仅保留当前会话最新预览，有效 10 分钟，并绑定具体编辑器和文档。
- 页面导航、编辑器切换或会话断开后，重新列出与读取，不能复用旧 ID。
- 读取按行限量返回，默认 60 行，最多 200 行。隐藏敏感字段时先扫描完整文档，再截取行，避免只读密码块中间行时泄露内容；这不是完整的 DLP 或凭证扫描器。
- 保存失败、发布失败或页面观察失败不能通过盲目重试写入解决，先重新读取当前值。
- Ace / Monaco / CodeMirror 5 支持编辑器自身撤销；textarea 的撤销行为由浏览器决定。

[插件总说明](../README.md) · [浏览器接管](./existing-chrome.md) · [JumpServer 操作](./jumpserver-kubernetes.md)

