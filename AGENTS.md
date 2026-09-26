# SQL Connect 项目开发约定与踩坑记录

记录日期：2026-09-24。本文适用于本项目；依赖版本、功能状态和验证结果变化后应同步更新。以实际代码和测试为准，不把最初计划或历史交付说明当作已完成功能清单。

## 项目与执行环境

- 产品：SQL Connect，类似 Navicat 的桌面数据库客户端，支持普通本地 SQLite 文件和 TCP/TLS MySQL 连接。
- 项目源目录：`/Users/wuqiang/Projects/SQL-Connect`。在当前 Mac 本地安装依赖、运行测试和打包，不自动切换到 WSL。
- 当前目标平台：Apple Silicon macOS（arm64）。Windows、SQLCipher、远程数据库不属于首版已验证范围。
- 使用 npm，维护 `package.json` 与 `package-lock.json`；不要随意混用包管理器或删除锁文件。
- 忽略 `node_modules/`、`out/`、`dist/`、`.DS_Store`、`._*` 等依赖、构建产物和 macOS 元数据。
- 测试使用独立临时数据库和用户数据目录，不操作用户真实数据库或覆盖连接配置。

## 技术栈

下表为记录日锁文件中的实际版本，不是未来升级限制。

| 用途 | 技术与版本 |
| --- | --- |
| 桌面运行时 | Electron 36.9.5 |
| 界面 | React / React DOM 18.3.1、TypeScript 5.9.3、自定义 CSS |
| 构建 | electron-vite 3.1.0、Vite 6.4.3、React Vite 插件 |
| SQLite | better-sqlite3 13.0.3，原生模块 |
| MySQL | mysql2 3.24.4，运行在数据库 utility process |
| SQL 编辑器 | CodeMirror 6、@uiw/react-codemirror 4.25.11、@codemirror/lang-sql 6.10.0、自动补全与快捷键扩展 |
| 编辑器主题与图标 | @codemirror/theme-one-dark 6.1.3、lucide-react 0.468.0 |
| 应用打包 | electron-builder 26.15.3、ASAR、macOS arm64 |
| 回归测试 | Node 内置 node:test、真实 Electron utility process、BrowserWindow 界面测试 |

本次开发机器的 Node 为 26.3.0、npm 为 11.16.0。宿主 Node 和 Electron 内置 Node 是不同运行时，原生模块必须分别验证。

## 架构与文件入口

调用链：React 界面 → `window.sqlConnect` → preload → 主进程 IPC → `WorkerClient` → utility process → SQLite/MySQL 适配器。

- `src/main/index.ts`：窗口、文件选择器、连接配置读写、IPC 注册；每个连接管理一个独立数据库子进程。
- `src/main/db/worker-client.ts`：请求编号、响应关联、超时、异常退出和关闭时的 Promise 清理。
- `src/main/db/worker.cjs`：CommonJS 子进程入口，直接加载 better-sqlite3，执行连接、结构查询、SQL 和批量修改。
- `src/preload/index.ts`：通过 `contextBridge` 暴露有限的业务 API。保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- `src/shared/types.ts`：连接、查询结果、数据修改及 preload API 的共享类型；改接口时同步调用链两端。
- `src/renderer/main.tsx`、`styles.css`：中文工作台、连接树、多标签页、数据网格、SQL 编辑器和主题。
- `src/renderer/index.html`：实际渲染入口。项目根目录另有历史 `index.html`，当前 electron-vite 默认构建不使用它。
- 连接配置保存在 `app.getPath('userData')/connections.json`；当前主题偏好使用渲染层 localStorage。

