import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CodeMirror from '@uiw/react-codemirror'
import { MySQL, SQLite, sql as sqlLanguage } from '@codemirror/lang-sql'
import { acceptCompletion, autocompletion } from '@codemirror/autocomplete'
import { indentWithTab } from '@codemirror/commands'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { Activity, AlertCircle, Check, ChevronDown, ChevronRight, CircleDot, Database, FilePlus2, FolderOpen, Lock, Moon, Play, Plus, RefreshCw, Save, Search, Settings2, Square, Sun, Table2, Trash2, Unplug, X, Zap } from 'lucide-react'
import type { Connection, MySQLConnection, PendingChange, QueryResult, Structure, TableInfo } from '../shared/types'
import './styles.css'

type Tab = { id: string; kind: 'table' | 'structure' | 'query'; title: string; table?: string; sql?: string; connectionId: string; database?: string }
type TableContext = { tabId: string; connectionId: string; table: string; database?: string }
type Toast = { type: 'success' | 'error' | 'info'; text: string }
type ContextMenu = { x: number; y: number; tabId: string }

const uid = () => crypto.randomUUID()
const formatValue = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [connected, setConnected] = useState<string[]>([])
  const [disconnecting, setDisconnecting] = useState<string[]>([])
  const disconnectingRef = useRef(new Set<string>())
  const [deleting, setDeleting] = useState<string[]>([])
  const deletingRef = useRef(new Set<string>())
  const deletedConnectionIdsRef = useRef(new Set<string>())
  const [connecting, setConnecting] = useState<string[]>([])
  const connectingRef = useRef(new Set<string>())
  const [schema, setSchema] = useState<Record<string, TableInfo[]>>({})
  const [mysqlDatabases, setMysqlDatabases] = useState<Record<string, string[]>>({})
  const [selectedDatabase, setSelectedDatabase] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [connectionInfoExpanded, setConnectionInfoExpanded] = useState<Record<string, boolean>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const tabsRef = useRef<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [sqlText, setSqlText] = useState('SELECT name, type FROM sqlite_master WHERE type IN (\'table\', \'view\') ORDER BY type, name;')
  const [sqlByTab, setSqlByTab] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, QueryResult>>({})
  const [structures, setStructures] = useState<Record<string, Structure>>({})
  const [pending, setPending] = useState<Record<string, PendingChange[]>>({})
  const [loading, setLoading] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [toast, setToast] = useState<Toast | null>(null)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ column?: string; direction?: 'asc' | 'desc' }>({})
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const sqlExecutingRef = useRef(false)
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false)
  const [connectionSubmenuOpen, setConnectionSubmenuOpen] = useState(false)
  const connectionMenuRef = useRef<HTMLDivElement>(null)
  const connectionMenuButtonRef = useRef<HTMLButtonElement>(null)
  const connectionMenuItems = useRef<Record<string, HTMLButtonElement | null>>({})
  const [showMySQL, setShowMySQL] = useState(false)
  const [editingMySQLId, setEditingMySQLId] = useState<string | null>(null)
  const [mysqlForm, setMysqlForm] = useState({ name: 'MySQL 连接', host: '127.0.0.1', port: '3306', user: 'root', password: '', rememberPassword: false, tls: true, caPath: '' })

  useEffect(() => { window.sqlConnect.settings.load().then(setConnections); const saved = localStorage.getItem('sql-connect-theme') as 'dark' | 'light' | null; if (saved) setTheme(saved) }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('sql-connect-theme', theme) }, [theme])
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 3800); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', onKeyDown); document.removeEventListener('scroll', close, true) }
  }, [contextMenu])
  useEffect(() => {
    if (!connectionMenuOpen) return
    const close = (event: MouseEvent) => { if (!connectionMenuRef.current?.contains(event.target as Node)) { setConnectionMenuOpen(false); setConnectionSubmenuOpen(false) } }
    const onBlur = () => { setConnectionMenuOpen(false); setConnectionSubmenuOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setConnectionMenuOpen(false); setConnectionSubmenuOpen(false); connectionMenuButtonRef.current?.focus(); return }
      if (event.key === 'Enter') {
        const option = (document.activeElement as HTMLElement | null)?.dataset.connectionOption
        if (option === 'sqlite') openSQLiteSubmenu()
        else if (option === 'mysql') openMySQLDialog()
        else if (option === 'sqlite-create') chooseSQLite(true)
        else if (option === 'sqlite-open') chooseSQLite(false)
        if (option) { event.preventDefault(); return }
      }
      if (event.key === 'ArrowRight' && !connectionSubmenuOpen) { event.preventDefault(); setConnectionSubmenuOpen(true); return }
      if (event.key === 'ArrowLeft' && connectionSubmenuOpen) { event.preventDefault(); setConnectionSubmenuOpen(false); connectionMenuItems.current.sqlite?.focus(); return }
      if (!connectionSubmenuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); const next = event.key === 'ArrowDown' ? 'mysql' : 'sqlite'; connectionMenuItems.current[next]?.focus()
      }
      if (connectionSubmenuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); const next = event.key === 'ArrowDown' ? 'open' : 'new'; connectionMenuItems.current[next]?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', onBlur); window.removeEventListener('keydown', onKeyDown) }
  }, [connectionMenuOpen, connectionSubmenuOpen])
  useEffect(() => {
    if (!connectionMenuOpen) return
    const key = connectionSubmenuOpen ? 'new' : 'sqlite'
    requestAnimationFrame(() => connectionMenuItems.current[key]?.focus())
  }, [connectionMenuOpen, connectionSubmenuOpen])
  const active = tabs.find(t => t.id === activeTab)
  const activeConnection = active?.connectionId || connected[0] || ''
  const activeDatabase = active?.database || selectedDatabase[activeConnection] || ''

  const persist = async (next: Connection[]) => { try { const saved = await window.sqlConnect.settings.save(next); setConnections(saved); return true } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false } }
  const notify = (text: string, type: Toast['type'] = 'info') => setToast({ text, type })

  async function addConnection(create = false) {
    const path = create ? await window.sqlConnect.dialog.saveFile() : await window.sqlConnect.dialog.openFile()
    if (!path) return
    const name = path.split('/').pop()?.replace(/\.(sqlite|sqlite3|db)$/i, '') || 'SQLite 数据库'
    const item: Connection = { id: uid(), name, path, readonly: false, create }
    await connect(item)
  }
  async function connect(item: Connection) {
    if (connectingRef.current.has(item.id)) return false
    deletedConnectionIdsRef.current.delete(item.id)
    connectingRef.current.add(item.id)
    setConnecting(v => [...new Set([...v, item.id])])
    setLoading(true)
    try {
      const result = await window.sqlConnect.db.connect(item)
      const saved = result.connection
      setConnected(v => [...new Set([...v, saved.id])])
      setExpanded(v => ({ ...v, [saved.id]: true }))
      setConnectionInfoExpanded(v => ({ ...v, [saved.id]: false }))
      const nextConnections = connections.some(c => c.id === saved.id) ? connections.map(c => c.id === saved.id ? saved : c) : [...connections, saved]
      const persisted = await window.sqlConnect.settings.save(nextConnections)
      setConnections(persisted)
      if (saved.type === 'mysql') {
        const names = await window.sqlConnect.db.databases(saved.id)
        setMysqlDatabases(v => ({ ...v, [saved.id]: names }))
        const db = saved.database || names[0]
        if (db) { setSelectedDatabase(v => ({ ...v, [saved.id]: db })); await loadSchema(saved.id, db) }
      } else {
        const items = await window.sqlConnect.db.schema(saved.id)
        setSchema(v => ({ ...v, [saved.id]: items }))
      }
      notify(result.reused ? '该连接已存在，已复用现有连接' : `已连接 ${saved.name}`, result.reused ? 'info' : 'success')
      return true
    } catch (error) {
      if (item.type === 'mysql' && !item.password) {
        setEditingMySQLId(item.id)
        setMysqlForm({ name: item.name, host: item.host, port: String(item.port), user: item.user, password: '', rememberPassword: !!item.rememberPassword, tls: item.tls !== false, caPath: item.caPath || '' })
        setShowMySQL(true)
      }
      notify(errorText(error), 'error')
      return false
    } finally {
      connectingRef.current.delete(item.id)
      setConnecting(v => v.filter(id => id !== item.id))
      setLoading(false)
    }
  }
  async function loadSchema(connectionId: string, database?: string) { try { const items = await window.sqlConnect.db.schema(connectionId, database); if (!deletedConnectionIdsRef.current.has(connectionId)) setSchema(v => ({ ...v, [`${connectionId}|${database || ''}`]: items })) } catch (error) { if (!deletedConnectionIdsRef.current.has(connectionId)) notify(error instanceof Error ? error.message : String(error), 'error') } }
  async function addMySQL() { const item: MySQLConnection = { type: 'mysql', id: editingMySQLId || uid(), name: mysqlForm.name.trim() || 'MySQL 连接', host: mysqlForm.host.trim(), port: Number(mysqlForm.port) || 3306, user: mysqlForm.user.trim(), password: mysqlForm.password, rememberPassword: mysqlForm.rememberPassword, tls: mysqlForm.tls, caPath: mysqlForm.caPath || undefined }; const ok = await connect(item); if (ok) { setEditingMySQLId(null); setShowMySQL(false) } }
  async function toggleConnection(item: Connection) {
    if (disconnectingRef.current.has(item.id) || connectingRef.current.has(item.id)) return
    const willExpand = !expanded[item.id]
    setExpanded(v => ({ ...v, [item.id]: willExpand }))
    if (willExpand && connected.includes(item.id) && item.type === 'mysql' && !mysqlDatabases[item.id]) {
      try {
        const names = await window.sqlConnect.db.databases(item.id)
        if (!deletedConnectionIdsRef.current.has(item.id)) setMysqlDatabases(v => ({ ...v, [item.id]: names }))
        if (names[0]) { setSelectedDatabase(v => ({ ...v, [item.id]: names[0] })); await loadSchema(item.id, names[0]) }
      } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    }
  }
  function removeConnectionState(id: string) {
    const targetTabs = tabsRef.current.filter(tab => tab.connectionId === id)
    const firstIndex = tabsRef.current.findIndex(tab => tab.connectionId === id)
    const remaining = tabsRef.current.filter(tab => tab.connectionId !== id)
    const activeWillClose = activeTab ? targetTabs.some(tab => tab.id === activeTab) : false
    const nextActive = !activeWillClose ? activeTab : remaining[Math.min(Math.max(firstIndex, 0), remaining.length - 1)]?.id || remaining[Math.max(0, firstIndex - 1)]?.id || null
    setConnected(v => v.filter(item => item !== id))
    setExpanded(v => ({ ...v, [id]: true }))
    setSelectedDatabase(v => { const copy = { ...v }; delete copy[id]; return copy })
    setSchema(v => { const copy = { ...v }; Object.keys(copy).filter(k => k === id || k.startsWith(`${id}|`)).forEach(k => delete copy[k]); return copy })
    setMysqlDatabases(v => { const copy = { ...v }; delete copy[id]; return copy })
    setTabs(remaining); tabsRef.current = remaining; setActiveTab(nextActive)
    setResults(current => { const next = { ...current }; targetTabs.forEach(tab => delete next[tab.id]); return next })
    setStructures(current => { const next = { ...current }; targetTabs.forEach(tab => delete next[tab.id]); return next })
    setPending(current => { const next = { ...current }; targetTabs.forEach(tab => delete next[tab.id]); return next })
    setSqlByTab(current => { const next = { ...current }; targetTabs.forEach(tab => delete next[tab.id]); return next })
    if (nextActive) { const nextTab = remaining.find(tab => tab.id === nextActive); if (nextTab?.kind === 'query') setSqlText(sqlByTab[nextActive] ?? nextTab.sql ?? '') }
  }
  async function disconnect(id: string): Promise<boolean> {
    if (disconnectingRef.current.has(id)) return false
    const targetTabs = tabsRef.current.filter(tab => tab.connectionId === id)
    const dirtyTabs = targetTabs.filter(tab => (pending[tab.id] || []).length > 0)
    if (dirtyTabs.length > 0) {
      const names = dirtyTabs.map(tab => `• ${tab.title}`).join('\n')
      if (!window.confirm(`以下标签有未提交修改，断开后将放弃：\n${names}\n\n确定放弃修改并断开吗？`)) return false
    }
    disconnectingRef.current.add(id)
    setDisconnecting(v => [...new Set([...v, id])])
    try {
      const connection = connections.find(item => item.id === id)
      if (connection?.type === 'mysql') await Promise.all(targetTabs.filter(tab => tab.kind === 'query').map(tab => window.sqlConnect.db.closeSession(id, tab.id).catch(() => undefined)))
      await window.sqlConnect.db.disconnect(id)
      removeConnectionState(id)
      notify('连接已断开')
      return true
    } catch (error) {
      notify(errorText(error), 'error')
      return false
    } finally {
      disconnectingRef.current.delete(id)
      setDisconnecting(v => v.filter(item => item !== id))
    }
  }
  async function deleteConnection(item: Connection) {
    if (deletingRef.current.has(item.id) || connectingRef.current.has(item.id) || disconnectingRef.current.has(item.id)) return
    const targetTabs = tabsRef.current.filter(tab => tab.connectionId === item.id)
    const dirtyTabs = targetTabs.filter(tab => (pending[tab.id] || []).length > 0)
    const dirtyList = dirtyTabs.length ? `\n\n以下标签有未提交修改，确认后将放弃：\n${dirtyTabs.map(tab => `• ${tab.title}`).join('\n')}` : ''
    const isConnected = connected.includes(item.id)
    const message = `确定删除已保存的连接“${item.name}”吗？${dirtyList}\n\n这只会删除连接配置${isConnected ? '并断开该连接' : ''}，不会删除 SQLite 文件或 MySQL 数据。`
    if (!window.confirm(message)) return
    deletingRef.current.add(item.id)
    setDeleting(v => [...new Set([...v, item.id])])
    try {
      const result = await window.sqlConnect.settings.remove(item.id)
      if (!result.ok) throw new Error(result.error)
      deletedConnectionIdsRef.current.add(item.id)
      removeConnectionState(item.id)
      setConnections(await window.sqlConnect.settings.load())
      setExpanded(v => { const next = { ...v }; delete next[item.id]; return next })
      setConnectionInfoExpanded(v => { const next = { ...v }; delete next[item.id]; return next })
      notify(`已删除连接 ${item.name}`, 'success')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      deletingRef.current.delete(item.id)
      setDeleting(v => v.filter(id => id !== item.id))
    }
  }
  async function toggleReadonly(item: Connection) {
    if (disconnectingRef.current.has(item.id)) return
    const next = { ...item, readonly: !item.readonly }
    const wasConnected = connected.includes(item.id)
    if (wasConnected) {
      const ok = await disconnect(item.id)
      if (!ok) return
    }
    const saved = await persist(connections.map(connection => connection.id === item.id ? next : connection))
    if (saved && wasConnected && item.type !== 'mysql' && !disconnectingRef.current.has(item.id)) await connect(next)
  }
  async function openTable(connectionId: string, item: TableInfo, kind: Tab['kind'] = 'table', database?: string) {
    const id = `${connectionId}:${database || ''}:${kind}:${item.name}`; const nextTab: Tab = { id, kind, title: item.name, table: item.name, connectionId, database }; setTabs(v => { const next = v.some(t => t.id === id) ? v : [...v, nextTab]; tabsRef.current = next; return next }); setActiveTab(id); setPage(0); setFilter(''); setSort({})
    if (kind === 'structure') { if (!structures[id]) setStructures(v => ({ ...v, [id]: undefined as never })); try { const structure = await window.sqlConnect.db.structure(connectionId, item.name, database); if (tabsRef.current.some(t => t.id === id)) setStructures(v => ({ ...v, [id]: structure })) } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } }
    else await refreshTable({ tabId: id, connectionId, table: item.name, database }, { offset: 0, filter: '', orderBy: undefined, direction: undefined })
  }
  async function refreshTable(context: TableContext, options: { offset?: number; filter?: string; orderBy?: string; direction?: 'asc' | 'desc' } = {}) { setLoading(true); try { const data = await window.sqlConnect.db.query(context.connectionId, context.table, { offset: options.offset ?? page * 100, limit: 100, orderBy: 'orderBy' in options ? options.orderBy : sort.column, direction: 'direction' in options ? options.direction : sort.direction, filter: options.filter ?? filter, database: context.database }); if (tabsRef.current.some(t => t.id === context.tabId)) setResults(v => ({ ...v, [context.tabId]: data })) } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } finally { setLoading(false) } }
  async function runSql(sqlOverride?: string) { const text = (sqlOverride ?? sqlText).trim(); if (!text || !activeConnection || loading || sqlExecutingRef.current) return; sqlExecutingRef.current = true; const id = `${activeConnection}:${activeDatabase || ''}:query:${uid()}`; const title = text.split(/\s+/).slice(0, 4).join(' '); const queryTab: Tab = { id, kind: 'query', title, sql: text, connectionId: activeConnection, database: activeDatabase || undefined }; setTabs(v => { const next = [...v, queryTab]; tabsRef.current = next; return next }); setSqlByTab(v => ({ ...v, [id]: text })); setActiveTab(id); setLoading(true); try { const data = await window.sqlConnect.db.execute(activeConnection, text, id, activeDatabase || undefined); if (tabsRef.current.some(t => t.id === id)) setResults(v => ({ ...v, [id]: data })); notify(data.changes !== undefined ? `执行成功，影响 ${data.changes} 行` : `查询完成，用时 ${data.elapsedMs} ms`, 'success') } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } finally { sqlExecutingRef.current = false; setLoading(false) } }
  function updateCell(tabId: string, row: Record<string, unknown>, column: string, value: string) { const tab = tabs.find(t => t.id === tabId); if (!tab?.table) return; const key = String(row.__sqlconnect_rowid ?? JSON.stringify(row)); setResults(v => ({ ...v, [tabId]: { ...v[tabId], rows: v[tabId].rows.map(r => String(r.__sqlconnect_rowid ?? JSON.stringify(r)) === key ? { ...r, [column]: value } : r) } })); setPending(v => ({ ...v, [tabId]: [...(v[tabId] || []).filter(c => !(c.type === 'update' && String(c.rowid) === String(row.__sqlconnect_rowid))), { type: 'update', table: tab.table!, rowid: row.__sqlconnect_rowid as string | number, values: { [column]: value }, original: { [column]: row[column] } }] })) }
  function addRow(tabId: string) { const tab = tabs.find(t => t.id === tabId); const result = results[tabId]; if (!tab?.table || !result) return; const row = Object.fromEntries(result.columns.filter(c => c !== '__sqlconnect_rowid').map(c => [c, null])); setResults(v => ({ ...v, [tabId]: { ...v[tabId], rows: [...v[tabId].rows, row] } })); setPending(v => ({ ...v, [tabId]: [...(v[tabId] || []), { type: 'insert', table: tab.table!, values: row }] })) }
  function deleteRow(tabId: string, row: Record<string, unknown>) { const tab = tabs.find(t => t.id === tabId); if (!tab?.table) return; setResults(v => ({ ...v, [tabId]: { ...v[tabId], rows: v[tabId].rows.filter(r => r !== row) } })); setPending(v => ({ ...v, [tabId]: [...(v[tabId] || []), { type: 'delete', table: tab.table!, rowid: row.__sqlconnect_rowid as string | number, values: {}, original: row }] })) }
  async function commit(tabId: string) { const changes = pending[tabId] || []; if (!changes.length) return; const tab = tabsRef.current.find(t => t.id === tabId); if (!tab?.table) return; setLoading(true); try { await window.sqlConnect.db.apply(tab.connectionId, changes); setPending(v => ({ ...v, [tabId]: [] })); notify(`已提交 ${changes.length} 项修改`, 'success'); await refreshTable({ tabId, connectionId: tab.connectionId, table: tab.table, database: tab.database }) } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } finally { setLoading(false) } }
  function discard(tabId: string) { setPending(v => ({ ...v, [tabId]: [] })); const tab = tabsRef.current.find(t => t.id === tabId); if (tab?.table) void refreshTable({ tabId, connectionId: tab.connectionId, table: tab.table, database: tab.database }) }
  function closeTabs(ids: string[], preferredId?: string) {
    const closeIds = new Set(ids)
    const targetTabs = tabs.filter(tab => closeIds.has(tab.id))
    if (!targetTabs.length) { setContextMenu(null); return }
    const dirtyTabs = targetTabs.filter(tab => (pending[tab.id] || []).length > 0)
    if (dirtyTabs.length > 0) {
      const names = dirtyTabs.map(tab => `• ${tab.title}`).join('\n')
      if (!window.confirm(`以下标签有未提交修改，关闭后将放弃：\n${names}\n\n确定放弃修改并关闭吗？`)) { setContextMenu(null); return }
    }
    const firstIndex = tabs.findIndex(tab => closeIds.has(tab.id))
    const remaining = tabs.filter(tab => !closeIds.has(tab.id))
    for (const tab of targetTabs) if (tab.kind === 'query' && connections.find(c => c.id === tab.connectionId)?.type === 'mysql') void window.sqlConnect.db.closeSession(tab.connectionId, tab.id)
    const activeWillClose = activeTab ? closeIds.has(activeTab) : false
    const nextActive = !activeWillClose ? activeTab : preferredId && remaining.some(tab => tab.id === preferredId) ? preferredId : remaining[Math.min(firstIndex, remaining.length - 1)]?.id || remaining[Math.max(0, firstIndex - 1)]?.id || null
    setTabs(remaining); tabsRef.current = remaining; setActiveTab(nextActive)
    setResults(current => { const next = { ...current }; closeIds.forEach(id => delete next[id]); return next })
    setStructures(current => { const next = { ...current }; closeIds.forEach(id => delete next[id]); return next })
    setPending(current => { const next = { ...current }; closeIds.forEach(id => delete next[id]); return next })
    setSqlByTab(current => { const next = { ...current }; closeIds.forEach(id => delete next[id]); return next })
    if (nextActive) { const nextTab = remaining.find(tab => tab.id === nextActive); if (nextTab?.kind === 'query') setSqlText(sqlByTab[nextActive] ?? nextTab.sql ?? '') }
    setContextMenu(null)
  }
  function closeTab(id: string) { closeTabs([id], id) }
  function openTabContextMenu(event: React.MouseEvent, tabId: string) {
    event.preventDefault()
    const width = 190; const height = 136
    setContextMenu({ tabId, x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)) })
  }
  function contextIds(mode: 'left' | 'right' | 'others') {
    if (!contextMenu) return []
    const index = tabs.findIndex(tab => tab.id === contextMenu.tabId)
    if (index < 0) return []
    if (mode === 'left') return tabs.slice(0, index).map(tab => tab.id)
    if (mode === 'right') return tabs.slice(index + 1).map(tab => tab.id)
    return tabs.filter(tab => tab.id !== contextMenu.tabId).map(tab => tab.id)
  }
  const result = activeTab ? results[activeTab] : undefined
  const activeChanges = activeTab ? pending[activeTab] || [] : []
  const newQuery = () => { const connectionId = connected[0]; if (!connectionId) { notify('请先连接数据库', 'info'); return } const database = selectedDatabase[connectionId]; const id = `${connectionId}:${database || ''}:query:${uid()}`; const tab: Tab = { id, kind: 'query', title: 'SQL 查询', sql: '', connectionId, database }; setTabs(v => { const next = [...v, tab]; tabsRef.current = next; return next }); setSqlByTab(v => ({ ...v, [id]: '' })); setActiveTab(id); setSqlText('') }
  const handleSqlChange = (value: string) => { setSqlText(value); if (activeTab) setSqlByTab(v => ({ ...v, [activeTab]: value })) }
  const closeConnectionMenu = () => { setConnectionMenuOpen(false); setConnectionSubmenuOpen(false) }
  const openSQLiteSubmenu = () => setConnectionSubmenuOpen(true)
  const openMySQLDialog = () => { closeConnectionMenu(); setEditingMySQLId(null); setShowMySQL(true) }
  const chooseSQLite = (create: boolean) => { closeConnectionMenu(); void addConnection(create) }

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Database size={18}/></div><span>SQL Connect</span><span className="version">SQLite · MySQL</span></div><div className="top-actions"><button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="切换主题">{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</button><button className="icon-btn" title="设置"><Settings2 size={17}/></button></div></header>
    <div className="main-layout">
      <aside className="sidebar">
        <div className="sidebar-head"><div><div className="eyebrow">WORKSPACE</div><h2>新建连接</h2></div><div className="connection-menu-anchor" ref={connectionMenuRef}><button ref={connectionMenuButtonRef} className="icon-btn accent connection-menu-button" onClick={() => { if (connectionMenuOpen) closeConnectionMenu(); else { setConnectionSubmenuOpen(false); setConnectionMenuOpen(true) } }} title="新建连接" aria-label="新建连接" aria-expanded={connectionMenuOpen}><Plus size={18}/></button>{connectionMenuOpen && <div className="connection-menu" role="menu"><div className="connection-menu-panel"><button ref={element => { connectionMenuItems.current.sqlite = element }} className={`connection-menu-item ${connectionSubmenuOpen ? 'selected' : ''}`} data-connection-option="sqlite" role="menuitem" onClick={openSQLiteSubmenu}><Database size={15}/><span>SQLite</span><ChevronRight size={14} className="connection-menu-arrow"/></button><button ref={element => { connectionMenuItems.current.mysql = element }} className="connection-menu-item" data-connection-option="mysql" role="menuitem" onClick={openMySQLDialog}><Database size={15}/><span>MySQL</span></button></div>{connectionSubmenuOpen && <div className="connection-submenu" role="menu"><button ref={element => { connectionMenuItems.current.new = element }} className="connection-menu-item" data-connection-option="sqlite-create" role="menuitem" onClick={() => chooseSQLite(true)}><FilePlus2 size={15}/><span>新建 SQLite</span></button><button ref={element => { connectionMenuItems.current.open = element }} className="connection-menu-item" data-connection-option="sqlite-open" role="menuitem" onClick={() => chooseSQLite(false)}><FolderOpen size={15}/><span>打开 SQLite</span></button></div>}</div>}</div></div>
        <div className="connection-list">
          {connections.length === 0 && <div className="empty-connect"><Database size={28}/><p>还没有连接</p><span>打开 SQLite 或连接 MySQL</span></div>}
          {connections.map(item => {
            const isConnected = connected.includes(item.id)
            const isDisconnecting = disconnecting.includes(item.id)
            const isConnecting = connecting.includes(item.id)
            const isDeleting = deleting.includes(item.id)
            return <div className="connection-block" key={item.id}>
              <div className="connection-row">
                <button className="connection-main" disabled={isDisconnecting || isConnecting || isDeleting} onClick={() => void toggleConnection(item)} aria-expanded={!!expanded[item.id]} aria-label={`${item.name} ${isConnected ? '在线' : '离线'}`}>
                  <span className="chevron">{expanded[item.id] ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</span>
                  <CircleDot size={13} className={isConnected ? 'connected-dot' : 'offline-dot'}/>
                  <span className="tree-label">{item.name}</span>
                  <span className="object-type">{item.type === 'mysql' ? 'MYSQL' : 'SQLITE'}</span>
                  {isConnected && <span className="connected-label">在线</span>}
                </button>
                <div className="connection-actions">
                  {item.type !== 'mysql' && <button className="readonly-control" type="button" disabled={isDisconnecting || isConnecting || isDeleting} title={item.readonly ? '只读连接' : '读写连接'} aria-label={item.readonly ? '只读连接' : '读写连接'} onClick={() => void toggleReadonly(item)}>{item.readonly ? <Lock size={12}/> : <span>RW</span>}</button>}
                  {isConnected ? <button className="disconnect-control" type="button" disabled={isDisconnecting || isConnecting || isDeleting} title="断开连接" aria-label="断开连接" onClick={() => void disconnect(item.id)}><Unplug size={14}/></button> : <span className="disconnect-slot" aria-hidden="true"/>}
                </div>
              </div>
              {expanded[item.id] && <div className="connection-expanded">
                {isConnected ? <div className="connection-info-row"><button className="connection-info-toggle" type="button" aria-expanded={!!connectionInfoExpanded[item.id]} onClick={() => setConnectionInfoExpanded(v => ({ ...v, [item.id]: !v[item.id] }))}><span className="chevron">{connectionInfoExpanded[item.id] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>连接信息</button><button className="delete-connection-btn" type="button" disabled={isDeleting || isDisconnecting} aria-label={`删除连接 ${item.name}`} onClick={() => void deleteConnection(item)}><Trash2 size={13}/>删除</button></div> : null}
                {(!isConnected || connectionInfoExpanded[item.id]) && <ConnectionDetails connection={item}/>}
                {!isConnected && <div className="saved-connection-actions"><button className="connect-saved-btn" type="button" disabled={isConnecting || isDisconnecting || isDeleting} aria-label={`连接 ${item.name}`} onClick={() => void connect(item)}>{isConnecting ? <><Activity size={14} className="spin"/>连接中…</> : <><Play size={14} fill="currentColor"/>连接</>}</button><button className="delete-connection-btn" type="button" disabled={isDeleting || isConnecting || isDisconnecting} aria-label={`删除连接 ${item.name}`} onClick={() => void deleteConnection(item)}><Trash2 size={13}/>删除</button></div>}
                {isConnected && <div className="connection-database-tree">
                  {item.type === 'mysql' ? <>
                    <div className="tree-section-label">数据库</div>
                    {(mysqlDatabases[item.id] || []).map(database => <div key={database}>
                      <button className="tree-row" onClick={() => { setSelectedDatabase(v => ({ ...v, [item.id]: database })); void loadSchema(item.id, database) }}>
                        <span className="chevron">{selectedDatabase[item.id] === database ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span><Database size={13}/><span className="tree-label">{database}</span>
                      </button>
                      {selectedDatabase[item.id] === database && <div className="tree-children"><div className="tree-section-label">表和视图</div>{(schema[`${item.id}|${database}`] || []).map(table => <div className="object-row" key={table.name}>
                        <button onClick={() => void openTable(item.id, table, 'table', database)}><Table2 size={14}/><span>{table.name}</span><span className="object-type">{table.type === 'view' ? 'VIEW' : 'TABLE'}</span></button>
                        <button className="structure-btn" onClick={() => void openTable(item.id, table, 'structure', database)} title="查看结构"><Settings2 size={13}/></button>
                      </div>)}</div>}
                    </div>)}
                  </> : <><div className="tree-section-label">表和视图</div>{(schema[item.id] || []).map(table => <div className="object-row" key={table.name}>
                    <button onClick={() => void openTable(item.id, table)}><Table2 size={14}/><span>{table.name}</span><span className="object-type">{table.type === 'view' ? 'VIEW' : 'TABLE'}</span></button>
                    <button className="structure-btn" onClick={() => void openTable(item.id, table, 'structure')} title="查看结构"><Settings2 size={13}/></button>
                  </div>)}</>}
                </div>}
              </div>}
            </div>
          })}
        </div>
      </aside>
      <main className="workspace">
        <div className="tabbar">{tabs.length === 0 && <div className="tabbar-placeholder">选择一个表，或打开 SQL 查询</div>}{tabs.map(tab => <button className={`tab ${tab.id === activeTab ? 'active' : ''}`} key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.kind === 'query') setSqlText(sqlByTab[tab.id] ?? tab.sql ?? '') }} onContextMenu={event => openTabContextMenu(event, tab.id)}><span className="tab-dot">{tab.kind === 'query' ? <Zap size={12}/> : tab.kind === 'structure' ? <Settings2 size={12}/> : <Table2 size={12}/>}</span><span>{tab.title}</span><X size={13} onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}/></button>)}<button className="new-query" onClick={newQuery}><Plus size={15}/>SQL</button></div>
        <div className="content-area">{active?.kind === 'structure' && <StructureView structure={structures[active.id]} />}{active?.kind === 'table' && result && <DataView tab={active} result={result} readonly={connections.find(c => c.id === activeConnection)?.readonly || connections.find(c => c.id === activeConnection)?.type === 'mysql'} filter={filter} setFilter={setFilter} page={page} setPage={setPage} sort={sort} setSort={setSort} onRefresh={() => active.table && void refreshTable({ tabId: active.id, connectionId: active.connectionId, table: active.table, database: active.database })} onEdit={updateCell} onAdd={() => addRow(active.id)} onDelete={deleteRow} changes={activeChanges} onCommit={() => void commit(active.id)} onDiscard={() => discard(active.id)} />}{active?.kind === 'query' && <QueryView sql={sqlText} setSql={handleSqlChange} onRun={runSql} loading={loading} result={result} database={activeDatabase} databases={mysqlDatabases[activeConnection] || []} dialect={connections.find(c => c.id === activeConnection)?.type === 'mysql' ? 'mysql' : 'sqlite'} setDatabase={database => { setSelectedDatabase(v => ({ ...v, [activeConnection]: database })); setTabs(v => v.map(t => t.id === active.id ? { ...t, database } : t)) }} />}</div>
        <footer className="statusbar"><span><span className={`status-dot ${loading ? 'busy' : ''}`}></span>{loading ? '正在执行…' : activeConnection ? '已就绪' : '未连接数据库'}</span>{activeConnection && <span className="status-path">{connections.find(c => c.id === activeConnection)?.type === 'mysql' ? `${(connections.find(c => c.id === activeConnection) as MySQLConnection).host}:${(connections.find(c => c.id === activeConnection) as MySQLConnection).port}` : (connections.find(c => c.id === activeConnection) as any)?.path}</span>}<span className="status-spacer"/><span>UTF-8</span><span>SQL Connect 1.0</span></footer>
      </main>
    </div>
    {contextMenu && <div className="tab-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}><button disabled={!contextIds('left').length} onClick={() => closeTabs(contextIds('left'), contextMenu.tabId)}>关闭左侧窗口</button><button disabled={!contextIds('right').length} onClick={() => closeTabs(contextIds('right'), contextMenu.tabId)}>关闭右侧窗口</button><button disabled={!contextIds('others').length} onClick={() => closeTabs(contextIds('others'), contextMenu.tabId)}>关闭其他窗口</button></div>}
    {showMySQL && <MySQLDialog form={mysqlForm} setForm={setMysqlForm} onCancel={() => setShowMySQL(false)} onConnect={() => void addMySQL()} onPickCertificate={async () => { const path = await window.sqlConnect.dialog.openCertificate(); if (path) setMysqlForm(v => ({ ...v, caPath: path })) }} />}
    {toast && <div className={`toast ${toast.type}`}><span>{toast.type === 'success' ? <Check size={16}/> : toast.type === 'error' ? <AlertCircle size={16}/> : <Activity size={16}/>}</span>{toast.text}</div>}
  </div>
}

