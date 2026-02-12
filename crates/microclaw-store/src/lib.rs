pub struct Store {
    conn: rusqlite::Connection,
}

impl Store {
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = rusqlite::Connection::open_in_memory()?;
        conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)", [])?;
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
        Ok(Self { conn })
    }

    pub fn schema_version(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| row.get(0))
    }
}