## 常用命令与验证标准

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run test:electron
npm run test:mysql
npm run test:settings
npm run test:app:mysql
npm run test:app
npm run build
npm run dist:dir
npm run dist:zip
npm run dist
```

- `npm test`：请求关联、数据库错误、子进程崩溃、超时、无效响应、发送失败和取消的生命周期测试。
- `npm run test:electron`：真实 Electron utility process 创建中文路径数据库，执行 SQL、读取表、重新连接和验证错误路径。
- `npm run test:app`：先构建，再验证“新建连接”菜单、SQLite 子菜单、MySQL 表单取消、Esc 关闭、创建数据库、保存连接、失败提示、文件选择取消和重试，在线/离线连接删除确认与数据库文件保留，SQLite 长表名和视图在窄侧栏下的固定图标、无类型文字、缩进与名称宽度，以及 SQL 编辑器的 Tab 补全和 ⌘ Enter 执行。文件选择器返回值由测试替身提供，不能据此宣称原生对话框交互已人工验收。
- `npm run test:app:mysql`：在隔离 MySQL 8.4 实例中验证多数据库表浏览、同名表上下文、多个数据库节点独立展开和收起、默认查询数据库选择、重复连接复用、无密码重连提示、连接信息独立折叠、数据库树根级对齐、在线删除，以及 MySQL 长表名和视图在窄侧栏下的固定图标、无类型文字、缩进与名称宽度，以及 SQL 编辑器的 Tab 补全和 ⌘ Enter 执行。
- `npm run test:settings`：使用独立配置验证 SQLite 符号链接重复合并、只读保留、MySQL 不同用户区分、配置备份、原子保存和按 ID 删除连接。
- 涉及 worker、IPC 或原生模块的修改，不能只运行类型检查、构建或普通 Node 子进程测试；必须覆盖真实 Electron 通信。
- 涉及打包路径、preload 或 SQLite 模块时，还应验证打包内容：

```bash
SQL_CONNECT_TEST_APP_ROOT='dist/mac-arm64/SQL Connect.app/Contents/Resources/app.asar' npm run test:app
```

该测试用 Electron 加载打包 ASAR 中的程序；它不等同于 DMG 安装、签名、公证或系统启动验证。负向用例出现 `Error occurred in handler for 'db:connect'` 可以是预期输出，应结合 PASS、断言和退出码判断。

## 已踩过的坑

### 1. 新建数据库一直“正在执行”：Electron 与 Node 消息形状不同

**现象**：点击新建并选择保存路径后，界面一直等待。真实 Electron 回归测试观察到响应 `id: undefined`，错误为 `Cannot read properties of undefined (reading 'connectionId')`。

**根因**：worker 把 Electron 的 MessageEvent 当成请求对象读取。请求实际位于 `event.data`，导致 `id`、`type`、`payload` 全部读取错误，主进程无法关联响应。

```js
// Electron utility process 内：必须取 event.data。
process.parentPort.on('message', event => handle(event.data))

// Electron 主进程内：收到的就是响应，不额外取 .data，也没有前置 event 参数。
worker.on('message', response => handleResponse(response))