function ConnectionDetails({ connection }: { connection: Connection }) {
  const details: Array<[string, string]> = connection.type === 'mysql'
    ? [
        ['主机', connection.host],
        ['端口', String(connection.port)],
        ['用户名', connection.user],
        ['TLS', connection.tls === false ? '未启用' : '已启用'],
        ['CA 证书', connection.caPath || '未配置']
      ]
    : [
        ['文件路径', connection.path],
        ['访问权限', connection.readonly ? '只读' : '读写']
      ]
  return <dl className="connection-details" aria-label="连接信息">{details.map(([label, value]) => <div className="connection-detail" key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
}

function DataView({ tab, result, readonly, filter, setFilter, page, setPage, sort, setSort, onRefresh, onEdit, onAdd, onDelete, changes, onCommit, onDiscard }: any) { const columns = result.columns.filter((c: string) => c !== '__sqlconnect_rowid'); return <div className="panel"><div className="panel-head"><div><div className="eyebrow">DATA TABLE</div><h1>{tab.table}</h1></div><div className="panel-actions"><div className="search-box"><Search size={15}/><input value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => e.key === 'Enter' && onRefresh()} placeholder="筛选当前表…"/></div><button className="toolbar-btn" onClick={onRefresh}><RefreshCw size={15}/>刷新</button>{changes.length > 0 && !readonly && <><button className="toolbar-btn danger" onClick={onDiscard}><X size={15}/>放弃</button><button className="toolbar-btn primary" onClick={onCommit}><Save size={15}/>提交 {changes.length}</button></>}</div></div><div className="table-wrap"><table><thead><tr><th className="row-number">#</th>{columns.map((column: string) => <th key={column} onClick={() => setSort({ column, direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc' })}>{column}<span className="sort-indicator">{sort.column === column ? sort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></th>)}<th></th></tr></thead><tbody>{result.rows.map((row: Record<string, unknown>, index: number) => <tr key={String(row.__sqlconnect_rowid ?? index)}><td className="row-number">{page * 100 + index + 1}</td>{columns.map((column: string) => <td key={column}><input disabled={readonly} className={changes.some((c: PendingChange) => c.type === 'update' && c.rowid === row.__sqlconnect_rowid && c.values[column] !== undefined) ? 'dirty-cell' : ''} value={row[column] === null ? '' : String(row[column] ?? '')} placeholder={row[column] === null ? 'NULL' : ''} onChange={e => onEdit(tab.id, row, column, e.target.value)}/></td>)}<td>{!readonly && <button className="row-delete" onClick={() => onDelete(tab.id, row)}><Trash2 size={14}/></button>}</td></tr>)}{!result.rows.length && <tr><td colSpan={columns.length + 2} className="no-rows">没有数据</td></tr>}</tbody></table></div><div className="table-footer"><span>{result.total ?? result.rows.length} 行{result.truncated ? ' · 已显示前 1000 行' : ''}</span><span className="footer-spacer"/>{!readonly && <button className="add-row" onClick={onAdd}><Plus size={14}/>新增行</button>}<button className="page-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页</span><button className="page-btn" disabled={result.rows.length < 100} onClick={() => setPage(page + 1)}>下一页</button></div></div> }

function StructureView({ structure }: { structure?: Structure }) { if (!structure) return <div className="loading-state"><Activity className="spin"/>正在读取结构…</div>; return <div className="panel structure-panel"><div className="panel-head"><div><div className="eyebrow">SCHEMA</div><h1>表结构</h1></div><span className={`badge ${structure.editable ? 'green' : 'gray'}`}>{structure.editable ? '可编辑' : '只读'}</span></div><h3>字段</h3><div className="structure-table"><table><thead><tr><th>名称</th><th>类型</th><th>非空</th><th>默认值</th><th>主键</th></tr></thead><tbody>{structure.columns.map(c => <tr key={c.name}><td className="mono">{c.name}</td><td>{c.type || '—'}</td><td>{c.notnull ? '是' : '否'}</td><td className="mono">{c.dflt_value || '—'}</td><td>{c.pk ? <span className="key-pill">PK {c.pk}</span> : '—'}</td></tr>)}</tbody></table></div><h3>建表 SQL</h3><pre className="sql-preview">{structure.sql || '没有可用的建表 SQL'}</pre>{structure.indexes.length > 0 && <><h3>索引</h3><div className="index-list">{structure.indexes.map((i: any) => <span key={i.name} className="index-pill">{i.name}</span>)}</div></>}</div> }

function QueryView({ sql, setSql, onRun, loading, result, database, databases, dialect, setDatabase }: { sql: string; setSql: (value: string) => void; onRun: (sql?: string) => void; loading: boolean; result?: QueryResult; database?: string; databases: string[]; dialect: 'sqlite' | 'mysql'; setDatabase: (database: string) => void }) {
  const extensions = useMemo(() => [sqlLanguage({ dialect: dialect === 'mysql' ? MySQL : SQLite, upperCaseKeywords: true }), autocompletion({ interactionDelay: 0 }), Prec.highest(keymap.of([{ key: 'Tab', run: (view: EditorView) => acceptCompletion(view) || indentWithTab.run?.(view) || false }, { key: 'Mod-Enter', run: (view: EditorView) => { onRun(view.state.doc.toString()); return true } }]))], [dialect, onRun])
  return <div className="query-panel"><div className="query-head"><div><div className="eyebrow">SQL EDITOR</div><h1>查询工作区</h1>{databases.length > 0 && <label className="database-picker">数据库 <select value={database || ''} onChange={event => setDatabase(event.target.value)}><option value="">选择数据库</option>{databases.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}</div><button className="run-btn" onClick={() => onRun(sql)} disabled={loading}><Play size={15} fill="currentColor"/>{loading ? '执行中…' : '执行'} <kbd>⌘ Enter</kbd></button></div><div className="editor-wrap"><CodeMirror value={sql} height="220px" theme={oneDark} extensions={extensions} onChange={setSql} indentWithTab={false} basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }}/></div><div className="result-head"><div><span className="eyebrow">RESULT</span>{result && <span className="result-meta">{result.changes !== undefined ? `${result.changes} 行受影响 · ${result.elapsedMs} ms` : `${result.rows.length} 行 · ${result.elapsedMs} ms${result.truncated ? ' · 已截断' : ''}`}</span>}</div>{loading && <button className="stop-btn"><Square size={13} fill="currentColor"/>停止</button>}</div>{result && <div className="result-table"><table><thead><tr>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{result.columns.map(c => <td key={c} className={row[c] === null ? 'null-value' : ''}>{formatValue(row[c])}</td>)}</tr>)}</tbody></table>{!result.rows.length && result.changes === undefined && <div className="no-rows">查询没有返回数据</div>}</div>}</div>
}

