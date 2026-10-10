# git-manager

> 本地 Git 仓库的**可视化体检与维护中枢**，专为 vibe coding 项目设计。
> 苹果风 · 深色 · 极简 · 零依赖 · 只读优先。

---

## 快速开始

```bash
node server/index.js
# 打开 http://127.0.0.1:4599
```

无需 `npm install`（后端零依赖），Node ≥ 18，本地已安装 `git`。

指定端口：`node server/index.js --port 5000`

---

## 它解决什么

vibe coding 的项目往往**能跑但难维护**：临时分支堆积、WIP 提交、stash 越攒越多、不知道 AI 在哪儿动过手。git-manager 把这些问题变成一眼能看懂的画面：

| 页面 | 回答的问题 |
|---|---|
| **概览** | 这个仓库现在健康吗？提交节奏如何？ |
| **提交记录** | AI 参与了哪些提交？（启发式标记） |
| **分支与引用** | 哪些分支该清理？能安全地切过去吗？ |
| **操作日志** | 我（或 AI）对它做过什么？能撤销吗？ |

---

## 已实现

**仓库接入（全部只读）**
- **原生文件夹选择器**：点按钮直接弹 Windows 对话框选目录，不用手输路径
- **自动识别**：选中后立刻判断「是否已初始化 Git」/「是否位于某个仓库内部」/「有没有子仓库」，并给出对应动作
- **磁盘扫描**：选一个盘或任意目录，只读遍历找出其中所有 Git 仓库；深度可调、可随时取消、实时显示进度

**只读分析（默认，不改动任何东西）**
- 仓库概览：提交总数、分支数、体积、贡献者、时间跨度
- 健康度评分（0–100）+ 可执行的问题清单
- 12 周提交热力图
- AI 参与度估算（署名 / Co-Authored-By / 生成器指纹）
- 半成品提交（WIP）占比
- 分支风险徽章：当前 / 领先 N / 落后 N / 未合并 / stale N 天 / 被工作树占用

**受控写操作（唯一会改动仓库的路径）**
- ⌘K 可视化分支切换
- 切换前强制 Preflight 检查
- 工作区脏时自动快照，切换后工作区干净
- 一键撤销，改动完整恢复
- 全部操作进日志

---

## 安全模型（重要）

分支切换是 L1「可回滚写」；**只要工作区有未提交内容，就按 L2 破坏性写流程处理**。

```
选择分支 → Preflight 检查 → 脏则自动快照 → git switch（禁 force）→ 校验并记日志
```

- 一律使用 `git switch`，**永不 `git checkout`**，**永不 `--force`**
- 禁止清单写在**引擎层**（`server/core/git.js` 的命令白名单），不写在 UI 层
- 未提交内容一律进快照，**永不静默丢弃**（所以 UI 上根本没有「放弃改动」这个选项）
- 快照存于 `refs/gm/snapshots/*`，不污染你的 `git stash list`

详见 [`docs/02-分支切换与安全模型.md`](docs/02-分支切换与安全模型.md)。

---

## 目录结构

```
server/                    本地服务（纯 Node，零依赖）
  index.js                 HTTP 入口：本机令牌鉴权 + 静态托管
  api.js                   路由 → 参数解析（不含业务逻辑）
  core/
    git.js                 git 引擎：命令白名单 + 危险 flag 熔断
    repo.js                仓库中途接入（零侵入探测）
    analyzer.js            分析器：概览/分支/提交/热力图/健康度/AI 参与度
    safety.js              安全模块：Preflight / 快照式切换 / 撤销 / 日志
    store.js               本地存储（接口可换 SQLite）
    util.js                工具函数
web/                       前端（纯静态，无构建步骤）
  index.html
  css/app.css              设计系统（苹果风深色）
  js/api.js                ★ 唯一传输边界 —— 迁移桌面端只改这一个文件
  js/util.js               格式化与徽章
  js/views.js              四个视图
  js/palette.js            ⌘K 切换面板 + 安全切换流程
  js/main.js               状态与路由
data/                      运行时缓存（仓库列表 + 操作日志）
```

