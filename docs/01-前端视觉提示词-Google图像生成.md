# git-manager · 前端视觉提示词（发给 Google / Imagen 生成效果图）

> 用法：把下面 **英文主提示词** 整段复制给 Google 图像生成模型。
> 想要不同风格，用文末的「变体开关」替换其中对应句子。

---

## 主提示词（English，推荐直接用这段）

```
A high-fidelity UI design mockup of a premium desktop application called "git-manager", a local Git repository analytics and health dashboard. Apple macOS design language, extremely clean and minimal, high-end professional developer tool.

WINDOW FRAME
A macOS application window with rounded corners (14px radius), soft subtle drop shadow, thin hairline border. Top-left traffic light buttons (red, yellow, green). A slim unified title bar with a small centered window title.

LAYOUT
Three-part layout: a narrow left sidebar (about 180px), a spacious main dashboard area, generous whitespace throughout. 24px content padding, 12px gaps between cards, 12px corner radius on cards.

LEFT SIDEBAR
Darker recessed surface with a subtle vertical hairline divider. A small minimal geometric logo mark plus the wordmark "git-manager". Vertical navigation list with small line icons and labels: "Overview", "Commit graph", "Branches", "Health", "AI context". The first item is active, shown as a soft rounded pill highlight.

MAIN DASHBOARD
Header: repository name "my-vibe-project" with a muted subtitle "main · 128 commits · 12 days active".
Top row: a circular health score ring on the right showing a large number "82" with a thin progress arc, and three flat metric cards on the left: "Total commits 128", "Unmerged branches 4", "AI involvement 63%". Metric cards have muted small labels above and larger numerals below.
Middle: a GitHub-style contribution heatmap grid of small rounded squares in varying opacity of a single accent color, labeled "Commit activity · last 12 weeks".
Bottom: a compact commit timeline / commit graph with a vertical line, small circular nodes, one curved branch line, short commit message text and relative timestamps; one node has a tiny "AI" tag chip.

STYLE
Flat design, no gradients on UI chrome, no glassmorphism overload, crisp 1px hairline dividers, generous negative space, perfectly aligned grid, precise typography with tight letter spacing, iOS/macOS native feel. Dark mode interface: deep neutral dark gray surfaces (#1C1C1E window, #232326 cards), light near-white text (#F5F5F7), muted secondary text (#98989D). One single accent color used sparingly for data emphasis: bright Apple system blue, plus a subtle green for the health arc.

TECHNICAL
Vector-crisp UI screenshot, straight-on front view, no perspective, no device frame, no hands, no people, no text artifacts. Legible UI typography only. Ultra sharp, 4K, high detail, studio product render of a software interface. Minimal and elegant, exactly like a real Apple-designed pro app.
```

---

## 中文对照版（如需中文提示词）

```
一张高端桌面应用 UI 设计效果图。产品名 "git-manager"，是一个本地 Git 仓库分析与健康度仪表盘，苹果 macOS 设计语言，极简、高级、专业开发者工具。

窗口：macOS 风格应用窗口，14px 圆角、轻微柔和阴影、细描边，左上角红黄绿交通灯按钮，顶部细标题栏。

布局：左侧约 180px 窄侧边栏 + 右侧宽松主仪表盘，大量留白，内容边距 24px，卡片间距 12px，卡片圆角 12px。

侧边栏：更深的凹陷配色，竖向细分割线；极简几何 logo + "git-manager" 文字标识；竖排导航（细线图标 + 文字）：概览、提交图谱、分支、健康度、AI 上下文；第一项为选中态，浅色圆角胶囊高亮。

主仪表盘：
- 顶部：标题 "my-vibe-project" + 灰色副标题 "main · 128 commits · 12 days active"。
- 右上角：圆形健康度评分环，中间大数字 "82"，细进度弧。
- 左上：三张扁平指标卡：提交总数 128 / 未合并分支 4 / AI 参与度 63%。卡片内小号灰色标签在上、较大数字在下。
- 中部：GitHub 风格贡献热力图，小圆角方块、同一强调色的不同透明度，标签 "提交活动 · 近 12 周"。
- 底部：紧凑提交时间线/图谱，竖线 + 小圆节点 + 一条分叉曲线 + 短提交信息与相对时间；一个节点带极小 "AI" 标签。

风格：扁平、UI 无渐变、克制的细线分割、大量留白、对齐严谨、字距紧凑、iOS/macOS 原生质感。深色模式：深中性灰界面（窗口 #1C1C1E，卡片 #232326），近白文字 #F5F5F7，次要文字 #98989D；仅用单一强调色——苹果系统蓝，配一点绿色用于健康度弧。

技术：矢量级清晰 UI 截图，正视无透视，无设备外框、无人物、无乱码文字。超清 4K，细节丰富，像真实苹果专业应用的产品级界面渲染。
```

