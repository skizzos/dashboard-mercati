// Persistenza posizioni portafoglio su SQLite locale (file in data/portfolio.db).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'portfolio.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    exchange TEXT,
    name TEXT,
    sector TEXT,
    currency TEXT,
    quantity REAL NOT NULL,
    avg_price REAL NOT NULL,
    buy_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL UNIQUE,
    exchange TEXT,
    name TEXT,
    sector TEXT,
    currency TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function listHoldings() {
  return db.prepare('SELECT * FROM holdings ORDER BY created_at ASC').all();
}

function getHolding(id) {
  return db.prepare('SELECT * FROM holdings WHERE id = ?').get(id);
}

function addHolding(h) {
  const stmt = db.prepare(`
    INSERT INTO holdings (symbol, exchange, name, sector, currency, quantity, avg_price, buy_date)
    VALUES (@symbol, @exchange, @name, @sector, @currency, @quantity, @avgPrice, @buyDate)
  `);
  const info = stmt.run(h);
  return getHolding(info.lastInsertRowid);
}

function removeHolding(id) {
  db.prepare('DELETE FROM holdings WHERE id = ?').run(id);
}

function findHoldingBySymbol(symbol) {
  return db.prepare('SELECT * FROM holdings WHERE symbol = ?').get(symbol);
}

// ---- watchlist: titoli osservati senza posizione (nessuna quantità/prezzo) ----
function listWatchlist() {
  return db.prepare('SELECT * FROM watchlist ORDER BY created_at ASC').all();
}

function getWatchlistItem(id) {
  return db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id);
}

function findWatchlistBySymbol(symbol) {
  return db.prepare('SELECT * FROM watchlist WHERE symbol = ?').get(symbol);
}

function addWatchlistItem(w) {
  const stmt = db.prepare(`
    INSERT INTO watchlist (symbol, exchange, name, sector, currency)
    VALUES (@symbol, @exchange, @name, @sector, @currency)
  `);
  const info = stmt.run(w);
  return getWatchlistItem(info.lastInsertRowid);
}

function removeWatchlistItem(id) {
  db.prepare('DELETE FROM watchlist WHERE id = ?').run(id);
}

function removeWatchlistBySymbol(symbol) {
  db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol);
}

module.exports = {
  listHoldings, getHolding, addHolding, removeHolding, findHoldingBySymbol,
  listWatchlist, getWatchlistItem, findWatchlistBySymbol, addWatchlistItem, removeWatchlistItem, removeWatchlistBySymbol,
};
