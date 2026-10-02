// Offsets deliberately use JavaScript UTF-16 indices, like CodeMirror selections.
const EMPTY_SQL = '没有可执行 SQL'
const MULTIPLE_SQL = '每次只能执行一条 SQL，请调整选区'

function isCompoundHeader(tokens) {
  if (tokens[0] === 'EXPLAIN') tokens = tokens.slice(tokens[1] === 'QUERY' && tokens[2] === 'PLAN' ? 3 : 1)
  if (tokens[0] === 'DELIMITER') return true
  if (tokens[0] !== 'CREATE') return false
  let i = 1
  if (tokens[i] === 'OR' && tokens[i + 1] === 'REPLACE') i += 2
  if (['TEMP', 'TEMPORARY', 'AGGREGATE'].includes(tokens[i])) i++
  if (tokens[i] === 'DEFINER') {
    i++
    if (tokens[i] === '=') i++
    i++ // account name or CURRENT_USER, quoted or unquoted
    if (tokens[i] === '(' && tokens[i + 1] === ')') i += 2
    if (tokens[i] === '@') i += 2 // account host
  }
  return ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'].includes(tokens[i])
}

function scanStatements(sql, { dialect = 'sqlite', sqlMode = '', automatic = false } = {}) {
  const modes = new Set(sqlMode.toUpperCase().split(',').map(mode => mode.trim()))
  const mysql = dialect === 'mysql'
  const spans = []
  let start = 0, hasCode = false, words = []
  const finish = end => {
    // Reject the whole document before choosing a cursor range: never run a
    // statement accidentally extracted from inside a trigger or stored routine.
    if (isCompoundHeader(words)) {
      throw new Error('暂不支持 DELIMITER、存储过程或触发器等复合语句，请单独处理')
    }
    spans.push({ from: start, to: end, hasCode })
    start = end; hasCode = false; words = []
  }
  for (let i = 0; i < sql.length;) {
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    if ((c === '-' && sql[i + 1] === '-' && (!mysql || i + 2 === sql.length || /[\s\x00-\x1f]/.test(sql[i + 2]))) || (mysql && c === '#')) {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new Error('SQL 注释没有闭合')
      if (mysql && sql[i + 2] === '!' && automatic) throw new Error('含 MySQL 可执行注释时无法自动定位语句，请明确选中单条 SQL')
      // Preserve executable comments/hints verbatim for the server and the
      // existing read-only validator; do not silently treat them as empty SQL.
      if (mysql && ['!', '+'].includes(sql[i + 2])) hasCode = true
      i = end + 2; continue
    }
    if (c === "'" || c === '"' || c === '`' || (!mysql && c === '[')) {
      hasCode = true
      words.push('<quoted>')
      const close = c === '[' ? ']' : c
      const backslash = mysql && !modes.has('NO_BACKSLASH_ESCAPES') && (c === "'" || (c === '"' && !modes.has('ANSI_QUOTES')))
      let closed = false
      i++
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === close) {
          if (c !== '[' && sql[i + 1] === close) { i += 2; continue }
          i++; closed = true; break
        }
        i++
      }
      if (!closed) throw new Error('SQL 引号没有闭合')
      continue
    }
    if (c === ';') { finish(++i); continue }
    hasCode = true
    if (/[A-Za-z_]/.test(c)) {
      const begin = i++
      while (i < sql.length && /[A-Za-z_0-9$]/.test(sql[i])) i++
      words.push(sql.slice(begin, i).toUpperCase())
    } else { words.push(c); i++ }
  }
  finish(sql.length)
  return spans
}

function resolveExecutionSql(sql, executionRange, options) {
  if (typeof sql !== 'string') throw new Error('SQL 必须是文本')
  if (executionRange !== undefined) {
    if (!executionRange || !Number.isInteger(executionRange.from) || !Number.isInteger(executionRange.to) || executionRange.from < 0 || executionRange.to < executionRange.from || executionRange.to > sql.length) throw new Error('SQL 执行范围无效')
    if (executionRange.from !== executionRange.to) {
      const selected = sql.slice(executionRange.from, executionRange.to)
      const statements = scanStatements(selected, options).filter(span => span.hasCode)
      if (!statements.length) throw new Error(EMPTY_SQL)
      if (statements.length > 1) throw new Error(MULTIPLE_SQL)
      return selected
    }
  }
  const spans = scanStatements(sql, { ...options, automatic: executionRange !== undefined })
  if (executionRange === undefined) {
    const statements = spans.filter(span => span.hasCode)
    if (!statements.length) throw new Error(EMPTY_SQL)
    if (statements.length > 1) throw new Error(MULTIPLE_SQL)
    return sql
  }
  const cursor = executionRange.from
  let span = spans.find(item => cursor >= item.from && cursor < item.to) || spans[spans.length - 1]
  // Only whitespace after the final terminator falls back. A comment-only tail
  // or an empty statement must never cause some other statement to run.
  if (!span.hasCode && span === spans[spans.length - 1] && /^\s*$/.test(sql.slice(span.from))) {
    const previous = spans[spans.length - 2]
    if (previous?.hasCode) span = previous
  }
  if (!span.hasCode) throw new Error(EMPTY_SQL)
  return sql.slice(span.from, span.to)
}

module.exports = { scanStatements, resolveExecutionSql }
