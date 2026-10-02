const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveExecutionSql: resolve } = require('../src/main/db/sql-statements.cjs')
const at = (sql, position, options) => resolve(sql, { from: position, to: position }, options)
const mysql = { dialect: 'mysql' }

test('cursor chooses first, middle, last and unterminated final statement', () => {
  const sql = 'SELECT 1;\n SELECT 2;\nSELECT 3'
  assert.equal(at(sql, 0), 'SELECT 1;')
  assert.equal(at(sql, sql.indexOf(';')), 'SELECT 1;')
  assert.equal(at(sql, sql.indexOf(';') + 1), '\n SELECT 2;')
  assert.equal(at(sql, sql.length), '\nSELECT 3')
  assert.equal(at('SELECT 1; \n', 11), 'SELECT 1;')
  assert.equal(at('SELECT 1;', 9), 'SELECT 1;')
})
test('empty statements and pure comment tails never execute previous SQL', () => {
  for (const sql of ['', ' ', '-- comment', '/* comment */', ';', 'SELECT 1;;', 'SELECT 1; -- comment']) assert.throws(() => at(sql, sql.length), /没有可执行/)
  assert.throws(() => at('SELECT 1;;SELECT 2', 9), /没有可执行/)
})
test('selection is exact, never expanded and does not parse unselected invalid SQL', () => {
  const sql = "bad ';SELECT 2 AS value; invalid '"
  const from = sql.indexOf('SELECT'), to = sql.indexOf('; invalid')
  assert.equal(resolve(sql, { from, to }), 'SELECT 2 AS value')
  assert.equal(resolve('SELECT 123;', { from: 7, to: 10 }), '123')
  assert.throws(() => resolve('SELECT 1; SELECT 2', { from: 0, to: 18 }), /每次只能执行一条 SQL，请调整选区/)
  assert.throws(() => resolve('SELECT 1; SELECT 2'), /每次只能执行一条/)
  assert.throws(() => resolve('SELECT 1;  ', { from: 9, to: 11 }), /没有可执行/)
})
test('quotes, quoted identifiers and comments contain non-delimiting semicolons', () => {
  const statements = ["SELECT 'a;''b';", 'SELECT "a;""b";', 'SELECT `a;``b`;', 'SELECT [a;b];', '-- ; ignored\nSELECT 1;', '/* ; ignored */ SELECT 1;', 'SELECT 1 -- ; ignored\n;']
  for (const first of statements) assert.equal(at(first + '\nSELECT 2', 0), first)
  assert.equal(resolve('SELECT 1; -- trailing ; comment'), 'SELECT 1; -- trailing ; comment')
  assert.equal(at('# ; comment\nSELECT 1; SELECT 2', 0, mysql), '# ; comment\nSELECT 1;')
  assert.equal(at('SELECT 4--2; SELECT 3', 0, mysql), 'SELECT 4--2;')
  assert.equal(at('SELECT 4--2; SELECT 3', 0), 'SELECT 4--2; SELECT 3')
})
test('MySQL escaping follows both relevant session modes', () => {
  const escaped = "SELECT 'a\\';b'; SELECT 2;"
  assert.equal(at(escaped, 0, mysql), "SELECT 'a\\';b';")
  assert.throws(() => at(escaped, 0, { ...mysql, sqlMode: 'NO_BACKSLASH_ESCAPES' }), /引号没有闭合/)
  const literal = "SELECT 'a\\'; SELECT 2;"
  assert.equal(at(literal, 0, { ...mysql, sqlMode: 'NO_BACKSLASH_ESCAPES' }), "SELECT 'a\\';")
  assert.equal(at('SELECT "a\\"; SELECT 2;', 0, { ...mysql, sqlMode: 'ANSI_QUOTES' }), 'SELECT "a\\";')
  assert.throws(() => at('SELECT "a\\"; SELECT 2;', 0, mysql), /引号没有闭合/)
})
test('executable comments and hints are preserved', () => {
  for (const sql of ['/*! SELECT 1 */', 'SELECT /*+ MAX_EXECUTION_TIME(10) */ 1', 'SELECT 1 /*! ; SELECT 2 */']) assert.equal(resolve(sql, undefined, mysql), sql)
})
test('cursor does not guess boundaries modified by executable comments', () => {
  const sql = 'CREATE /*!50003 TRIGGER t AFTER INSERT ON a FOR EACH ROW BEGIN */ SELECT 1; DELETE FROM a; END;'
  assert.throws(() => at(sql, sql.indexOf('DELETE'), mysql), /可执行注释/)
  const single = '/*! SELECT 1 */'
  assert.equal(resolve(single, { from: 0, to: single.length }, mysql), single)
})
test('UTF-16 positions include Chinese text and surrogate pairs', () => {
  const sql = "SELECT '中文😀'; SELECT '目标';"
  const from = sql.indexOf(' SELECT')
  assert.equal(at(sql, from), " SELECT '目标';")
  assert.equal(resolve(sql, { from, to: sql.length }), " SELECT '目标';")
})
test('malformed or out-of-bounds execution ranges fail', () => {
  for (const range of [null, {}, { from: -1, to: 0 }, { from: 0, to: 99 }, { from: 2, to: 1 }, { from: 1.5, to: 2 }, { from: '0', to: 2 }, { from: NaN, to: 2 }]) assert.throws(() => resolve('SELECT 1', range), /范围无效/)
  assert.throws(() => resolve(null), /必须是文本/)
})
test('unterminated quotes and comments prevent cursor execution anywhere', () => {
  for (const sql of ["SELECT 1; SELECT 'bad", 'SELECT 1; /* bad', 'SELECT [bad', 'SELECT `bad']) assert.throws(() => at(sql, 0), /没有闭合/)
})
test('compound scripts are rejected even when cursor is in an internal statement', () => {
  for (const sql of ['DELIMITER $$\nSELECT 1$$', 'CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT 2; END;', 'EXPLAIN CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; DELETE FROM a; END;', 'CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;', 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;', 'CREATE DEFINER=user@localhost PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;', 'CREATE DEFINER=CURRENT_USER() PROCEDURE p() BEGIN SELECT 1; END;', 'CREATE DEFINER=`root`@`localhost` FUNCTION f() RETURNS INT BEGIN RETURN 1; END;', 'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN SELECT 1; END;']) assert.throws(() => at(sql, Math.max(0, sql.lastIndexOf('SELECT'))), /复合语句/)
  assert.equal(resolve('CREATE TABLE items (id INT, function TEXT)'), 'CREATE TABLE items (id INT, function TEXT)')
})
