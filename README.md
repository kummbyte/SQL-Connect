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

## 回归验证

```bash
npm test
npm run test:electron
npm run test:mysql
npm run test:app:mysql
npm run test:app
```

分别覆盖请求生命周期（退出、超时、异常消息）、真实 Electron utility process 的 SQLite 和本机 MySQL 8.4 通信，以及 BrowserWindow 中连接 MySQL、选择数据库和首次点击表的完整流程。MySQL 测试会在临时数据目录和端口启动隔离实例，创建临时数据库和账号后自动清理，不读取用户连接配置。界面测试还覆盖“新建连接”菜单、SQLite 子菜单、MySQL 表单取消、文件选择取消、创建失败后恢复和重试。

打包后可复用同一界面测试验证 ASAR 中的程序和 SQLite 模块：

```bash
SQL_CONNECT_TEST_APP_ROOT='dist/mac-arm64/SQL Connect.app/Contents/Resources/app.asar' npm run test:app
```
