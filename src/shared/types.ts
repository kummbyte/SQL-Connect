export type SQLiteConnection = { type?: 'sqlite'; id: string; name: string; path: string; readonly: boolean; lastOpened?: string; create?: boolean }
export type MySQLConnection = {
  type: 'mysql'; id: string; name: string; host: string; port: number; user: string
  database?: string; readonly?: boolean; tls?: boolean; caPath?: string; password?: string
  rememberPassword?: boolean; lastOpened?: string
}
export type Connection = SQLiteConnection | MySQLConnection
export type ConnectResult = { ok: true; connection: Connection; reused: boolean }

export type TableInfo = { name: string; type: 'table' | 'view'; sql?: string }
export type ColumnInfo = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
export type Structure = { columns: ColumnInfo[]; indexes: Record<string, unknown>[]; foreignKeys: Record<string, unknown>[]; sql: string | null; editable: boolean; identity: string | null }
export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; total?: number; truncated?: boolean; elapsedMs: number; changes?: number; lastInsertRowid?: number | bigint }
export type PendingChange = { type: 'insert' | 'update' | 'delete'; table: string; rowid?: number | string; values: Record<string, unknown>; original?: Record<string, unknown> }

export type SqlConnectApi = {
  settings: { load: () => Promise<Connection[]>; save: (connections: Connection[]) => Promise<Connection[]> }
  dialog: { openFile: () => Promise<string | null>; openCertificate: () => Promise<string | null>; saveFile: () => Promise<string | null> }
  db: {
    connect: (connection: Connection) => Promise<ConnectResult>
    disconnect: (connectionId: string) => Promise<boolean>
    databases: (connectionId: string) => Promise<string[]>
    schema: (connectionId: string, database?: string) => Promise<TableInfo[]>
    structure: (connectionId: string, table: string, database?: string) => Promise<Structure>
    query: (connectionId: string, table: string, options: { offset: number; limit: number; orderBy?: string; direction?: 'asc' | 'desc'; filter?: string; database?: string }) => Promise<QueryResult>
    execute: (connectionId: string, sql: string, sessionId?: string, database?: string) => Promise<QueryResult>
    closeSession: (connectionId: string, sessionId: string) => Promise<boolean>
    apply: (connectionId: string, changes: PendingChange[]) => Promise<QueryResult>
    cancel: (connectionId: string) => Promise<boolean>
  }
}
