# SQL Connect

一个面向 macOS 的轻量 SQLite 数据库工作台。首版支持打开或创建本地 SQLite 文件、浏览表结构、分页查看和编辑数据，以及使用 SQL 编辑器执行查询。

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

`npm run dist` 会生成 Apple Silicon macOS DMG。应用默认启用上下文隔离，SQLite 操作运行在独立的 Electron utility process 中。

如果当前机器无法创建磁盘映像，可使用 `npm run dist:zip` 生成可直接解压运行的 arm64 ZIP，或使用 `npm run dist:dir` 生成 `.app` 目录。

## 首版边界

目前只支持普通本地 SQLite 文件，不支持 SQLCipher、远程数据库、导入导出和多语句脚本。结构修改可以直接在 SQL 编辑器中完成。

## 回归验证

```bash
npm test
npm run test:electron
npm run test:app
```

分别覆盖请求生命周期（退出、超时、异常消息）、真实 Electron utility process 的 SQLite 通信，以及新建数据库按钮到连接保存的界面流程。测试使用独立临时目录，不读取用户连接配置。界面测试包含中文文件名、创建失败后恢复、重试和取消文件选择。

打包后可复用同一界面测试验证 ASAR 中的程序和 SQLite 模块：

```bash
SQL_CONNECT_TEST_APP_ROOT='dist/mac-arm64/SQL Connect.app/Contents/Resources/app.asar' npm run test:app
```