---

## 变体开关（按需替换一句）

| 想要的效果 | 替换句 |
|---|---|
| **浅色模式** | 把 “Dark mode interface…” 换成：“Light mode interface: pure white window and card surfaces (#FFFFFF / #F5F5F7), near-black text (#1D1D1F), muted gray secondary (#86868B), hairline borders at 8% black.” |
| **玻璃拟态更明显** | 在 STYLE 里加：“Subtle frosted-glass panels with backdrop blur on the sidebar and top bar, very restrained.” |
| **三屏并列展示** | 在 TECHNICAL 前加：“Show three screens side by side: the dashboard, the commit graph view, and the AI context export panel.” |
| **更「Mac 原生」** | 把标题栏句换成：“A realistic macOS Sonoma window with traffic lights, and a thin vibrancy titlebar.” |
| **数据更丰富** | 把 MAIN DASHBOARD 换成增加：“add a small donut chart of branch categories and a compact bar chart of commits per weekday.” |

> 提示：图像模型对**具体颜色值**和**布局术语**响应最好，所以优先改颜色和布局句，不要改抽象形容词。

---

## 附 · 分支快速切换面板（⌘K Spotlight 版）专用提示词

```
A macOS Spotlight-style floating command palette for switching Git branches, centered over a dimmed dashboard. Rounded card with 14px radius, dark surface #1C1C1E, 1px hairline border, subtle soft shadow.

At the top: a rounded search field (#232326) containing a magnifier icon, the typed query "fe", and a thin blinking blue caret; a small muted "esc" hint on the right end.

Below: a thin divider, then a muted small section label "Local branches". Then a vertical list of branch rows. Each row has a small minimal git-branch glyph on the left (two dots joined by a thin curve), the branch name in near-white text, and a right-aligned small rounded status pill:
- "main" — blue pill "current"
- "feature/auth-flow" — blue pill "3 ahead"
- "feature/new-router" — amber pill "uncommitted changes"
- "fix/null-guard" — red pill "would overwrite untracked files"
- "old-experiment" — gray pill "stale 92d"
One row is subtly highlighted as the keyboard-selected row with a soft neutral fill.

At the bottom: a thin divider and a muted footer hint row "↑↓ select · ⏎ switch · ⌥⏎ new branch".

Style: flat, minimal, no gradients, restrained single accent color (Apple system blue), plus amber for warning and red for danger states. Crisp hairline separators, generous row height, tight letter spacing, iOS/macOS native feel. Straight-on front view, no perspective, no device frame, ultra sharp 4K UI render.
```

> 想再要一张「切换前安全检查对话框」的图，把上面第 3 段（行列表）替换为：
>
> `A modal confirmation dialog titled "Safe switch", listing three check rows with status dots (working tree dirty — 3 changes, target branch exists, no untracked conflicts), a muted note "Will create an automatic snapshot before switching", and three buttons at the bottom: "Cancel", "Commit first", and a highlighted primary button "Snapshot & switch".`

