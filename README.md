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
