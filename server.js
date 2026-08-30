const path = require('path');
const express = require('express');
const db = require('./db');
const { searchTickers, getQuotes, getFxRates, getHistory } = require('./yahoo');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/d3', express.static(path.join(__dirname, 'node_modules/d3/dist')));
app.use('/vendor/gridstack', express.static(path.join(__dirname, 'node_modules/gridstack/dist')));

// ---- ricerca ticker per nome/simbolo ----
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    res.json(await searchTickers(q));
  } catch (e) {
    console.error('search error', e.message);
    res.status(502).json({ error: 'Ricerca non disponibile al momento, riprova.' });
  }
});

// ---- quotazione singola, usata per precompilare il form dopo la selezione ----
app.get('/api/quote', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'Parametro symbol richiesto.' });
  try {
    const map = await getQuotes([symbol]);
    res.json(map[symbol] || {});
  } catch (e) {
    console.error('quote error', e.message);
    res.status(502).json({ error: 'Quotazione non disponibile al momento.' });
  }
});

// ---- CRUD posizioni ----
app.get('/api/holdings', (req, res) => {
  res.json(db.listHoldings());
});

app.post('/api/holdings', (req, res) => {
  const { symbol, exchange, name, sector, currency, quantity, avgPrice, buyDate } = req.body || {};
  const qty = Number(quantity);
  const price = Number(avgPrice);
  if (!symbol || !(qty > 0) || !(price > 0)) {
    return res.status(400).json({ error: 'Simbolo, quantità e prezzo sono obbligatori e devono essere positivi.' });
  }
  const row = db.addHolding({
    symbol,
    exchange: exchange || null,
    name: name || symbol,
    sector: sector || 'Non classificato',
    currency: currency || 'EUR',
    quantity: qty,
    avgPrice: price,
    buyDate: buyDate || null,
  });
  // se il titolo era negli osservati speciali, ora ha una posizione vera: lo rimuoviamo da lì
  db.removeWatchlistBySymbol(symbol);
  res.status(201).json(row);
});

app.delete('/api/holdings/:id', (req, res) => {
  db.removeHolding(req.params.id);
  res.status(204).end();
});

// ---- osservati speciali: titoli monitorati senza quantità/prezzo d'acquisto ----
app.get('/api/watchlist', async (req, res) => {
  const rows = db.listWatchlist();
  if (!rows.length) return res.json({ items: [] });

  const symbols = [...new Set(rows.map((r) => r.symbol))];
  let quotes = {};
  let warning = null;
  try {
    quotes = await getQuotes(symbols);
  } catch (e) {
    console.error('watchlist quotes error', e.message);
    warning = 'Quotazioni live non disponibili per gli osservati speciali.';
  }

  const items = rows.map((r) => {
    const q = quotes[r.symbol] || {};
    const price = q.price != null ? q.price : null;
    const previousClose = q.previousClose != null ? q.previousClose : null;
    const changePercent = q.changePercent != null ? q.changePercent
      : (price != null && previousClose) ? ((price - previousClose) / previousClose) * 100 : 0;
    return {
      id: r.id,
      symbol: r.symbol,
      exchange: q.exchange || r.exchange,
      name: q.name || r.name,
      sector: r.sector,
      currency: q.currency || r.currency || 'EUR',
      price,
      previousClose,
      changePercent,
    };
  });

  res.json({ items, warning });
});

app.post('/api/watchlist', (req, res) => {
  const { symbol, exchange, name, sector, currency } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'Simbolo obbligatorio.' });
  if (db.findHoldingBySymbol(symbol)) {
    return res.status(409).json({ error: 'Titolo già in portafoglio.' });
  }
  if (db.findWatchlistBySymbol(symbol)) {
    return res.status(409).json({ error: 'Titolo già negli osservati speciali.' });
  }
  const row = db.addWatchlistItem({
    symbol,
    exchange: exchange || null,
    name: name || symbol,
    sector: sector || 'Non classificato',
    currency: currency || null,
  });
  res.status(201).json(row);
});

app.delete('/api/watchlist/:id', (req, res) => {
  db.removeWatchlistItem(req.params.id);
  res.status(204).end();
});

// ---- portafoglio arricchito con quotazioni live + cambio in EUR ----
app.get('/api/portfolio', async (req, res) => {
  const rows = db.listHoldings();
  if (!rows.length) return res.json({ holdings: [] });

  const symbols = [...new Set(rows.map((r) => r.symbol))];
  let quotes = {};
  let warning = null;
  try {
    quotes = await getQuotes(symbols);
  } catch (e) {
    console.error('portfolio quotes error', e.message);
    warning = 'Quotazioni live non disponibili: mostro l\'ultimo prezzo medio noto.';
  }

  const currencies = [...new Set(rows.map((r) => (quotes[r.symbol] && quotes[r.symbol].currency) || r.currency || 'EUR'))];
  const rates = await getFxRates(currencies);

  const holdings = rows.map((r) => {
    const q = quotes[r.symbol] || {};
    const price = q.price != null ? q.price : r.avg_price;
    const currency = q.currency || r.currency || 'EUR';
    const rate = rates[currency] != null ? rates[currency] : 1;
    const valueNative = r.quantity * price;
    const costNative = r.quantity * r.avg_price;
    const plPct = r.avg_price ? ((price - r.avg_price) / r.avg_price) * 100 : 0;
    return {
      id: r.id,
      symbol: r.symbol,
      exchange: q.exchange || r.exchange,
      name: q.name || r.name,
      sector: r.sector,
      currency,
      quantity: r.quantity,
      avgPrice: r.avg_price,
      buyDate: r.buy_date,
      price,
      previousClose: q.previousClose != null ? q.previousClose : null,
      valueNative,
      costNative,
      plPct,
      valueEur: valueNative * rate,
      costEur: costNative * rate,
      fxRate: rate,
    };
  });

  res.json({ holdings, warning });
});

// ---- storico prezzi, in blocco per più simboli ----
app.get('/api/history', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  const days = Math.min(365, Number(req.query.days) || 90);
  if (!symbols.length) return res.json({});
  try {
    const entries = await Promise.all(
      symbols.map(async (sym) => {
        try {
          return [sym, await getHistory(sym, days)];
        } catch (e) {
          console.error('history error', sym, e.message);
          return [sym, []];
        }
      })
    );
    res.json(Object.fromEntries(entries));
  } catch (e) {
    console.error('history bulk error', e.message);
    res.status(502).json({ error: 'Storico non disponibile al momento.' });
  }
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`Cruscotto portafoglio su http://localhost:${PORT}`);
});
