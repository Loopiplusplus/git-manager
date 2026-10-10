# 04 · GitHub 集成与 OAuth 授权

> 本文回答一个具体问题：**本地应用要怎么安全地连上 GitHub？**
> 结论是 OAuth 2.0 Device Flow（设备码流程），它只需要 `client_id`，**不需要 `client_secret`**。

---

## 1. 为什么不用常见的「回调式 OAuth」

评估过三条路：

| 方案 | 是否需要 client_secret | 能否用于本地/桌面应用 | 结论 |
|---|---|---|---|
| **OAuth 2.0 Device Flow** | ❌ 不需要 | ✅ GitHub 官方为 CLI／桌面应用设计 | **采用** |
| OAuth 2.0 Authorization Code（回调式） | ✅ 必须有 | ❌ 本地应用只能把 secret 硬编码进客户端，等于公开泄露 | 排除 |
| Personal Access Token | 不需要，但需手工创建 | ✅ 可用 | **保留为备选** |

### 关键判断

回调式流程换取 token 时，GitHub 要求客户端携带 `client_secret` 做 Basic 认证。
本地应用（浏览器里的 JS、桌面程序）**没有任何办法安全地保存 secret** —— 客户端里的一切
都能被提取出来。常见的"解决方式"是硬编码，但那只等于把 secret 公开了。

Device Flow 绕开了这个问题：它由 GitHub 直接生成一个**短时效设备码**，
用户在浏览器里输入设备码完成授权，客户端只用 `client_id` 轮询换取 token。
`client_id` 是**公开标识，不是密钥**，所以放在本地应用里完全没问题。

### 因此需要你做的唯一一件事

> **注册一个 OAuth App（一次性），拿到 Client ID。**

具体步骤见第 3 节。`Client Secret` **用不到，不要填进本系统**。

---

## 2. 凭据安全

### 2.1 落盘加密

| 环境 | 存储方式 |
|---|---|
| Windows | **DPAPI**（`ProtectedData`，CurrentUser 作用域） |
| 其它 | 降级为 `0600` 权限的明文文件，并在界面**如实标注**（不假装安全） |

DPAPI 的价值：密文与当前 Windows 账户绑定。即使 `data/secrets.json` 被拷走、
进了网盘同步、或出现在截图里，**换台机器或换个账户都解不开**。

实测开销约 **814ms／次**（PowerShell 启动成本），因此：

> 解密结果**在进程内缓存**，绝不每次请求都解密。

若 DPAPI 在某些环境下不可用，可用 `GM_VAULT_MODE=plain` 强制降级。

### 2.2 明文 token 的暴露面

| 位置 | 是否出现明文 token |
|---|---|
| 磁盘（`data/secrets.json`） | 否（DPAPI 密文） |
| 返回给前端的所有接口 | **否**，前端只拿得到 `connected / login / scopes` |
| 操作日志 | **否** |
| 命令行参数 | **否** |
| `git clone` 产生的 `.git/config` | **否**（见 5.3） |

### 2.3 一个必须诚实说明的限制

Device Flow 拿到的 token **无法由本系统程序化吊销**。
GitHub 的吊销接口要求以 `client_id` + `client_secret` 做 Basic 认证，
而 Device Flow 的设计前提就是客户端不持有 secret。

