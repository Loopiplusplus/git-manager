# git-manager

> 本地 Git 仓库的**可视化体检与维护中枢**，专为 vibe coding 项目设计。  
> 苹果风 · 深色 · 极简 · 零依赖 · 只读优先 · 可接 GitHub。

**目录**：[快速开始](#快速开始) · [它解决什么](#它解决什么) · [已实现](#已实现) · [连接 GitHub](#连接-github两条通道) · [安全模型](#安全模型重要) · [分支策略](#分支策略) · [目录结构](#目录结构) · [API 一览](#api-一览) · [只读承诺](#只读承诺) · [验证](#验证) · [桌面版](#桌面版) · [文档](#文档) · [已知限制](#已知限制)

---

## 快速开始

**环境要求**：Node ≥ 18 + 系统里已装 `git`。跑起来**零依赖**——不需要 `npm install`。

### 方式一：Web 版（最快）

```bash
node server/index.js
# 打开 http://127.0.0.1:4599
```

- 指定端口：`node server/index.js --port 5000`
- 自动分配空闲端口：`node server/index.js --port 0`
- 服务只绑定 `127.0.0.1`，不对外暴露

### 方式二：桌面版（Electron 壳，双击即用）

```bash
npm install          # 只装 Electron 开发依赖；运行时依旧零依赖
npm run desktop      # 开发态直接启动
npm run dist         # 打包出安装程序 + 免安装版 → dist-desktop/
```

桌面版本质是**同一套代码**：主进程用 Electron 二进制以纯 Node 方式拉起同一个本地服务，
窗口加载 `127.0.0.1:<随机端口>`。所以 `server/` 与 `web/` 一行都没为它改过 —— 详见 [`docs/03`](docs/03-迁移契约与桌面端.md)。

> 安装包是**本地构建产物**，不在仓库里（`dist-desktop/` 已 gitignore）。想用桌面版就自己跑一次 `npm run dist`。

### 数据落在哪

| 场景 | 目录 |
|---|---|
| Web 版 / 开发态桌面版 | 项目下的 `data/` |
| 打包后的桌面版 | 系统的 `userData` 目录（绝不写安装目录） |
| 任意场景覆盖 | 环境变量 `GM_DATA_DIR=/some/path` |

里面存的是仓库列表、操作日志、加密凭据 —— 全部**只在本机**，已在 `.gitignore` 里排除。

---

## 它解决什么

vibe coding 的项目往往**能跑但难维护**：临时分支堆积、WIP 提交、stash 越攒越多、不知道 AI 在哪儿动过手、远端仓库和本地对不上。git-manager 把这些问题变成一眼能看懂的画面：

| 页面         | 回答的问题                                               |
| ---------- | --------------------------------------------------- |
| **概览**     | 这个仓库现在健康吗？提交节奏如何？                                   |
| **提交记录**   | AI 参与了哪些提交？（多信号推断，每条给依据）                            |
| **分支与引用**  | 哪些分支该清理？能安全地切过去、新建一个、或者删掉吗？                          |
| **操作日志**   | 我（或 AI）对它做过什么？能撤销吗？                                 |
| **GitHub** | 远端有哪些仓库？能不改文件就读到内容吗？**能把本地仓库提交并推上去吗？** 能安全地改一行并提交吗？ |

---

## 已实现

### 一、仓库接入（全部只读）

- **原生文件夹选择器**：点按钮直接弹 Windows 对话框选目录，不用手输路径
- **自动识别**：选中后立刻判断「是否已初始化 Git」/「是否位于某个仓库内部」/「有没有子仓库」，并给出对应动作
- **磁盘扫描**：选一个盘或任意目录，只读遍历找出其中所有 Git 仓库；深度可调、可随时取消、实时显示进度

### 二、本地只读分析（默认，不改动任何东西）

- 仓库概览：提交总数、分支数、体积、贡献者、时间跨度
- 健康度评分（0–100）+ 可执行的问题清单
- 12 周提交热力图
- **AI 协作痕迹**（多信号推断，可解释、纯本地、不读文件内容）
- 半成品提交（WIP）占比
- 分支风险徽章：当前 / 领先 N / 落后 N / 未合并 / stale N 天 / 被工作树占用
- **分支的增删与恢复**：界面直接新建分支、删除分支（正检出/唯一分支/被工作树占用会被拦下），删除前会展示影响范围；删掉的尖端存进 `refs/gm/deleted/*`，可在「可恢复的删除点」里一键找回

#### AI 协作痕迹怎么判的

> 这一项最初只是「扫关键词」，结果一个**完全由 AI 写的仓库**会被判成 0% —— 等于摆设。现已重写为**多信号推断**，并对每条判定给出可见依据。

它只读 **git 元数据**（提交信息、作者、时间、改动行数）与**文件路径名**，**不读文件内容、不联网、不上传**。据此分三类证据打分：

| 证据类型            | 举例                                                            | 说明       |
| --------------- | ------------------------------------------------------------- | -------- |
| **显式证据**（单条即定性） | `Co-Authored-By: Claude`、`🤖 Generated with ...`、机器人作者、AI 作者名 | 命中即「高置信」 |
| **形态证据**        | 正文结构化成文（标题+列表）、长正文、装饰字符、Conventional 前缀、超长标题                  | 人类也可能这样写 |
| **过程证据**        | 与相邻提交间隔极短、单次改动量远超该仓库常态                                        | 依赖同仓库基线  |

**关键诚实约定：**

- **只有形态/过程证据时，等级上限是「疑似」，永远不会自动升级成「高置信」** —— 因为严谨的人类开发者同样会写出规范提交。
- 同一仓库内**样本不足 3 条时不做过程推断**，避免拿噪声当规律。
- 界面明确标注「**推断 · 非事实判定**」，并提示：**没检出痕迹 ≠ 没有 AI 参与**。本仓库实测就有 2 条空正文提交无法追踪，面板会据此提示「实际参与度很可能高于估算」。
- 会额外识别 **AI 工具痕迹文件**（如 `.workbuddy/`、`CLAUDE.md`、`.cursorrules`、`AGENTS.md`），作为佐证一并列出。

本仓库自测：7 条提交 → 判定 5 条，占比 **71.4%**，依据逐条可见（极短间隔×7、Conventional 前缀×7、结构化正文×5 …）。验证脚本：`node scripts/check-ai-signals.mjs`（52 项）。

### 三、本地受控写操作（唯一会改动本地仓库的路径）

- ⌘K 可视化分支切换
- 切换前强制 Preflight 检查
- 工作区脏时自动快照，切换后工作区干净
- 一键撤销，改动完整恢复
- **新建分支 / 删除分支 / 恢复已删除的分支**（删除前展示影响范围，删掉的尖端进 `refs/gm/deleted/*` 回收站）
- 全部操作进日志

### 四、GitHub 集成（Web 版新增）

**读（只读）**

- 账号身份条：头像、登录名、公开仓库数、当前 API 配额（含重置倒计时）
  - 头像走**本机代理**（`/api/gh/avatar`）：页面 CSP 是 `img-src 'self'`，外域头像会被直接拦掉；而且浏览器直连 `avatars.githubusercontent.com` 在国内也常年失败。由服务端代取后回传，失败则回退到字形。
- 仓库列表：搜索、公/私有过滤、按更新时间/星标/名称排序、分页
- 单仓库详情：默认分支、语言、体积、最后推送时间
- 文件树浏览 + 分支切换：目录逐层展开、文件内容只读预览、二进制文件自动识别并拒渲染

**把本地仓库提交并推送（新增）**

- 本地仓库视图顶栏与概览页都有「提交并推送」入口 —— 之前根本没有这个能力，用户只能跑命令行
- 向导：状态检查 → 选目标（**新建 GitHub 仓库** 或 **推送到已有仓库**）→ 勾选要一并提交的改动 → 提交信息 → **输入仓库名二次确认** → 执行
- 一次完成：`git add` → `git commit` → `remote add/set-url origin` → `git push -u origin <branch>`
- 新建仓库时**不生成初始 README**，否则远端先有一个本地没有的提交，推送会因历史分叉被拒
- 提交前自动打一个 `refs/gm/prepush/*` 快照，随时可回退
- 仓库没配 git 提交身份时，用已连接的 GitHub 账号代署名（只写环境变量，不改任何配置文件）

**写（需二次确认 + 乐观锁）**

- 在线编辑任意文本文件（上限 1 MB），提交前先 dry-run 预演
- 文件列表里每个文件行都有显式「编辑」按钮；右上角有「上传本地文件…」与「新建文件…」  
  —— 上传时由服务端在用户刚选完文件的瞬间读回内容（刻意不做成「给路径就读」的通用接口）
- 提交前必须输入**仓库名**作为确认语（服务端校验 `confirm !== name` 即拒绝）
- sha 乐观锁：预演时锁定远端 sha，提交时若不匹配则拒绝，防止覆盖别人的并发提交
- 支持删除文件（同样走预演 + 确认 + 乐观锁）
- 所有远端写操作落审计日志，可在 GitHub 页查看

**克隆**

- 粘贴任意 GitHub 地址（HTTPS / `git@` / `owner/repo` 短写均可）→ 先解析预览 → 再执行
- 可选目录层级、可选浅克隆深度、可选目标父目录（原生选择器）
- 克隆完成后**自动接入**本系统并独立复核，重复克隆会被拦下
- 地址白名单：只允许 `github.com`；`..` 路径穿越、非白名单主机一律拒绝

**网络自检**

- 一键探测 `api.github.com` / `github.com` / `codeload.github.com` 的 DNS 与 HTTPS 连通性
- 以**真实 HTTPS 请求**为唯一判据（透明代理会假握手，只测 TCP 会误报"正常"）
- 检测到代理环境时给出说明，而不是笼统报"离线"

---

## 连接 GitHub（两条通道）

### 通道 A：OAuth 第三方授权（推荐，无需密钥）

采用 **OAuth 2.0 Device Flow（设备码流程）**，这是 GitHub 官方为 CLI / 桌面应用设计的流程。

> **关键结论：只需要 `client_id`，不需要 `client_secret`。**

因为 Device Flow 由 GitHub 直接发放短时效设备码，用户在浏览器里输码授权，客户端只用公开的 `client_id` 轮询换 token。`client_id` 是**公开标识**而非密钥，放在本地应用里没有任何问题。

反过来，**回调式 OAuth 被明确排除**：换取 token 时 GitHub 要求携带 `client_secret`，而本地应用无法安全保存 secret，任何"硬编码"都等于公开泄露。

**你需要做的一次性事情（约 2 分钟）：**

1. 打开 <https://github.com/settings/applications/new>
2. `Application name` 随便填（如 `git-manager-local`）
3. `Homepage URL` 填 `http://127.0.0.1:4599`
4. `Authorization callback URL` **也填 `http://127.0.0.1:4599`** —— ⚠️ **这个字段必填，留空会报 `Callback URL can't be blank`**；但设备码流程**根本不会用到它**，随便填个合法地址即可，GitHub 明确允许 `http://127.0.0.1` 这类环回地址
5. **勾选 `Enable Device Flow`** ← 这一步必须有，否则授权会直接失败
6. 点注册，复制生成的 **Client ID**，粘贴进本系统 GitHub 页的输入框并保存
7. 点「使用 GitHub 授权」→ 页面显示设备码 → 点「打开验证页」→ 在 GitHub 页面输入设备码 → 确认

> 关于第 4 步：GitHub 官方文档写明，使用设备码流程时回调地址**会被忽略**（"If your app uses device flow ... this field will be ignored"）；但注册表单仍强制要求填写。这是最常见的一个卡点，不是配置错误。

**权限范围（scope）三档可选：**

| 档位 | scope                            | 说明                |
| -- | -------------------------------- | ----------------- |
| 只读 | `read:user public_repo read:org` | 只能读公开仓库，不会拿到任何写权限 |
| 读写 | `read:user repo read:org`        | 可读写私有仓库（含提交文件）    |

> 授权后如果你想撤销：<https://github.com/settings/applications>（页面上会给出这个链接）。

### 通道 B：Personal Access Token（备选）

不想注册 OAuth App？直接用 PAT 也行，且**细粒度 PAT 的权限比 OAuth 的 `repo` scope 更精确**（可以只给某一个仓库的 Contents 读写权限）。在 GitHub 页展开「使用令牌（PAT）」填入即可。

### 凭据怎么存的

| 环境          | 存储方式                                                 |
| ----------- | ---------------------------------------------------- |
| Windows     | **DPAPI 加密**（`ProtectedData`，`CurrentUser` 作用域），密文落盘 |
| 其他平台 / 显式降级 | 明文存储，但**页面上会明确标注安全等级**，不假装安全                         |

- DPAPI 密钥绑定当前 Windows 账户，**别的账户或别的机器拿到文件也解不开**
- 解密结果进程内缓存（DPAPI 单次开销约 800 ms，不缓存会拖垮每次请求）
- 凭据**永远不回传前端**：`/api/gh/status` 只返回 `hasToken: true/false` 与权限档位，不返回明文
- 克隆时的 token **不落盘到 `.git/config`**，而是通过 `GIT_CONFIG_COUNT` 环境变量注入，进程结束即消失

详见 [`docs/04-GitHub集成与OAuth授权.md`](docs/04-GitHub集成与OAuth授权.md)。

---

## 安全模型（重要）

### 本地写操作

分支切换是 L1「可回滚写」；**只要工作区有未提交内容，就按 L2 破坏性写流程处理**。

```
选择分支 → Preflight 检查 → 脏则自动快照 → git switch（禁 force）→ 校验并记日志
```

- 一律使用 `git switch`，**永不 `git checkout`**，**永不 `--force`**
- 禁止清单写在**引擎层**（`server/core/git.js` 的命令白名单），不写在 UI 层
- 未提交内容一律进快照，**永不静默丢弃**（所以 UI 上根本没有「放弃改动」这个选项）
- 快照存于 `refs/gm/snapshots/*`，不污染你的 `git stash list`

### 分支的新建与删除

新建分支是 **L1**（只是多一个指针，不覆盖任何文件）；删除是 **L2**。

```bash
# 新建：branch <name> [<起点>]
# 删除：branch -d <name>（git 自己会拒绝未合并分支） 或 branch -D <name>（强制）
# 删前把尖端存进 refs/gm/deleted/<name>-<ts> —— 这就是回收站
```

- **`-d` 与 `-D` 的区别交给 git 自己挡**，我们**不自己实现合并判断**去替代它（自己算会与 git 的 upstream 语义不一致而误拦）。所以「有未合并提交」不是阻塞项，只是一条要提醒你的事实
- **强制删除必须把分支名原样再输一遍**（`confirm === name`），而且这个校验**发生在任何 git 调用之前** —— 确认错了，仓库一个字节都不会动
- 删除失败（比如 `-d` 被 git 拒绝）时会**清掉刚建的回滚点**，避免候选列表里留下一个「名字还在的幽灵删除点」
- 恢复分支 = `git branch <name> <refs/gm/deleted/…>`，不改变任何文件
- 正检出的分支、仓库里唯一的本地分支、被其它工作树占用的分支，**都删不掉**（git 本身也不允许，我们提前讲清楚）

### 本地提交并推送（唯一会改本地提交历史的路径）

```
状态检查 → 选目标 → 输入仓库名二次确认 → 打快照 refs/gm/prepush/* → add → commit → remote → push → 记审计日志
```

`git push` 此前是整条熔断的。现在以**窄化白名单**方式开放，参数形态完全固定：

| 子命令      | 允许的形态                                                                                    | 结构性排除                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `push`   | `git push [-u\|--set-upstream] origin <单一分支名>`                                           | `--force` / `-f` / `+refspec` / `--mirror` / `--all` / `--tags` / `--delete` / `--prune` / 通配 refspec —— 因为 refspec 只允许单个分支名，这些形态**根本无法表达** |
| `remote` | `remote`（列表）/ `remote -v` / `remote get-url origin` / `remote add\|set-url origin <url>` | `remote remove` / `rename` / 操作 origin 以外的远端名                                                                                               |
| `fetch`  | `git fetch origin [branch]`                                                              | 非 origin、多余参数                                                                                                                               |
| `branch` | `branch` / `branch <只读flag…>` / `branch <name> [<起点>]` / `branch -d\|-D <name>`            | `-m`（改名）/ `-f` / `--force` 拼接                                                                                                                |
| `update-ref` | `update-ref <refs/gm/…> <sha\|HEAD>` / `update-ref -d <refs/gm/…>`                     | 越出 `refs/gm/**` 一律拒绝 —— `update-ref -d refs/heads/main` 这种「用底层命令删掉用户分支」的写法**根本写不出来**                                                      |

- 远端地址必须是 `https://github.com/owner/name(.git)`；`..` 在**原始字符串**上校验（URL 解析器会先把它归一化掉，事后查 `pathname` 查不到），`http` / ssh / 非 github 主机一律拒绝
- `git gc` / `clean` / `reset` / `checkout` / `rebase` / `merge` **仍然整条熔断**
- 二次确认串校验发生在**任何网络调用之前** —— 确认错了不会先去打一通 GitHub API
- 凭据仍走 `GIT_CONFIG_COUNT` 环境注入，**不写进 `.git/config`、不进命令行**

### 远端写操作

```
编辑 → dry-run 预演（拿 sha）→ 展示 diff → 输入仓库名确认 → 提交（校验 sha）→ 记审计日志
```

- 提交走 **GitHub Contents API**，不依赖本地 push 权限，也不需要配置 git 凭据
- 任何一步缺省都会被服务端拒绝（`confirm` 不对 → 400；`sha` 过期 → 冲突报错）
- 服务端**不信任前端**：确认、sha、路径合法性（禁绝对路径 / 禁 `..`）全部在服务端复核

### 克隆

- 主机白名单只放 `github.com`，其余一律拒绝
- 在**原始字符串**上检查 `..`（WHATWG URL 解析器会先把 `..` 归一化掉，事后查 `pathname` 查不到）
- git 引擎层为 `clone` 单独加了 11 条危险 flag 熔断：`--upload-pack` / `--template` / `--separate-git-dir` / `--mirror` / `--bare` / `--config` / `--reference` / `--recurse-submodules` / `--remote-submodules` / `-c` 等
- 克隆前先做一次 `probeRepo` 快速探测，但**只有明确 404 才算"不存在"**；配额耗尽等"问不出来"的情况一律放行，绝不误拦

详见 [`docs/02-分支切换与安全模型.md`](docs/02-分支切换与安全模型.md)。

---

## 分支策略

本仓库自己就是第一个用户，分支约定如下：

| 分支 / 标签              | 作用                                  | 状态              |
| -------------------- | ----------------------------------- | --------------- |
| `main`               | 主线，持续演进                             | 活跃              |
| `pure-web`           | **纯 Web 版**归档分支，只保留不依赖 Node 后端的静态实现 | 🔒 **已封存**，不再开发 |
| `seal/pure-web-v0.1` | 封存点的标注 tag                          | 指向封存基线          |

**约定**：新功能一律先落在 `main`（Web 版），验证通过后再同步到 `pure-web`；`pure-web` 只接受同步，不接受独立开发。

---

## 目录结构

```
server/                    本地服务（纯 Node，零依赖）
  index.js                 HTTP 入口：本机令牌鉴权 + 静态托管
  api.js                   路由 → 参数解析（不含业务逻辑）
  core/
    git.js                 ★ git 引擎：命令白名单 + 危险 flag 熔断 + 窄化校验（push/remote/fetch/branch/update-ref）
    repo.js                仓库中途接入（零侵入探测）
    analyzer.js            分析器：概览/分支/提交/热力图/健康度
    ai-signals.js          ★ AI 协作痕迹检测器（多信号 + 可解释 + 纯本地）
    safety.js              安全模块：Preflight / 快照式切换 / 分支增删恢复 / 撤销 / 日志
    dialog.js              原生文件夹/文件选择器（PowerShell 桥）
    scanner.js             只读磁盘扫描（readdir + lstat）
    secrets.js             ★ 凭据仓库：DPAPI 加密落盘 + 进程内缓存
    auth.js                ★ OAuth Device Flow + PAT + 登出
    github.js              ★ REST 客户端 + 写操作验证层（预演/乐观锁/提交/删除）+ 建仓 + 头像代理
    publish.js             ★ 本地仓库「提交并推送」
    clone.js               ★ 克隆 + URL 白名单 + 凭据环境注入
    netcheck.js            ★ 网络自检（真实 HTTPS 为唯一判据）
    store.js               本地存储（接口可换 SQLite）
    util.js                工具函数 + 版本号单一来源
web/                       前端（纯静态，无构建步骤）
  index.html
  css/app.css              设计系统（苹果风深色）
  js/api.js                ★ 唯一传输边界 —— 桌面端只改了这一个文件里的两个方法
  js/util.js               格式化与徽章
  js/views.js              视图渲染（概览/提交/分支/日志/GitHub）
  js/palette.js            ⌘K 切换面板 + 安全切换 + 分支增删 + GitHub 各对话框
  js/main.js               状态与路由
desktop/                   桌面端壳（Electron）
  main.js                  主进程：sidecar 启动 / 窗口 / 外链接管 / 原生对话框 / 自检
  preload.cjs              唯一的桥（contextBridge）—— 不暴露 fs、不暴露任意 IPC
  build/icon.ico           应用图标（由 scripts/make-icon.mjs 生成）
scripts/                   验证脚本（node scripts/check-*.mjs，全部自包含）
  check-branch.mjs         分支增删 + 盘根扫描边界 + 接线契约
  check-desktop.mjs        桌面端冒烟测试（真的把应用跑起来）
  make-icon.mjs            程序化生成图标（无外部依赖）
docs/                      设计文档（见文末「文档」）
```

### 不在仓库里的东西

下面这些是**本机专属**的，已在 `.gitignore` 里排除，克隆下来不会有：

| 路径 | 是什么 | 为什么不入库 |
|---|---|---|
| `data/` | 仓库列表、操作日志、加密凭据 | 里面是**你自己的仓库绝对路径** |
| `.workbuddy/` | 开发过程中的工作记忆 | 记录了本机路径与本机专属的上下文 |
| `node_modules/` | 依赖 | 跑 `npm install` 即可 |
| `dist-desktop/`、`dist-*/` | 打包产物 | 跑 `npm run dist` 即可 |
| `*.log`、`.DS_Store`、`.vscode/` | 编辑器/系统垃圾 | —— |

> 换句话说：**仓库里只有项目本身的代码与文档**，跑起来后产生的数据一律落在本机、不进仓库。

---

## API 一览

所有 `/api/*` 需要请求头 `x-gm-token`（页面通过 `/gm-config.js` 自动获取）。  
服务仅绑定 `127.0.0.1`，且不发送 CORS 头，杜绝跨站读取。

### 本地仓库

| 方法     | 路径                               | 说明                                                                              |
| ------ | -------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/health`                    | 健康检查                                                                            |
| GET    | `/api/repos`                     | 已接入仓库列表                                                                         |
| POST   | `/api/repos/open`                | 接入仓库 `{ path }`                                                                 |
| DELETE | `/api/repos/:id`                 | 从列表移除（不动磁盘）                                                                     |
| GET    | `/api/repos/:id/overview`        | 总览                                                                              |
| GET    | `/api/repos/:id/branches`        | 分支列表（含风险）                                                                       |
| GET    | `/api/repos/:id/branches/removal?name=` | **删除前评估**：阻塞项、未合并提交数、尖端、远端同名分支                                                  |
| GET    | `/api/repos/:id/branches/deleted` | 可恢复的删除点（`refs/gm/deleted/*`）                                                    |
| POST   | `/api/repos/:id/branches`        | 新建分支 `{ name, from? }`                                                          |
| POST   | `/api/repos/:id/branches/delete`  | 删除分支 `{ name, force?, confirm? }`（`force=true` 时 `confirm` 必须是分支名本身）             |
| POST   | `/api/repos/:id/branches/restore` | 恢复已删除的分支 `{ name, ref }`                                                       |
| GET    | `/api/repos/:id/commits?limit=`  | 提交记录                                                                            |
| GET    | `/api/repos/:id/activity?weeks=` | 热力图数据                                                                           |
| GET    | `/api/repos/:id/health`          | 健康度报告                                                                           |
| GET    | `/api/repos/:id/log`             | 操作日志                                                                            |
| POST   | `/api/repos/:id/preflight`       | 切换前检查 `{ target }`                                                              |
| POST   | `/api/repos/:id/switch`          | 安全切换 `{ target, strategy, message }`                                            |
| POST   | `/api/repos/:id/undo`            | 撤销上一次切换                                                                         |
| GET    | `/api/repos/:id/publish-status`  | 发布状态：分支/改动清单/origin/领先落后/提交身份                                                   |
| POST   | `/api/repos/:id/publish`         | 提交并推送 `{ mode, repoName/owner+name, message, includeChanges, branch, confirm }` |

### 文件系统

| 方法   | 路径                     | 说明                                                     |
| ---- | ---------------------- | ------------------------------------------------------ |
| GET  | `/api/fs/drives`       | 可用驱动器列表 + 是否支持原生对话框                                    |
| POST | `/api/fs/pick`         | 弹出**原生文件夹选择器**，返回所选路径                                  |
| POST | `/api/fs/pick-file`    | 弹出**原生文件选择器**；`withContent` 时由服务端在选中瞬间读回内容（不做成通用读文件接口） |
| POST | `/api/fs/probe`        | 识别目录 `{ path }`：是否仓库 / 是否在仓库内 / 有无子仓库                  |
| POST | `/api/scan`            | 启动只读扫描 `{ root, maxDepth }` → `{ job }`                |
| GET  | `/api/scan/:id`        | 轮询扫描进度与结果                                              |
| POST | `/api/scan/:id/cancel` | 取消扫描                                                   |


### GitHub

| 方法     | 路径                          | 说明                                                                          |
| ------ | --------------------------- | --------------------------------------------------------------------------- |
| GET    | `/api/gh/status`            | 授权状态（**不含明文凭据**）                                                            |
| POST   | `/api/gh/client-id`         | 保存 OAuth App 的 `client_id`                                                  |
| DELETE | `/api/gh/client-id`         | 清除 `client_id`（不动已授权 token）                                                 |
| POST   | `/api/gh/device/start`      | 发起设备码授权 `{ scopeMode }`                                                     |
| GET    | `/api/gh/device/:id`        | 轮询授权状态                                                                      |
| POST   | `/api/gh/device/:id/cancel` | 取消授权                                                                        |
| POST   | `/api/gh/pat`               | 备选通道：存 PAT `{ token }`                                                      |
| POST   | `/api/gh/logout`            | 登出并清除 token                                                                 |
| GET    | `/api/gh/rate`              | 当前 API 配额                                                                   |
| GET    | `/api/gh/repos`             | 仓库列表 `?sort=&visibility=&q=&page=`                                          |
| GET    | `/api/gh/repo`              | 单仓库详情 `?owner=&name=`                                                       |
| GET    | `/api/gh/contents`          | 文件/目录内容 `?owner=&name=&path=&ref=`                                          |
| POST   | `/api/gh/preview`           | 只读预演，返回远端当前 sha（乐观锁）                                                        |
| POST   | `/api/gh/commit`            | 提交文件（需 `confirm` = 仓库名 + `sha` 匹配）                                          |
| POST   | `/api/gh/delete`            | 删除文件（同样需确认 + 乐观锁）                                                           |
| GET    | `/api/gh/log`               | 远端写操作审计日志                                                                   |
| POST   | `/api/gh/parse`             | 解析仓库地址（预览将要克隆什么）                                                            |
| POST   | `/api/gh/clone`             | 克隆 `{ url, parentDir, dirName, depth }`                                     |
| POST   | `/api/gh/create-repo`       | 在 GitHub 新建**空仓库** `{ name, private, description }`                         |
| GET    | `/api/gh/avatar`            | 头像代理 `?login=` 或 `?u=`（主机白名单，防 SSRF）；因 `<img>` 无法带请求头，仅此路由额外接受 `?t=<token>` |
| GET    | `/api/net/probe`            | 探测 GitHub 各域名的 DNS + HTTPS 连通性                                              |

`:id` 用仓库 id；若要用绝对路径，需 `encodeURIComponent` 后再放进 URL。

---

## 只读承诺

「选择文件夹」和「磁盘扫描」是本系统里唯一会大规模接触你磁盘的操作，因此被刻意设计成**结构上不可能造成破坏**：

| 承诺      | 落地方式                                                                                 |
| ------- | ------------------------------------------------------------------------------------ |
| 不写任何文件  | 扫描器只调用 `readdir` + `lstat` 两个系统调用，代码里没有任何写操作；缓存只写进本项目的 `data/` 目录                    |
| 不读文件内容  | 判断是否为仓库只看 `.git` **是否存在**，不解析其内容                                                     |
| 不跟随符号链接 | 跳过所有 symlink / 目录联接，杜绝死循环和「跑到盘外」                                                     |
| 不越界     | 每次入队都做路径包含性校验，结果严格落在所选根目录之内                                                          |
| 不会失控    | 三重硬上限：深度 ≤ 10、目录数 ≤ 40 万、时间 ≤ 5 分钟；可随时取消                                             |
| 不碰系统区域  | 默认跳过 `Windows`、`Program Files`、`AppData`、`$RECYCLE.BIN` 等，以及 `node_modules` 等重量级缓存目录 |
| 可验证     | 已实测：扫描前后被扫目录的**文件大小、修改时间、目录结构完全一致**，未新增任何文件                                          |

> 会改动仓库的路径只有四条：**本地分支切换**、**本地分支的新建/删除/恢复**、**本地提交并推送**、**GitHub 远端提交**。  
> 四者都要经过「预演/检查 → 快照/回收点/乐观锁 → 二次确认 → 审计日志」这一整套闸门。
> 前两条必须经过 Preflight + 快照（或 `refs/gm/deleted` 回收点）+ 日志；后两条必须经过预演 + 确认 + 乐观锁 + 审计日志。

---

## 验证

```bash
node scripts/check-oauth.mjs         # 设备码流程状态机（含失败分支）
node scripts/check-gh-poll.mjs       # 授权面板的轮询循环（DOM 桩 + 手动定时器驱动）
node scripts/check-github-guard.mjs  # 写操作守卫 + 路径穿越 + clone 危险 flag
node scripts/check-branch.mjs        # 分支增删：窄化白名单 + 盘根路径边界 + 真实建/删/恢复 + HTTP 路由 + 前端契约
node scripts/check-publish.mjs       # 提交并推送：push/remote 窄化熔断 + 守卫 + 真实 push 端到端
node scripts/check-clone-e2e.mjs     # 真实克隆端到端（需网络）
node scripts/check-ai-signals.mjs    # AI 协作痕迹检测器（显式/形态/过程证据 + 诚实边界）
node scripts/check-ui.mjs            # 前端模块加载与渲染函数
node scripts/check-dpapi.mjs         # 凭据仓库端到端：DPAPI 加密 / 跨进程冷启动解密 / 空值边界
node scripts/check-net.mjs           # 网络自检判据
node scripts/check-dialog.mjs        # 原生对话框桥
node scripts/check-desktop.mjs       # 桌面端：真的把 Electron 应用跑起来自检（14 项）
node scripts/check-desktop.mjs --app dist-desktop/win-unpacked   # 自检**打包产物**
```

> `check-clone-e2e.mjs` 需要可访问 `github.com`，无网络时设 `GM_TEST_NET=1` 才执行真实克隆。  
> `check-scan.mjs` 是**探索性脚本**而非自包含测试：需先自己起一个 `node server/index.js --port 4630`，并把夹具目录与真实仓库路径作为参数传入。

**为什么要有 `check-desktop.mjs`**：桌面端的失败模式几乎都看不见 —— sidecar 起来了但窗口连不上、
preload 没注入、令牌没传对、渲染层 JS 报错导致白屏。静态检查一个都发现不了，必须真的把它跑起来。
它会启动应用、逐项断言、打印结果后退出，并且**把数据指向临时目录**，不碰真实的 `data/store.json`。

---

## 桌面版

已经打包成 Windows 应用，**Web 版与桌面版共用同一套后端与前端**（`server/` 与 `web/` 一行都没改）。

### 怎么搭起来的

```
GitManager.exe（Electron 主进程 · desktop/main.js）
   │
   ├─ 用 ELECTRON_RUN_AS_NODE 把 server/index.js 拉成 sidecar 子进程
   │     └─ 端口传 --port 0，由系统分配；真实端口与令牌从 stdout 的 GM_READY 行读回
   │
   └─ 窗口加载 http://127.0.0.1:<随机端口>/
         └─ 页面照常走 HTTP + 令牌，前端零改动
```

几个刻意的选择：

| 决定 | 原因 |
|---|---|
| **sidecar 用 Electron 自带的 Node 跑**（`ELECTRON_RUN_AS_NODE=1`） | Electron 二进制本身就是 Node 运行时，不必再打一份进去，省约 40MB |
| **窗口加载 127.0.0.1 而不是 `file://`** | CSP、相对路径、fetch 全部照常工作，`web/**` 零改动；`file://` 下还得逐条放宽 CSP |
| **保留令牌机制** | 挡不住同源的注入脚本，但能挡住**其它本机进程**随意驱动 git 写操作 —— 这不因换了壳而失效 |
| **端口用 0** | 用户可能同时开着 Web 版（4599），写死端口会直接起不来 |
| **`asar: false`** | sidecar 要由 Node 从磁盘执行脚本，asar 打包后路径不可执行。代价是代码可读，对一个本地工具反而是透明性 |
| **数据放用户目录** | 安装目录可能只读，升级覆盖时会连用户数据一起抹掉 |

### 数据放哪

| 场景 | 目录 |
|---|---|
| 安装版 / 免安装版 | `%APPDATA%\GitManager\`（仓库列表、操作日志、加密凭据） |
| 开发态 `npm run desktop` | 项目里的 `data/`，与 Web 版**共用**，所以两边看到同一批仓库 |
| 自己指定 | 设环境变量 `GM_DATA_DIR` 即可覆盖（自检脚本就用它做隔离） |

菜单里「文件 → 打开数据目录」可以直接跳过去。

### 与 Web 版的两处差异

只有一处代码不同：`web/js/api.js` 里的 `pickFolder` / `pickFile` 在桌面端改走 **Electron 原生对话框**，
其余全部请求照旧走 HTTP。原生对话框返回结构与服务端的 PowerShell 版本完全一致
（`{ok, cancelled, path}`），所以上层调用方不需要知道自己在哪个宿主里。

另外桌面端会自动接管外链（OAuth 设备码地址、仓库链接等），交给系统浏览器打开。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/00-产品构想与技术方案.md`](docs/00-产品构想与技术方案.md) | 这个工具为什么长这样：问题定义、信息架构、技术选型 |
| [`docs/01-前端视觉提示词-Google图像生成.md`](docs/01-前端视觉提示词-Google图像生成.md) | 苹果风设计系统的视觉规格与生成提示词 |
| [`docs/02-分支切换与安全模型.md`](docs/02-分支切换与安全模型.md) | ★ 三级安全模型、Preflight 清单、窄化白名单、分支增删、只读扫描保证 |
| [`docs/03-迁移契约与桌面端.md`](docs/03-迁移契约与桌面端.md) | 三层边界与迁移契约：Web → 桌面为什么只改一个文件 |
| [`docs/04-GitHub集成与OAuth授权.md`](docs/04-GitHub集成与OAuth授权.md) | OAuth 设备码流程、凭据存储、写操作的三步验证、头像与 CSP |

---

## 已知限制

诚实列一下现在做不了 / 做得不完美的地方：

| 限制 | 说明 |
|---|---|
| **只写本地，不碰远端历史** | 不提供 rebase / merge / reset / cherry-pick / force push。这些一律在引擎层熔断，宁可不做 |
| **不做 GitHub 侧的分支删除 / PR** | 远端文件提交与建仓已支持；远端分支管理、PR、Issue 尚未接入 |
| **AI 痕迹是推断，不是判定** | 启发式打分，**没检出 ≠ 没有 AI 参与**。只有显式证据（如 `Co-Authored-By`）才给「高置信」 |
| **扫描会跳过系统区域** | `Windows`、`Program Files`、`AppData`、`node_modules` 等默认不进入，所以那里面的仓库扫不到 |
| **快照不会自动清理** | `refs/gm/snapshots/*`、`refs/gm/deleted/*` 会一直留着。它们是纯本地 ref，想清理用 `git update-ref -d <ref>` |
| **只测过 Windows** | 原生对话框走 PowerShell + WinForms；扫描与 DPAPI 都按 Windows 写的。macOS / Linux 未验证 |
| **前端 CSS 未做自动化验证** | 视图层是纯函数、有渲染冒烟测试，但布局只能靠人眼 |

---

## 许可

本项目为个人项目，未附许可协议。如需引用或复用请先开 Issue 说明用途。

