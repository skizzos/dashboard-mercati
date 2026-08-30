// Wrapper sottile su yahoo-finance2: ricerca ticker, quotazioni live, storico prezzi, cambi valuta.
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Suffisso Yahoo per codice borsa (formato utente tipo "ENEL:BIT" o "SAP:ETR").
const EXCHANGE_SUFFIX = {
  ETR: '.DE', XETRA: '.DE', GER: '.DE', DE: '.DE',
  FRA: '.F', F: '.F',
  BIT: '.MI', MIL: '.MI', MI: '.MI',
  LSE: '.L', LON: '.L', L: '.L',
  PAR: '.PA', PA: '.PA',
  AEX: '.AS', AS: '.AS',
  SWX: '.SW', SIX: '.SW', SW: '.SW',
  NASDAQ: '', NYSE: '', US: '',
};

// "ENEL:BIT" / "ENEL.BIT" -> "ENEL.MI". Torna null se la query non ha questa forma
// o il codice borsa non è tra quelli mappati.
function parseTickerCode(query) {
  const m = query.trim().toUpperCase().match(/^([A-Z0-9]{1,10})[:.]([A-Z]{1,10})$/);
  if (!m) return null;
  const [, ticker, exch] = m;
  if (!(exch in EXCHANGE_SUFFIX)) return null;
  return ticker + EXCHANGE_SUFFIX[exch];
}

function quoteToResult(symbol, q) {
  return {
    symbol,
    name: q.longName || q.shortName || symbol,
    exchange: q.fullExchangeName || '',
    sector: null,
    quoteType: q.quoteType || 'EQUITY',
  };
}

// Prova una quotazione diretta per un simbolo Yahoo costruito a mano; torna null se non esiste.
async function tryDirectSymbol(symbol) {
  try {
    const res = await yf.quote([symbol]);
    const arr = Array.isArray(res) ? res : [res];
    const q = arr[0];
    if (q && q.symbol) return quoteToResult(q.symbol, q);
  } catch (e) {
    // simbolo non valido: nessun risultato diretto, si prosegue con la sola ricerca per nome
  }
  return null;
}

async function searchTickers(query) {
  const q = query.trim();
  const res = await yf.search(q, { quotesCount: 8, newsCount: 0 });
  const INVESTABLE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
  const byName = (res.quotes || [])
    .filter((r) => r.isYahooFinance && r.symbol && INVESTABLE_TYPES.has(r.quoteType))
    .map((r) => ({
      symbol: r.symbol,
      name: r.longname || r.shortname || r.symbol,
      exchange: r.exchDisp || r.exchange || '',
      sector: r.sectorDisp || r.sector || null,
      quoteType: r.quoteType,
    }));

  // Ricerca diretta per codice esplicito ("ENEL:BIT") o, per query brevi tipo ticker
  // senza spazi, un tentativo mirato sulla borsa italiana: la ricerca per nome di
  // Yahoo a volte non restituisce il listino di Milano per query brevi senza codice borsa.
  const directCandidates = [];
  const explicit = parseTickerCode(q);
  if (explicit) {
    directCandidates.push(explicit);
  } else if (/^[A-Za-z0-9]{2,10}$/.test(q)) {
    directCandidates.push(q.toUpperCase() + '.MI');
  }

  const known = new Set(byName.map((r) => r.symbol));
  const direct = [];
  for (const sym of directCandidates) {
    if (known.has(sym)) continue;
    const hit = await tryDirectSymbol(sym);
    if (hit) { direct.push(hit); known.add(hit.symbol); }
  }

  return direct.concat(byName);
}

async function getQuotes(symbols) {
  if (!symbols.length) return {};
  const res = await yf.quote(symbols);
  const arr = Array.isArray(res) ? res : [res];
  const map = {};
  arr.forEach((q) => {
    if (!q || !q.symbol) return;
    map[q.symbol] = {
      price: q.regularMarketPrice,
      previousClose: q.regularMarketPreviousClose,
      currency: q.currency,
      name: q.longName || q.shortName,
      exchange: q.fullExchangeName,
      changePercent: q.regularMarketChangePercent,
    };
  });
  return map;
}

// Tassi di cambio verso EUR per le valute richieste (approssimazione: tasso corrente,
// non storico, applicato anche alle serie passate).
async function getFxRates(currencies) {
  const uniq = [...new Set(currencies.filter((c) => c && c !== 'EUR'))];
  const rates = { EUR: 1 };
  if (!uniq.length) return rates;
  const pairs = uniq.map((c) => c + 'EUR=X');
  try {
    const res = await yf.quote(pairs);
    const arr = Array.isArray(res) ? res : [res];
    arr.forEach((q, i) => {
      if (q && q.regularMarketPrice != null) rates[uniq[i]] = q.regularMarketPrice;
    });
  } catch (e) {
    // se il cambio non è disponibile, il chiamante ricade su 1:1 per quella valuta
  }
  return rates;
}

async function getHistory(symbol, days) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 3600 * 1000);
  const res = await yf.chart(symbol, { period1, period2, interval: '1d' });
  return (res.quotes || [])
    .filter((q) => q.close != null)
    .map((q) => ({ date: q.date.toISOString().slice(0, 10), close: q.close }));
}

module.exports = { searchTickers, getQuotes, getFxRates, getHistory };
