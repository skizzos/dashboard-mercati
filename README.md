# Cruscotto Portafoglio

App locale per tracciare il tuo portafoglio azionario: cerchi un titolo per nome, scegli il ticker giusto tra i risultati, registri quantità/prezzo/data di acquisto e vedi andamento, treemap, confronto e allocazione con dati di mercato reali (Yahoo Finance).

## Avvio

```bash
npm install   # solo la prima volta
npm start
```

Poi apri http://localhost:4173

## Struttura

- `server.js` — API Express (ricerca, quotazioni, storico, CRUD posizioni)
- `db.js` — SQLite locale (`data/portfolio.db`), creato al primo avvio
- `yahoo.js` — wrapper su `yahoo-finance2` (ricerca, quote, storico, cambio valuta)
- `public/` — frontend (HTML/CSS/JS vanilla), stesso design del mockup approvato

## Dati e limiti noti

- Ricerca e prezzi vengono da Yahoo Finance (endpoint non ufficiale, gratuito, senza chiave API). Può occasionalmente essere lento o non rispondere: in quel caso l'app mostra un avviso e riusa l'ultimo prezzo noto.
- Le posizioni in valuta diversa da EUR vengono convertite usando il **cambio attuale**, applicato anche allo storico passato (approssimazione: non tiene conto di come il cambio è variato nel tempo).
- Il grafico ANDAMENTO somma per ogni giorno solo le posizioni già possedute a quella data (in base alla data di acquisto inserita).
- Aggiornamento automatico ogni 60 secondi; il pulsante ⟳ AGGIORNA forza un refresh immediato.

## Backup

Prima di ogni modifica a un file esistente di questo progetto viene creata una copia con timestamp (`nomefile.YYYYMMDDHHMMSS.bak.ext`) nella stessa cartella.

## Privacy

Le tue posizioni reali vivono solo in `data/portfolio.db` (SQLite locale), creato al primo avvio e **mai versionato** (è in `.gitignore`). Chi clona questo repo parte con un portafoglio vuoto: nessun dato personale, nessuna scelta di investimento è nel codice o nella cronologia git. Anche i backup con timestamp (`*.bak.*`) restano solo in locale.