// 普通 Node child_process 内：收到的就是请求。
process.on('message', request => handle(request))
```

- `worker.cjs` 必须保持两种接收方式的区别。[Electron parentPort 官方说明](https://www.electronjs.org/docs/latest/api/parent-port)
- 最初普通 Node fork 测试通过，真实应用仍失败；这是必须保留 Electron 回归测试的原因。
- 不用 `as any` 掩盖事件监听签名错误。当前 `WorkerClient` 直接使用 Electron 的类型定义。

### 2. 只修消息格式不够：请求必须在失败时结束

- 子进程退出、发送失败、协议错误或主动关闭时，拒绝该子进程的所有待处理请求并清理计时器，避免界面的 `finally` 永远无法执行。
- 当前连接超时为 15 秒，读取 schema / structure 超时为 30 秒；SQL 执行及表格提交不套用这两个超时，以免任意改变长查询或写入语义。
- 重连时旧进程的延迟退出事件不能删除新连接：删除 Map 条目前检查当前实例是否仍是同一个 `WorkerClient`。
- 当前取消请求会结束该连接，尚未实现取消后自动重连；不要把重连当作已有行为。

### 3. 创建与打开数据库必须区分

- 普通打开使用 `fileMustExist: true`，路径不存在时明确报错，不隐式创建空文件。
- 显式新建携带临时 `create: true`，SQLite 构造参数使用 `fileMustExist: !payload.create`。
- 曾只放宽文件存在性检查，仍保留 `fileMustExist: true`，新建继续报 `unable to open database file`。
- 连接成功后移除 `create` 再保存配置，避免以后“打开旧连接”误变成创建操作。
- 文件选择器取消后应直接返回；数据库错误要结束等待并允许重试。

### 4. SQLite 原生依赖与 Node 版本不兼容

- better-sqlite3 11.10.0 在本机 Node 26.3.0 下无可用预编译包，源码构建出现 V8 `GetPrototype`、`GetIsolate` 等 API 错误。
- 本次升级到 13.0.3 后通过宿主 Node 和真实 Electron SQLite 测试；不要仅凭 npm 安装成功断言应用可以运行。
- 打包保留 `npmRebuild: true`，并检查 better-sqlite3 的原生模块是否随 ASAR / unpacked 内容正确分发。

### 5. npm 下载慢、安装脚本与 Electron 安装不完整

- npm 曾长时间没有终端输出，但日志显示仍在下载。先检查 `~/.npm/_logs` 和进程状态，不把无输出直接判定为网络失败，也不要反复启动并行安装。
- npm 11 曾提示 electron、esbuild、electron-winstaller 的安装脚本未批准；按实际提示审查具体依赖，当前批准记录位于 `package.json` 的 `allowScripts`。不要全局无差别批准脚本。
- 曾存在 `node_modules/electron/dist/` 但缺少可执行文件或 `path.txt`；目录存在不代表 Electron 安装完整。
- 先尝试依赖正常安装流程；必要时从已验证版本的缓存恢复 Electron 安装。验证 `require('electron')` 返回的二进制路径真实存在，并能启动真实 Electron 测试；不要仅检查 `.bin/electron` 链接。

### 6. electron-vite 输出与入口路径不一致

- 当前默认输出是 `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html`；`package.json.main` 和打包 `files` 必须与之匹配，不能沿用最初误配的 `dist-electron/`。
- 渲染 HTML 在 `src/renderer/` 下，脚本入口使用 `./main.tsx`。曾使用 `/src/renderer/main.tsx` 导致构建无法解析。
- 当前 package.json 未设 `type: module`，主进程和 preload 构建为 CommonJS `.js`；不要把 preload 路径硬写为不存在的 `.cjs`。
- worker 是直接分发的 `src/main/db/worker.cjs`，必须包含在打包 `files` 中，并使用 `app.getAppPath()` 定位。
- SQL 编辑器的字符串 prop 曾命名为 `sql`，遮蔽同名语言扩展函数；导入使用 `sql as sqlLanguage`，避免把字符串当函数调用。

### 7. 打包成功、运行成功和 DMG 成功是不同结论

- 历史受限环境运行开发服务器出现 `listen EPERM ::1:5173`，创建磁盘映像出现 `hdiutil: create failed - 设备未配置`；这些是当时环境的现象，不是当前机器永久不支持 DMG 的结论。
- 遇到 DMG 构建停滞先查工具输出和环境权限；可以用 `dist:dir` / `dist:zip` 验证应用本身，不要为运行应用关闭 Chromium 沙箱。
- 已生成并验证 arm64 `.app`、ZIP 及 ASAR 内的创建数据库流程；没有 Apple Developer ID 签名和公证，不能据此宣称可面向公众分发。

### 8. 修了项目源码，用户仍可能运行桌面旧版

- 本次故障时用户实际运行的是 `/Users/wuqiang/Desktop/SQL Connect.app`，不是项目 `dist/` 中的应用。
- 更新前确认实际运行路径、应用标识 `com.sqlconnect.app` 和产物内容，不能仅重建项目就宣称用户安装版本已修复。
- 本次仅在资源兼容的前提下备份并替换桌面应用的 `Contents/Resources/app.asar`，备份位于 `dist/backups/Desktop-app.before-worker-fix.asar`；数据库与连接配置未修改。依赖或原生资源变化时应完整重新打包并更新应用，不能机械沿用只换 ASAR 的做法。
- 已运行进程不会自动加载新主进程代码，更新后需完全退出（⌘Q）再打开。

## 功能状态与后续修改原则

- 当前已验证 SQLite 连接/新建及错误恢复，以及隔离临时 MySQL 8.4 实例的连接、多数据库浏览、结构读取、分页筛选、独立 SQL 会话和 BrowserWindow 首次点击表；MySQL 表格直接编辑、SSH 隧道和客户端证书认证仍未实现。
- 连接配置按 SQLite 规范化文件路径或 MySQL 主机/端口/用户/TLS/CA 身份去重；历史重复配置启动时合并，SQLite 重复项任一只读时保留只读。
- 当前表格写入依赖 rowid；复合主键、WITHOUT ROWID 表、生成列、BLOB 和大整数的完整编辑支持不能仅凭现有共享类型或界面推断。
- 显式事务状态展示、停止按钮到取消 API 的完整联动、SQL 选区执行、字段级筛选等，后续开发前应检查实现与测试，不沿用早期交付描述作为完成证据。SQL 编辑器当前支持关键字 Tab 补全和 ⌘ Enter 执行全文，仍不支持选区执行。
- 变更数据写入逻辑时必须验证事务回滚、并发修改冲突与值类型保持。表格操作使用参数绑定并正确转义标识符，不拼接用户输入值到 SQL。
- 文档修改无需重复运行应用测试；运行时修改按受影响调用链执行相应回归，并明确报告未验证范围。

### 标签页右键批量关闭（已实现）

- 标签栏中的表数据、结构和 SQL 标签支持右键菜单：关闭左侧窗口、关闭右侧窗口、关闭其他窗口。
- 右键目标不自动激活；菜单位置限制在窗口范围内，点击外部、滚动、失焦或按 Esc 会关闭菜单；没有可关闭标签的选项置灰。
- 单页关闭和批量关闭共用关闭入口。关闭激活页时优先选择右侧相邻页，其次左侧；保留激活页时不切换当前页。
- 目标标签存在暂存数据修改时统一确认；取消会保留全部标签，确认会放弃列出的修改并关闭。关闭时同步清理结果、结构、暂存修改和按标签保存的 SQL 文本。
- SQL 编辑器内容按 sqlByTab 保存，切换或批量关闭标签不会串用编辑内容。异步查询返回前标签被关闭时，响应不会重新写入已关闭标签的结果缓存。
- 右键菜单只影响工作区标签，不断开 SQLite 连接、不删除数据库、不隐式取消正在执行的 SQL。
- 回归测试覆盖五个标签的左侧、右侧、其他关闭，非激活右键、Esc 关闭和连接创建错误恢复。新增行为主要位于 src/renderer/main.tsx 与 src/renderer/styles.css；不新增 IPC 或依赖。

### 按连接断开（已实现）

- 侧栏底部不再提供“断开当前连接”；每个在线连接行最右侧使用 `Unplug` 图标按钮，提供“断开连接”悬停提示和无障碍标签。离线连接保留相同宽度的占位，避免长名称或连接状态变化造成布局跳动。
- 连接行由展开按钮和操作区域组成，断开图标直接使用所在行的连接 ID，不会触发行展开、收起或其他连接的断开。按钮支持键盘操作，断开期间禁止重复请求。
- 断开前检查该连接标签的未提交修改；取消确认会保留连接、标签和缓存，确认后等待 MySQL 查询会话释放，再关闭连接并清理目标连接的标签、结果、结构、SQL 文本、暂存修改和数据库树缓存。其他连接及其标签保持不变，当前标签按相邻标签规则切换。
- SQLite 只读/读写切换复用同一断开确认流程，取消时不保存权限变化也不重连。断开失败只显示错误并保留该连接状态。
- `tests/app-electron.cjs` 覆盖多 SQLite 连接的目标行断开、重连和旧底部入口移除；`tests/app-mysql-electron.cjs` 覆盖隔离 MySQL 连接的断开、重新输入密码后重连及数据库树恢复。

### 已保存连接详情与手动连接

- 点击连接行只切换展开状态；即使离线也可查看已保存信息。展开区展示 SQLite 文件路径、只读/读写状态，或 MySQL 主机、端口、用户名、TLS 和 CA 路径，不渲染密码。
- 离线连接在详情区通过“连接”按钮显式启动，重复请求期间按钮禁用。连接失败保留详情和重试入口；MySQL 未保存密码时继续使用密码表单。连接成功后详情上方显示配置、下方显示数据库树。
- 断开后保留目标连接展开，以便查看信息和重新连接；行展开状态不依赖在线状态。
- `tests/app-electron.cjs` 验证离线 SQLite 展开不会连接、连接详情、长路径换行、深浅主题、键盘连接和重新连接；`tests/app-mysql-electron.cjs` 验证 MySQL 主机配置、认证失败后重试及数据库树恢复。

### 已保存连接删除与信息折叠

- 在线或离线连接均可删除，每次都会确认；提示仅删除连接配置，不删除 SQLite 文件或 MySQL 数据。有未提交修改时同时列出目标标签并要求确认放弃。
- 删除通过 `settings:removeConnection` 按连接 ID 执行。主进程先原子保存剩余配置，成功后关闭该连接 worker 并移除内存中的密码与配置缓存；写入失败时保留原连接。
- 在线连接信息可独立折叠，默认收起，数据库树保持展开；数据库树根级标题不再多缩进，表和视图保留层级缩进。
- `tests/app-electron.cjs` 覆盖在线/离线删除确认、SQLite 文件保留及其他在线连接保留；`tests/app-mysql-electron.cjs` 覆盖在线 MySQL 删除、信息折叠与数据库树对齐；`tests/settings-electron.cjs` 覆盖按 ID 删除配置。

### MySQL 多数据库节点展开

- 数据库树展开状态按连接 ID 和数据库名独立记录，展开一个数据库不会收起其他库，再次点击可收起当前库；断开或删除连接时清理其展开状态。
- 展开数据库会更新新建 SQL 查询的默认库；收起节点时保留最近一次选择，已有 SQL 和表格标签继续使用自身上下文。表与视图标签互不影响数据库节点的展开状态。
- `tests/app-mysql-electron.cjs` 使用隔离 MySQL 8.4 双库验证同一节点折叠/展开、多库同时展开、数据库上下文和同名表查询结果。

### 侧栏表和视图行布局

- SQLite 与 MySQL 共用表行样式：表图标固定为 16px，不显示 `TABLE/VIEW` 类型文字，表名区域可收缩并省略，结构按钮固定在右侧。
- 连接详情与数据库子列表缩进已收紧，同时保留层级线；表名完整内容及表/视图类型通过悬停提示和无障碍名称提供。
- 测试在窄侧栏中测量长表名、视图的图标尺寸和各列边界，并检查主题切换后的尺寸。
- `tests/app-electron.cjs` 和 `tests/app-mysql-electron.cjs` 分别使用真实 SQLite、隔离 MySQL BrowserWindow 覆盖此布局。
