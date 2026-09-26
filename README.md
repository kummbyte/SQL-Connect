# SQL Connect

一个面向 macOS 的轻量数据库工作台。支持打开或创建本地 SQLite 文件，也支持通过 TCP/TLS 连接 MySQL，浏览多个数据库、表结构和分页数据，并使用 SQL 编辑器执行查询与写入。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run typecheck
npm run build
npm run dist
```

`npm run dist` 会生成 Apple Silicon macOS DMG。应用默认启用上下文隔离，SQLite 和 MySQL 操作运行在独立的 Electron utility process 中。

如果当前机器无法创建磁盘映像，可使用 `npm run dist:zip` 生成可直接解压运行的 arm64 ZIP，或使用 `npm run dist:dir` 生成 `.app` 目录。

## 支持范围

SQLite 支持打开、创建、浏览和表格编辑。MySQL 支持主机、端口、用户名、密码、可选 TLS/CA、多个数据库浏览、结构查看、分页筛选和 SQL 读写；MySQL 表格直接编辑、SSH 隧道、客户端证书认证、导入导出和多语句脚本暂不支持。勾选“记住密码”后，密码通过 Electron safeStorage 加密保存。

SQL 编辑器会按当前连接使用 SQLite 或 MySQL 方言，并将关键字以大写形式补全。输入关键字前缀后按 Tab 接受候选；没有候选时 Tab 继续执行缩进。按 ⌘ Enter 执行当前编辑器中的 SQL，执行按钮与快捷键使用相同的一次一条 SQL 规则。

侧栏按连接显示断开按钮。在线连接行最右侧的断连图标只会断开该连接，悬停可查看“断开连接”提示；离线连接保留相同操作空间，便于长名称和多连接列表保持稳定布局。断开前会确认该连接标签中的未提交 SQLite 修改，确认后清理该连接的标签和缓存，其他连接保持不变。

点击侧栏中的已保存连接只展开或收起详情，不会自动连接。展开区显示 SQLite 文件路径和访问权限，或 MySQL 主机、端口、用户名、TLS 与 CA 证书路径；密码不会显示。使用详情中的“连接”按钮启动连接，断开后详情保持展开，可直接重连。

在线连接的“连接信息”可单独折叠，数据库树保持显示。连接详情中的“删除”会要求确认，并说明只删除保存的连接；若有未提交修改，会列出受影响的标签。删除成功后只断开并移除该连接配置，不会删除 SQLite 文件或 MySQL 数据。数据库树的根级“数据库”标题与连接信息左对齐。

MySQL 连接中的数据库节点可以分别展开或收起，多个数据库的表和视图可以同时显示。展开数据库会将其设为新建 SQL 查询的默认库；收起节点不会更改默认库，已经打开的 SQL 和表格标签继续使用各自的数据库。

## 回归验证

```bash
npm test
npm run test:electron
npm run test:mysql
npm run test:settings
npm run test:app:mysql
npm run test:app
```

分别覆盖请求生命周期（退出、超时、异常消息）、真实 Electron utility process 的 SQLite 和本机 MySQL 8.4 通信，以及 BrowserWindow 中连接 MySQL、选择数据库、首次点击表和 SQL 编辑器快捷键的完整流程。配置测试覆盖 SQLite 符号链接重复合并、只读保留、MySQL 不同用户区分、配置备份、原子保存和按连接 ID 删除。MySQL 测试会在临时数据目录和端口启动隔离实例，创建临时数据库和账号后自动清理，不读取用户连接配置。界面测试还覆盖“新建连接”菜单、重复打开 SQLite/MySQL、SQLite 子菜单、MySQL 表单取消、文件选择取消、创建失败后恢复和重试、按行断开并重连、确认后删除在线或离线连接且保留数据库文件、MySQL 连接信息折叠、数据库树对齐及多数据库节点独立展开，以及 SQLite/MySQL 的 Tab 补全和 ⌘ Enter 执行。

打包后可复用同一界面测试验证 ASAR 中的程序和 SQLite 模块：

```bash
SQL_CONNECT_TEST_APP_ROOT='dist/mac-arm64/SQL Connect.app/Contents/Resources/app.asar' npm run test:app
```