所以「退出登录」只能做到：**删除本地副本**。
要彻底撤销授权，需要你自己去
[github.com/settings/applications](https://github.com/settings/applications)
点一下。界面会在退出时给出这个链接。

---

## 3. 注册 OAuth App（一次性，约 2 分钟）

1. 打开 **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   （直达：<https://github.com/settings/applications/new>）

2. 填写：

   | 字段 | 填什么 |
   |---|---|
   | Application name | 随意，例如 `git-manager 本地版` |
   | Homepage URL | `http://127.0.0.1:4599` |
   | Authorization callback URL | **必填**，填 `http://127.0.0.1:4599`（**设备码流程会忽略它**） |

   > **这是最常见的卡点。** 该字段**留空会直接报 `Callback URL can't be blank`**，无法完成注册；
   > 但 GitHub 官方文档写明，使用设备码流程时此字段**会被忽略**：
   > *"If your app uses device flow instead of web application flow to generate a user access token, this field will be ignored."*
   > 所以填一个合法地址即可，它不会被访问。
   >
   > 关于为什么填 `127.0.0.1` 而不是 `localhost`：OAuth RFC 建议本地回环地址使用字面量
   > `127.0.0.1`（或 IPv6 `::1`）而非 `localhost`，以避免 hosts 解析差异。GitHub 对
   > `http://127.0.0.1` 这类环回地址明确放行（非本地地址才强制 HTTPS）。

3. **保存后，进入该 App 的设置页，勾选 `Enable Device Flow`。**
   这是最容易漏的一步 —— 不勾选的话，授权会直接以
   `device_flow_disabled` 失败。

4. 复制页面上的 **Client ID**（形如 `Iv1a2b3c4d5e6f7g8`），填进本系统的输入框。

> ⚠️ 同页那个 `Client Secret` 不要动、也不要填进来。

---

## 4. 授权流程

```
前端                本系统服务端                     GitHub
 │                       │                            │
 │ POST /gh/device/start │                            │
 │──────────────────────>│ POST github.com/login/device/code
 │                       │───────────────────────────>│
 │                       │<─── device_code, user_code, interval, expires_in
 │<── user_code + 验证地址 │                            │
 │   （device_code 留在服务端，不下发）                   │
 │                       │                            │
 │  用户在浏览器打开验证页、输入设备码、点确认              │
 │                       │                            │
 │ GET /gh/device/:id    │ POST github.com/login/oauth/access_token
 │──────────────────────>│───────────────────────────>│
 │<── pending / slow_down │<── authorization_pending    │
 │   （每 interval 秒一次） │                            │
 │                       │<── access_token ────────────│
 │                       │  校验身份 → 加密落盘          │
 │<── status: ok + 身份   │                            │
```

### 实现要点

- **`device_code` 永不下发前端**，只保留在服务端会话里。
- **轮询频率闸门**：服务端按 `interval` 限流。
  会话创建时即把 `lastPollAt` 置为「刚刚」，**首次轮询同样受约束**
  （RFC 8628 要求如此；初值为 0 会让第一次绕过闸门）。
- **`slow_down` 退避**：GitHub 要求时，间隔自动 `+5s`。
- **先验身份再落盘**：拿到 token 后先调 `/user` 确认可用，避免存下一个无效 token。
- 已覆盖的错误分支：`authorization_pending` / `slow_down` / `expired_token` /
  `access_denied` / `incorrect_client_credentials` / `device_flow_disabled`，
  全部映射为中文可读提示。

---

## 5. 能力与安全边界

### 5.1 读取（只读）

- 列出我的仓库（支持公私有过滤、排序、搜索）
- 单个仓库详情：可见性 / Star / Fork / 体积 / 最后推送 / 分支 / 最近提交
- 文件树浏览（Contents API，逐层按需加载）
- 单文件内容读取（自动识别二进制并拒绝在线编辑）
- 限流配额查询

### 5.2 提交（写，五重验证）

通过 **Contents API** 直接向 GitHub 创建／更新文件，产生一个远端提交。
**不需要本地 push 权限，也不需要配置 git 凭据。**

| # | 验证 | 作用 |
|---|---|---|
| 1 | **sha 乐观锁** | 用户看到的版本必须仍是远端当前版本，防止覆盖他人的并发提交 |
| 2 | **提交信息校验** | 非空且不少于 3 字符 |
| 3 | **体积上限** | 单文件 1MB，避免把仓库当网盘 |
| 4 | **二次确认** | 必须手动输入仓库名才能点提交按钮 |
| 5 | **审计日志** | 每次写入记入 `data/store.json`，界面可查 |

第 1 条最关键。它防的是这种情况：

> 你打开了一个文件，与此同时另一个人（或另一个 AI）也改了它。
> 你提交时如果无脑覆盖，对方的改动就没了。

实现上先做**显式前置比对**（给出清楚的「你看到的是 `abc1234`，远端现在是 `def5678`」），
GitHub 侧本身也会校验 sha，属于双重保护。

**内容与远端完全一致时不产生空提交**，直接返回 no-op。

### 5.3 本地仓库的提交与推送（新增）

前两条路都只处理「GitHub 上的单个文件」。**本地整个仓库怎么推上去**，此前完全没有入口，
用户只能回去跑命令行 —— 这正是被反馈「找不到哪里可以提交文件」的根因。

新增 `server/core/publish.js`，一次完成 `add → commit → remote → push`：

```
状态检查 → 选目标（新建空仓库 / 已有仓库）→ 勾选要提交的改动 → 提交信息
        → 输入仓库名二次确认 → 打快照 refs/gm/prepush/* → add → commit → remote → push → 审计日志
```

**为什么必须给 `git push` 开一个口子，以及怎么开得足够窄。**

`push` 原本在 `git.js` 的 `FORBIDDEN_SUBCMDS` 里整条熔断。直接放开等于拆掉引擎白名单的护城河。
做法是：把 `push` / `remote` / `fetch` 从通用 flag 黑名单里**摘出来单独校验**，
把参数形态固定到无法表达危险操作

| 子命令 | 唯一允许的形态 | 因此结构上不可能出现 |
|---|---|---|
| `push` | `git push [-u\|--set-upstream] origin <单一分支名>` | `--force` / `-f` / `+refspec` / `--mirror` / `--all` / `--tags` / `--delete` / `--prune` / 通配 refspec |
| `remote` | `remote` / `remote -v` / `remote get-url origin` / `remote add\|set-url origin <url>` | `remote remove` / `rename` / 操作非 origin 的远端 |
| `fetch` | `git fetch origin [branch]` | 非 origin、多余参数 |

因为 refspec 被限制为**单个分支名**（正则不允许 `+`、`:`、`*`），强制推送与批量推送
不是「被拦下」，而是**根本没有语法可以写出来**。这比逐一枚举黑名单更可靠。

其余约束：

- 远端地址必须是 `https://github.com/owner/name(.git)`。`..` 在**原始字符串**上校验 ——
  WHATWG URL 解析器会先把 `../` 归一化掉，事后查 `pathname` 是查不到的
  （`https://github.com/../../etc/passwd` 会被解析成 `/etc/passwd`）。
- 二次确认串（必须手打仓库名）校验放在**任何网络调用之前**：确认错了不该先去打一通 API。
- 新建远端仓库时 `auto_init: false`。若生成初始 README，远端就有了本地没有的提交，
  push 必然因 non-fast-forward 被拒 —— 这是这类工具最常见的坑。
- 提交前把当前 HEAD 记到 `refs/gm/prepush/<branch>-<ts>`，独立命名空间，不污染 branch 列表。
- 仓库没配 `user.email` 时，用已连接的 GitHub 账号代署名；走 `GIT_AUTHOR_*` 环境变量，
  **不写任何配置文件**。已配过身份则原样尊重，不覆盖。
- 凭据复用 `clone.js` 的 `authGitEnv()`（`GIT_CONFIG_COUNT` 注入），
  保证 base64 只在一处生成，少一处就少一个泄漏面。

### 5.4 克隆（写磁盘，只读远端）

`git clone` 会**新增一个攻击面**，因此在引擎层做了结构性限制：

**URL 白名单**

只放行 `github.com` 的 https / ssh 形态，以及 `owner/name` 简写。拒绝：

- `ext::` —— git 的 ext 传输协议**可以直接执行任意命令**
- `file://` / `ssh://` 指向其它主机
- 其它域名（含 `gist.github.com`）
- 地址中出现 `..` 路径片段

> 注意：`..` 必须在**原始字符串**上检查。
> WHATWG URL 解析器会在你看到之前就把 `https://github.com/../../etc/passwd`
> 规范化成 `/etc/passwd`，只在 `pathname` 上查是查不到的。

**危险 flag 熔断**（在 `git.js` 白名单层）

| flag | 危害 |
|---|---|
| `--upload-pack` | 指定任意可执行文件 → 远程代码执行 |
| `--template` | 向新仓库注入任意文件 |
| `--separate-git-dir` | 把 `.git` 写到仓库外任意位置 |
| `--recurse-submodules` | 子模块 URL 未经校验，等于开后门 |
| `--reference` | 引用本地路径，可越界读取 |
| `--mirror` / `--bare` / `-c` | 语义易失控 / 分析器无法工作 / 绕道写配置 |

**目标目录校验**

必须满足：父目录存在且是目录；目标目录**不存在，或存在但为空**。
目录名单独校验（禁止路径分隔符与 `..`），并做最终路径包含性检查。

**非空目录一律拒绝**，不会覆盖任何已有内容。

**凭据不落盘**（关键）

绝不把 token 拼进 clone URL —— 那会被 git 写进 `.git/config`，
永久留在磁盘上，还可能被后续 `git remote -v` 打印出来。

改用环境变量注入一次性配置：

```js
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=http.extraheader
GIT_CONFIG_VALUE_0=Authorization: Basic <base64(x-access-token:TOKEN)>
```

进程结束即消失，`.git/config` 里干干净净（已实测验证）。
同时注入 `http.lowSpeedLimit` / `http.lowSpeedTime`，
连接被静默丢弃时能在 30 秒内快速失败，而不是干等到超时。

**克隆前先做存在性预探测**

`git clone` 一个不存在的仓库时，git 要在传输层跟 GitHub 协商鉴权，
**实测要 9 秒以上**才失败（网络差时更久），用户会以为卡死。
改用 `api.github.com` 先探一下只要 **0.3 秒**，且能给出精确原因。

> 但有一个必须小心的点：**「问不出来」不能当成「不存在」**。
> 匿名 API 配额只有 60 次/小时，很容易用尽，此时返回 403 而非 404。
> 若把 403 误判为「仓库不存在」，就会**误拦用户的正常克隆**。
> 因此只在**确认 404** 时才拦截；配额用尽等一切不确定情况一律放行，交给 git 自己去试。

### 5.5 scope 设计

| 预设 | scope | 用途 |
|---|---|---|
| 只读授权 | `read:user public_repo read:org` | 只看不写，适合先试水 |
| 读写授权 | `read:user repo read:org` | 提交功能必需 |

**必须如实说明的取舍**：OAuth 的 `repo` 权限是**全有或全无** ——
它能读写你**所有**私有仓库。

如果你只想授权给某几个仓库，**fine-grained PAT 反而更安全**：
可以在 GitHub 上把权限精确限制为「指定仓库 + Contents 读写」。
因此本系统**同时保留 PAT 通道**，并把取舍写在界面上，由你决定，而不是替你决定。

---

## 6. 网络自检：为什么需要它

GitHub 的**域名是分开的**：

| 域名 | 用途 |
|---|---|
| `api.github.com` | 读取仓库、提交文件 |
| `github.com` | **OAuth 授权**、**git clone / fetch** |
| `codeload.github.com` | 归档下载 |

部分网络（企业代理、CI 沙箱）**只放行 `api.github.com`**。
这种情况下「读取 / 提交」照常可用，但「授权」与「克隆」会失败，
而用户看到的只是一个超时 —— 非常难排查。

因此系统提供 `GET /api/net/probe`，在 GitHub 视图顶部按需显示结论。

### 踩过的坑：不能用 TCP 握手判断可用性

最初的自检只做 DNS + TCP 连接，结果**给出了完全错误的"一切正常"**。

原因：透明代理/中间拦截器会**先完成 TCP 三次握手、再黑洞掉后续数据**。
于是 `net.connect` 秒回成功（11ms），而真正的 HTTPS 请求超时。

> **教训：TCP 可达 ≠ 可用。**
> 唯一可靠的判据是「真的发出一个 HTTPS 请求并拿到响应」。

现在的探测以 **HTTPS 请求结果**为判据，TCP 仅作诊断；
当出现「TCP 通但 HTTPS 不通」时，会明确提示这是透明代理拦截的典型特征。

---

## 7. 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/net/probe` | 网络自检（DNS + HTTPS） |
| GET | `/api/gh/status` | 授权状态 + 凭据仓库信息（不含明文） |
| POST | `/api/gh/client-id` | 保存 client_id |
| DELETE | `/api/gh/client-id` | 清除 client_id（不动已授权的 token） |
| POST | `/api/gh/device/start` | 申请设备码 |
| GET | `/api/gh/device/:id` | 轮询授权状态 |
| POST | `/api/gh/device/:id/cancel` | 取消授权会话 |
| POST | `/api/gh/pat` | PAT 备选通道（会先验证再落盘） |
| POST | `/api/gh/logout` | 退出（删本地副本 + 给出吊销入口） |
| GET | `/api/gh/rate` | 查询配额 |
| GET | `/api/gh/repos` | 列出我的仓库 |
| GET | `/api/gh/repo` | 仓库详情 + 分支 + 最近提交 |
| GET | `/api/gh/contents` | 文件树 / 文件内容 |
| POST | `/api/gh/preview` | **提交前预演（只读）**，返回乐观锁所需的 sha |
| POST | `/api/gh/commit` | 提交文件（需 `confirm` == 仓库名） |
| POST | `/api/gh/delete` | 删除文件（需 sha + `confirm`） |
| GET | `/api/gh/log` | 远端写操作审计日志 |
| POST | `/api/gh/parse` | 解析仓库地址（不产生任何副作用） |
| POST | `/api/gh/clone` | 克隆到本地 |
| POST | `/api/gh/create-repo` | 新建**空仓库**（`auto_init: false`，否则推送会因历史分叉被拒） |
| GET | `/api/gh/avatar` | 头像代理 `?login=` / `?u=`；主机白名单防 SSRF。因 `<img>` 带不了请求头，仅此路由额外接受 `?t=<token>` |
| GET | `/api/repos/:id/publish-status` | 本地仓库发布状态（分支 / 改动清单 / origin / 领先落后 / 提交身份） |
| POST | `/api/repos/:id/publish` | 本地仓库提交并推送（需 `confirm` == 仓库名，且校验先于网络调用） |
| POST | `/api/fs/pick-file` | 原生文件选择器；`withContent` 时在选中瞬间读回内容 |

---

## 8. 验证记录

见 `scripts/` 下的测试脚本，全部为可重复执行的自动化验证：

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `check-oauth.mjs` | Device Flow 状态机（含 pending/slow_down/expired/denied/各错误码、device_code 不外泄、轮询闸门） | **48 项通过** |
| `check-github-guard.mjs` |克隆 URL 白名单、路径越界、目标目录、sha 乐观锁、删除校验、体积上限 | **51 项通过** |
| `check-clone-e2e.mjs` | **真实访问 github.com** 的克隆端到端 | **14 项通过** |
| `check-ui.mjs` | 前端视图渲染（含脏值检查）+ 本地仓库各视图回归 | **43 项通过** |
| `check-dpapi.mjs` | DPAPI 加解密往返（含中文与特殊字符） | 通过 |
| `check-net.mjs` | 各 GitHub 域名可达性诊断 | 诊断工具 |
| `check-dialog.mjs` / `check-scan.mjs` | 原生选择器与只读扫描器（既有） | 通过 |

### 仍未验证的部分

- **真实的端到端 OAuth 授权**：需要你注册 OAuth App 并提供 Client ID 才能跑通，
  目前状态机已用受控替身完整验证，但**尚未对真实 GitHub 授权服务器完成一次全流程**。
- **视觉布局**：本环境无法截图，界面排版需你肉眼确认。

---

## 9. 桌面端迁移

沿用既有三层契约，迁移时只需改动 `web/js/api.js`：

| 模块 | 迁移动作 |
|---|---|
| `core/auth.js`、`core/github.js`、`core/clone.js` | **原样复用**，不含任何传输层代码 |
| `core/secrets.js` | 换成系统钥匙串（Keychain / Credential Manager / libsecret） |
| `api.js` 的 gh 路由 | 换成 IPC handler |
| `web/js/api.js` | 把 `request()` 换成 `invoke()` |

注意：桌面端可以把 `client_id` 内置（它是公开值），
届时用户连第 3 节的注册步骤都可以省掉。