function MySQLDialog({ form, setForm, onCancel, onConnect, onPickCertificate }: { form: any; setForm: (value: any) => void; onCancel: () => void; onConnect: () => void; onPickCertificate: () => void }) {
  const update = (key: string, value: unknown) => setForm({ ...form, [key]: value })
  return <div className="modal-backdrop"><form className="modal-card" onSubmit={event => { event.preventDefault(); onConnect() }}><div className="modal-head"><div><div className="eyebrow">MYSQL CONNECTION</div><h2>连接 MySQL</h2></div><button type="button" className="icon-btn" onClick={onCancel}><X size={17}/></button></div><div className="form-grid"><label>连接名称<input value={form.name} onChange={e => update('name', e.target.value)} /></label><label>主机<input value={form.host} onChange={e => update('host', e.target.value)} required /></label><label>端口<input type="number" min="1" max="65535" value={form.port} onChange={e => update('port', e.target.value)} required /></label><label>用户名<input value={form.user} onChange={e => update('user', e.target.value)} required /></label><label className="form-wide">密码<input type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="仅已保存密码时可留空" /></label><label className="form-wide">CA 证书路径（可选）<span className="certificate-input"><input value={form.caPath} onChange={e => update('caPath', e.target.value)} placeholder="/path/to/ca.pem" /><button type="button" className="toolbar-btn" onClick={onPickCertificate}>选择</button></span></label></div><div className="check-row"><label><input type="checkbox" checked={form.tls} onChange={e => update('tls', e.target.checked)} /> 使用 TLS 并校验证书</label><label><input type="checkbox" checked={form.rememberPassword} onChange={e => update('rememberPassword', e.target.checked)} /> 使用钥匙串加密保存密码</label></div><div className="modal-actions"><button type="button" className="secondary-btn" onClick={onCancel}>取消</button><button type="submit" className="primary-btn">连接</button></div></form></div>
}

createRoot(document.getElementById('root')!).render(<App />)