---

## API 一览

所有 `/api/*` 需要请求头 `x-gm-token`（页面通过 `/gm-config.js` 自动获取）。
服务仅绑定 `127.0.0.1`，且不发送 CORS 头，杜绝跨站读取。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/repos` | 已接入仓库列表 |
| POST | `/api/repos/open` | 接入仓库 `{ path }` |
| DELETE | `/api/repos/:id` | 从列表移除（不动磁盘） |
| GET | `/api/repos/:id/overview` | 总览 |
| GET | `/api/repos/:id/branches` | 分支列表（含风险） |
| GET | `/api/repos/:id/commits?limit=` | 提交记录 |
| GET | `/api/repos/:id/activity?weeks=` | 热力图数据 |
| GET | `/api/repos/:id/health` | 健康度报告 |
| GET | `/api/repos/:id/log` | 操作日志 |
| POST | `/api/repos/:id/preflight` | 切换前检查 `{ target }` |
| POST | `/api/repos/:id/switch` | 安全切换 `{ target, strategy, message }` |
| POST | `/api/repos/:id/undo` | 撤销上一次切换 |
| GET | `/api/fs/drives` | 可用驱动器列表 + 是否支持原生对话框 |
| POST | `/api/fs/pick` | 弹出**原生文件夹选择器**，返回所选路径 |
| POST | `/api/fs/probe` | 识别目录 `{ path }`：是否仓库 / 是否在仓库内 / 有无子仓库 |
| POST | `/api/scan` | 启动只读扫描 `{ root, maxDepth }` → `{ job }` |
| GET | `/api/scan/:id` | 轮询扫描进度与结果 |
| POST | `/api/scan/:id/cancel` | 取消扫描 |

`:id` 用仓库 id；若要用绝对路径，需 `encodeURIComponent` 后再放进 URL。

---

## 只读承诺

「选择文件夹」和「磁盘扫描」是本系统里唯一会大规模接触你磁盘的操作，因此被刻意设计成**结构上不可能造成破坏**：

| 承诺 | 落地方式 |
|---|---|
| 不写任何文件 | 扫描器只调用 `readdir` + `lstat` 两个系统调用，代码里没有任何写操作；缓存只写进本项目的 `data/` 目录 |
| 不读文件内容 | 判断是否为仓库只看 `.git` **是否存在**，不解析其内容 |
| 不跟随符号链接 | 跳过所有 symlink / 目录联接，杜绝死循环和「跑到盘外」 |
| 不越界 | 每次入队都做路径包含性校验，结果严格落在所选根目录之内 |
| 不会失控 | 三重硬上限：深度 ≤ 10、目录数 ≤ 40 万、时间 ≤ 5 分钟；可随时取消 |
| 不碰系统区域 | 默认跳过 `Windows`、`Program Files`、`AppData`、`$RECYCLE.BIN` 等，以及 `node_modules` 等重量级缓存目录 |
| 可验证 | 已实测：扫描前后被扫目录的**文件大小、修改时间、目录结构完全一致**，未新增任何文件 |

> 唯一会改动仓库的路径仍然是**分支切换**，且必须经过 Preflight + 快照 + 日志，见下一节。

---

## 迁移到桌面端

前端是**纯静态资源**，后端核心是**纯 Node 且与 HTTP 无关**，所以换壳不需要重写业务代码。
详见 [`docs/03-迁移契约与桌面端.md`](docs/03-迁移契约与桌面端.md)。

---

## 文档

- [`docs/00-产品构想与技术方案.md`](docs/00-产品构想与技术方案.md)
- [`docs/01-前端视觉提示词-Google图像生成.md`](docs/01-前端视觉提示词-Google图像生成.md)
- [`docs/02-分支切换与安全模型.md`](docs/02-分支切换与安全模型.md)
- [`docs/03-迁移契约与桌面端.md`](docs/03-迁移契约与桌面端.md)
