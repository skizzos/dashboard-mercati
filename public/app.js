(function(){

  // =========================================================
  // stato dati (reale, da API)
  // =========================================================
  var holdings = [];          // arricchiti da /api/portfolio (quotazioni live + cambio EUR)
  var watchlist = [];         // titoli osservati senza posizione, arricchiti da /api/watchlist
  var historyBySymbol = {};   // symbol -> [{date, close}], da /api/history (holdings + watchlist)
  var portfolioWarning = null;
  var loading = false;

  var fmt = new Intl.NumberFormat('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2});
  function money(v, ccy){ return fmt.format(v) + ' ' + (ccy||'EUR'); }
  function pct(v){ return (v>=0?'+':'') + v.toFixed(2) + '%'; }
  var palette = ['#ff8c1e','#4fc3f7','#c792ea','#ffd166','#4dd0e1','#f06292'];

  function plColor(plPct, alpha){
    var intensity = Math.min(1, Math.abs(plPct)/15) * 0.75 + 0.15;
    var up = plPct >= 0;
    var base = up ? [33,214,140] : [255,92,92];
    return 'rgba('+base[0]+','+base[1]+','+base[2]+','+(alpha!=null?alpha:intensity).toFixed(2)+')';
  }

  // =========================================================
  // panel registry + layout (Gridstack: sposta e ridimensiona in modalità MODIFICA)
  // =========================================================
  var PANEL_DEFS = [
    {id:'posizioni',   num:'01', title:'POSIZIONI',                                w:6,  h:7,  asof:true},
    {id:'mappa',       num:'02', title:'MAPPA TITOLI',                             w:12, h:7,  asof:true},
    {id:'tracking',    num:'03', title:'STOCK TRACKING',                           w:12, h:10, asof:true},
    {id:'andamento',   num:'04', title:'ANDAMENTO PORTAFOGLIO &middot; 90 SEDUTE', w:6,  h:7,  asof:true},
    {id:'confronto',   num:'05', title:'CONFRONTO NORMALIZZATO &middot; 60 SEDUTE',w:6,  h:7,  asof:true},
    {id:'allocazione', num:'06', title:'ALLOCAZIONE &middot; SETTORE',             w:6,  h:5,  asof:true},
    {id:'aggiungi',    num:'07', title:'AGGIUNGI POSIZIONE',                       w:6,  h:9,  asof:false},
    {id:'watchlist',   num:'08', title:'OSSERVATI SPECIALI',                       w:12, h:6,  asof:true}
  ];
  var defById = {};
  PANEL_DEFS.forEach(function(d){ defById[d.id] = d; });

  var LAYOUT_KEY = 'portafoglio.dashboard.layout.v3';
  var wrapperEls = {};     // id -> elemento .grid-stack-item corrente (solo se presente nel grid)
  var lastTotalValue = 0;  // per ridisegnare ANDAMENTO dopo un resize, senza ricalcolare tutto

  function loadSavedLayout(){
    try{
      var raw = localStorage.getItem(LAYOUT_KEY);
      if(!raw) return null;
      var saved = JSON.parse(raw);
      if(!Array.isArray(saved)) return null;
      return saved.filter(function(it){ return defById[it.id]; });
    }catch(e){ return null; }
  }
  function saveLayout(){
    if(!gsGrid) return;
    try{
      var data = gsGrid.save(false).map(function(n){
        return {id:n.id, x:n.x, y:n.y, w:n.w, h:n.h};
      });
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
    }catch(e){ /* storage non disponibile, il layout non persiste tra le sessioni */ }
  }

  function buildPanel(def, pos){
    var wrap = document.createElement('div');
    wrap.className = 'grid-stack-item';
    wrap.setAttribute('gs-id', def.id);
    wrap.setAttribute('gs-w', (pos && pos.w) || def.w);
    wrap.setAttribute('gs-h', (pos && pos.h) || def.h);
    if(pos && pos.x != null) wrap.setAttribute('gs-x', pos.x);
    if(pos && pos.y != null) wrap.setAttribute('gs-y', pos.y);

    var content = document.createElement('div');
    content.className = 'grid-stack-item-content';

    var el = document.createElement('article');
    el.className = 'panel';

    var head = document.createElement('div');
    head.className = 'panel-head';
    var plainTitle = def.title.replace(/&middot;.*$/,'').replace(/&amp;/g,'&');
    head.innerHTML =
      '<span class="handle">&#8942;&#8942;</span>' +
      '<span class="idx">' + def.num + '</span>' +
      '<span class="title">' + def.title + '</span>' +
      (def.asof ? '<span class="asof" data-asof>as-of --:--</span>' : '<span class="spacer" style="margin-left:auto"></span>') +
      '<button class="panel-close" type="button" data-remove="' + def.id + '" aria-label="Rimuovi pannello ' + plainTitle + '">&times;</button>';

    var body = document.createElement('div');
    body.className = 'panel-body';
    body.id = 'body-' + def.id;

    el.appendChild(head);
    el.appendChild(body);
    content.appendChild(el);
    wrap.appendChild(content);

    wrap.querySelector('[data-remove]').addEventListener('click', function(){
      removePanel(def.id);
    });

    return wrap;
  }

  var gsGrid = null;

  function initPanels(){
    var savedLayout = loadSavedLayout();
    var toShow = savedLayout && savedLayout.length ? savedLayout.map(function(it){return it.id;}) : PANEL_DEFS.map(function(d){return d.id;});
    var posById = {};
    if(savedLayout) savedLayout.forEach(function(it){ posById[it.id] = it; });

    var container = document.getElementById('dashboardGrid');
    PANEL_DEFS.forEach(function(def){
      if(toShow.indexOf(def.id) === -1) return;
      var wrap = buildPanel(def, posById[def.id]);
      wrapperEls[def.id] = wrap;
      container.appendChild(wrap);
    });

    gsGrid = GridStack.init({
      column:12,
      cellHeight:50,
      margin:8,
      handle:'.panel-head',
      float:false,
      staticGrid:true, // parte bloccato: si sblocca con "MODIFICA LAYOUT"
      animate:true
    }, container);

    gsGrid.on('change', function(){ saveLayout(); });
    gsGrid.on('resizestop', function(ev, el){
      var id = el.getAttribute('gs-id');
      if(id === 'tracking') renderTrackingTiles();
      else if(id === 'andamento') renderAndamento(lastTotalValue);
      else if(id === 'confronto') renderConfronto();
      else if(id === 'mappa') renderMappa();
      else if(id === 'watchlist') renderWatchlist();
    });
  }

  function removePanel(id){
    if(!gsGrid || !wrapperEls[id]) return;
    gsGrid.removeWidget(wrapperEls[id]);
    delete wrapperEls[id];
    saveLayout();
    syncWidgetMenu();
  }

  function addPanel(id, opts){
    var def = defById[id];
    if(!def || wrapperEls[id]) return;
    var wrap = buildPanel(def);
    wrapperEls[id] = wrap;
    document.getElementById('dashboardGrid').appendChild(wrap);
    gsGrid.makeWidget(wrap);
    // pannelli con stato interattivo proprio (ricerca, filtri) vanno ricostruiti:
    // il loro markup interno non sopravvive alla rimozione dal grid.
    if(id === 'aggiungi') buildAggiungi(opts && opts.prefill);
    if(id === 'tracking'){ buildTrackingShell(); renderTrackingBody(); }
    refreshData();
    saveLayout();
  }

  var widgetBtn = document.getElementById('widgetBtn');
  var widgetMenu = document.getElementById('widgetMenu');
  var widgetMenuList = document.getElementById('widgetMenuList');
  var editBtn = document.getElementById('editBtn');
  var editing = false;

  function syncWidgetMenu(){
    widgetMenuList.innerHTML = PANEL_DEFS.map(function(def){
      var plain = def.title.replace(/&middot;/g,'·').replace(/&amp;/g,'&');
      var checked = wrapperEls[def.id] ? 'checked' : '';
      return '<label><input type="checkbox" data-toggle="'+def.id+'" '+checked+'> '+plain+'</label>';
    }).join('');
    Array.prototype.forEach.call(widgetMenuList.querySelectorAll('[data-toggle]'), function(cb){
      cb.addEventListener('change', function(){
        var id = cb.getAttribute('data-toggle');
        if(cb.checked) addPanel(id); else removePanel(id);
      });
    });
  }

  widgetBtn.addEventListener('click', function(){
    var open = widgetMenu.hidden;
    widgetMenu.hidden = !open;
    widgetBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.widget-menu') && e.target !== widgetBtn){
      widgetMenu.hidden = true;
      widgetBtn.setAttribute('aria-expanded','false');
    }
  });

  editBtn.addEventListener('click', function(){
    editing = !editing;
    gsGrid.setStatic(!editing);
    editBtn.classList.toggle('active', editing);
    editBtn.setAttribute('aria-pressed', String(editing));
    widgetBtn.disabled = !editing;
    if(!editing) widgetMenu.hidden = true;
  });

  document.getElementById('refreshBtn').addEventListener('click', function(){ loadPortfolio(); });

  // ---------- titolo app (modificabile, persistito) ----------
  var TITLE_KEY = 'portafoglio.dashboard.title.v1';
  var brandTitle = document.getElementById('brandTitle');
  var titleBtn = document.getElementById('titleBtn');

  function applyTitle(t){
    document.title = t;
    brandTitle.textContent = t;
  }
  (function loadTitle(){
    try{
      var saved = localStorage.getItem(TITLE_KEY);
      if(saved) applyTitle(saved);
    }catch(e){ /* storage non disponibile, resta il titolo di default */ }
  })();

  titleBtn.addEventListener('click', function(){
    var current = brandTitle.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'brand-edit';
    input.value = current;
    var done = false;
    brandTitle.replaceWith(input);
    input.focus();
    input.select();
    function finish(save){
      if(done) return;
      done = true;
      if(save){
        var val = input.value.trim() || current;
        applyTitle(val);
        try{ localStorage.setItem(TITLE_KEY, val); }catch(e){}
      }
      input.replaceWith(brandTitle);
    }
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
      if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function(){ finish(true); });
  });

  // ---------- clock ----------
  function tickClock(){
    var d = new Date();
    var s = d.toLocaleTimeString('it-IT', {hour12:false});
    document.getElementById('clock').textContent = s;
    Array.prototype.forEach.call(document.querySelectorAll('[data-asof]'), function(el){
      el.textContent = 'as-of ' + s.slice(0,5);
    });
  }

  function setWarning(msg){
    var el = document.getElementById('warningLine');
    if(msg){ el.textContent = '⚠ ' + msg; el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  // ---------- tape ----------
  function renderTape(){
    var tape = document.getElementById('tape');
    if(!holdings.length){
      tape.innerHTML = '<div class="tape-track">&nbsp;nessuna posizione in portafoglio &mdash; usa AGGIUNGI POSIZIONE&nbsp;</div>';
      return;
    }
    var items = holdings.map(function(h){
      var cls = h.plPct >= 0 ? 'chg-up' : 'chg-down';
      var arrow = h.plPct >= 0 ? '▲' : '▼';
      return '<span class="tape-item">' + h.symbol +
        ' <span class="' + cls + '">' + arrow + ' ' + pct(h.plPct) + '</span></span>';
    }).join('');
    tape.innerHTML = '<div class="tape-track">' + items + items + '</div>';
  }

  // ---------- stat strip ----------
  function renderStats(){
    var totalValue = 0, totalCost = 0, prevValue = 0;
    holdings.forEach(function(h){
      totalValue += h.valueEur;
      totalCost += h.costEur;
      var prevNative = h.previousClose != null ? h.previousClose : h.price;
      prevValue += h.quantity * prevNative * (h.fxRate||1);
    });
    var pl = totalValue - totalCost;
    var plPct = totalCost ? (pl/totalCost)*100 : 0;
    var dayChg = prevValue ? ((totalValue - prevValue) / prevValue) * 100 : 0;
    var haveDayChg = holdings.some(function(h){ return h.previousClose != null; });

    var stats = [
      {label:'Valore totale', value: money(totalValue,'EUR'), sub:null},
      {label:'Costo totale', value: money(totalCost,'EUR'), sub:null},
      {label:'P/L', value: (pl>=0?'+':'') + money(pl,'EUR'), sub: pct(plPct), cls: pl>=0?'up-text':'down-text'},
      {label:'Var. oggi', value: haveDayChg ? pct(dayChg) : '&mdash;', sub:null, cls: dayChg>=0?'up-text':'down-text'},
      {label:'Posizioni', value: String(holdings.length), sub: (new Set(holdings.map(function(h){return h.sector;}))).size + ' settori'}
    ];

    document.getElementById('statStrip').innerHTML = stats.map(function(s){
      return '<div class="stat"><div class="stat-label">'+s.label+'</div>' +
        '<div class="stat-value ' + (s.cls||'') + '">'+s.value+'</div>' +
        (s.sub ? '<div class="stat-sub ' + (s.cls||'') + '">'+s.sub+'</div>' : '') +
      '</div>';
    }).join('');

    lastTotalValue = totalValue; // riusato da un ridisegno mirato dopo il resize di un pannello

    return {totalValue:totalValue, totalCost:totalCost};
  }

  // ---------- posizioni ----------
  function renderPosizioni(){
    var body = document.getElementById('body-posizioni');
    if(!holdings.length){
      body.innerHTML = '<div class="empty-note">Nessun titolo. Usa il pannello AGGIUNGI POSIZIONE per iniziare.</div>';
      return;
    }
    body.innerHTML =
      '<div class="table-scroll"><table class="pos-table"><thead><tr>' +
      '<th>Titolo</th><th class="r">Quantit&agrave;</th><th class="r">P.medio</th>' +
      '<th class="r">Attuale</th><th class="r">Valore</th><th class="r">P/L</th><th class="bar-cell"></th><th></th>' +
      '</tr></thead><tbody>' +
      holdings.map(function(h){
        var up = h.plPct >= 0;
        var barPct = Math.min(100, Math.abs(h.plPct) * 4);
        return '<tr>' +
          '<td><div class="sym">'+h.symbol+'</div><div class="name-dim">'+h.name+(h.exchange?' &middot; '+h.exchange:'')+'</div></td>' +
          '<td class="r num">'+h.quantity+'</td>' +
          '<td class="r num">'+money(h.avgPrice, h.currency)+'</td>' +
          '<td class="r num">'+money(h.price, h.currency)+'</td>' +
          '<td class="r num">'+money(h.valueNative, h.currency)+'</td>' +
          '<td class="r"><span class="pill '+(up?'up':'down')+'">'+(up?'+':'')+fmt.format(h.valueNative-h.costNative)+' &middot; '+pct(h.plPct)+'</span></td>' +
          '<td class="bar-cell"><div class="bar-track"><div class="bar-fill '+(up?'up':'down')+'" style="width:'+barPct+'%"></div></div></td>' +
          '<td><button class="row-remove" type="button" data-remove-id="'+h.id+'" aria-label="Rimuovi '+h.symbol+'">&times;</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    Array.prototype.forEach.call(body.querySelectorAll('[data-remove-id]'), function(btn){
      btn.addEventListener('click', function(){
        if(!confirm('Rimuovere ' + btn.getAttribute('aria-label').replace('Rimuovi ','') + ' dal portafoglio?')) return;
        removeHolding(btn.getAttribute('data-remove-id'));
      });
    });
  }

  async function removeHolding(id){
    try{
      await fetch('/api/holdings/'+id, {method:'DELETE'});
      await loadPortfolio();
    }catch(e){
      alert('Impossibile rimuovere la posizione: ' + e.message);
    }
  }

  // ---------- mappa titoli (monitor cards + sparkline reale) ----------
  function renderMappa(){
    var body = document.getElementById('body-mappa');
    if(!holdings.length){
      body.innerHTML = '<div class="empty-note">Nessun titolo da monitorare.</div>';
      return;
    }
    var now = new Date().toLocaleTimeString('it-IT',{hour12:false}).slice(0,5);
    body.innerHTML = '<div class="monitor-grid">' + holdings.map(function(h,idx){
      var up = h.plPct >= 0;
      return '<div class="monitor-card" style="border-color:'+plColor(h.plPct,0.55)+'">' +
        '<div class="mc-head"><span class="mc-sym">'+h.symbol+'</span><span class="mc-exch">'+(h.exchange||'')+'</span><span class="mc-ccy">'+h.currency+'</span></div>' +
        '<div class="mc-price num">'+fmt.format(h.price)+'</div>' +
        '<div class="mc-chg '+(up?'up-text':'down-text')+'">'+(up?'▲':'▼')+' '+(up?'+':'')+fmt.format(h.price-h.avgPrice)+' ('+pct(h.plPct)+')</div>' +
        '<canvas class="mc-spark" data-spark="'+idx+'"></canvas>' +
        '<div class="mc-foot">as-of '+now+' &middot; valore '+money(h.valueNative,h.currency)+'</div>' +
      '</div>';
    }).join('') + '</div>';

    holdings.forEach(function(h, idx){
      var cv = body.querySelector('[data-spark="'+idx+'"]');
      if(!cv) return;
      var hist = (historyBySymbol[h.symbol] || []).slice(-24);
      var series = hist.length >= 2 ? hist.map(function(p){return p.close;}) : [h.avgPrice, h.price];
      var up = series[series.length-1] >= series[0];
      var dpr = window.devicePixelRatio || 1;
      var w = cv.clientWidth || 160, ch = 32;
      cv.width = w*dpr; cv.height = ch*dpr;
      var ctx = cv.getContext('2d');
      ctx.scale(dpr,dpr);
      var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
      function xy(i,v){
        var x = (i/(series.length-1||1))*w;
        var y = 2 + (ch-4) * (1 - (v-min)/((max-min)||1));
        return [x,y];
      }
      var color = up ? '#21d68c' : '#ff5c5c';
      var grad = ctx.createLinearGradient(0,0,0,ch);
      grad.addColorStop(0, up ? 'rgba(33,214,140,.30)' : 'rgba(255,92,92,.30)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      series.forEach(function(v,i){ var p=xy(i,v); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); });
      ctx.lineTo(w,ch); ctx.lineTo(0,ch); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      series.forEach(function(v,i){ var p=xy(i,v); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); });
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    });
  }

  // ---------- osservati speciali (titoli monitorati senza posizione) ----------
  function renderWatchlist(){
    var body = document.getElementById('body-watchlist');
    if(!body) return;
    if(!watchlist.length){
      body.innerHTML = '<div class="empty-note">Nessun titolo osservato. Cercalo in AGGIUNGI POSIZIONE e lascia la quantit&agrave; vuota per tenerlo d&rsquo;occhio senza comprarlo.</div>';
      return;
    }
    var now = new Date().toLocaleTimeString('it-IT',{hour12:false}).slice(0,5);
    body.innerHTML = '<div class="monitor-grid">' + watchlist.map(function(w,idx){
      var hasPrice = w.price != null;
      var up = (w.changePercent||0) >= 0;
      var priceTxt = hasPrice ? fmt.format(w.price) : '&mdash;';
      var chgTxt = hasPrice ? (up?'▲':'▼')+' '+pct(w.changePercent||0) : 'quotazione non disponibile';
      return '<div class="monitor-card" style="border-color:'+(hasPrice?plColor(up?8:-8,0.4):'var(--border)')+'">' +
        '<div class="mc-head"><span class="mc-sym">'+w.symbol+'</span><span class="mc-exch">'+(w.exchange||'')+'</span><span class="mc-ccy">'+(w.currency||'')+'</span></div>' +
        '<div class="mc-price num">'+priceTxt+'</div>' +
        '<div class="mc-chg '+(up?'up-text':'down-text')+'">'+chgTxt+'</div>' +
        '<canvas class="mc-spark" data-wspark="'+idx+'"></canvas>' +
        '<div class="mc-foot">'+w.name+'</div>' +
        '<div class="mc-actions">' +
          '<button type="button" class="chip" data-buy="'+idx+'">+ COMPRA</button>' +
          '<button type="button" class="row-remove" data-unwatch="'+w.id+'" aria-label="Rimuovi '+w.symbol+' dagli osservati speciali">&times;</button>' +
        '</div>' +
        '<div class="mc-foot">as-of '+now+'</div>' +
      '</div>';
    }).join('') + '</div>';

    watchlist.forEach(function(w, idx){
      var cv = body.querySelector('[data-wspark="'+idx+'"]');
      if(!cv) return;
      var hist = (historyBySymbol[w.symbol] || []).slice(-24);
      if(hist.length < 2) return;
      var series = hist.map(function(p){return p.close;});
      var up = series[series.length-1] >= series[0];
      var dpr = window.devicePixelRatio || 1;
      var wpx = cv.clientWidth || 160, ch = 32;
      cv.width = wpx*dpr; cv.height = ch*dpr;
      var ctx = cv.getContext('2d');
      ctx.scale(dpr,dpr);
      var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
      function xy(i,v){
        var x = (i/(series.length-1||1))*wpx;
        var y = 2 + (ch-4) * (1 - (v-min)/((max-min)||1));
        return [x,y];
      }
      var color = up ? '#21d68c' : '#ff5c5c';
      var grad = ctx.createLinearGradient(0,0,0,ch);
      grad.addColorStop(0, up ? 'rgba(33,214,140,.30)' : 'rgba(255,92,92,.30)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      series.forEach(function(v,i){ var p=xy(i,v); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); });
      ctx.lineTo(wpx,ch); ctx.lineTo(0,ch); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      series.forEach(function(v,i){ var p=xy(i,v); if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]); });
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    });

    Array.prototype.forEach.call(body.querySelectorAll('[data-buy]'), function(btn){
      btn.addEventListener('click', function(){
        requestAddFlow(watchlist[Number(btn.getAttribute('data-buy'))]);
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-unwatch]'), function(btn){
      btn.addEventListener('click', function(){
        removeWatchlistItem(btn.getAttribute('data-unwatch'));
      });
    });
  }

  async function removeWatchlistItem(id){
    try{
      await fetch('/api/watchlist/'+id, {method:'DELETE'});
      await loadPortfolio();
    }catch(e){
      alert('Impossibile rimuovere il titolo osservato: ' + e.message);
    }
  }

  // apre (o riusa) il pannello AGGIUNGI POSIZIONE precompilato con un titolo osservato,
  // per passare dall'osservazione a una posizione vera con quantità e prezzo.
  function requestAddFlow(item){
    var prefill = {symbol:item.symbol, exchange:item.exchange, name:item.name, sector:item.sector};
    if(!wrapperEls['aggiungi']){
      addPanel('aggiungi', {prefill:prefill});
      syncWidgetMenu();
    } else {
      buildAggiungi(prefill);
    }
    var el = wrapperEls['aggiungi'];
    if(el && el.scrollIntoView) el.scrollIntoView({behavior:'smooth', block:'center'});
  }

  // ---------- stock tracking (treemap via d3) ----------
  var trackingSector = 'ALL';
  var trackingMetric = 'valore'; // valore | plpct | qty
  var trackingSearch = '';

  function metricValue(h, metric){
    if(metric === 'plpct') return Math.max(0.05, Math.abs(h.plPct));
    if(metric === 'qty') return Math.max(0.01, h.quantity);
    return Math.max(0.01, h.valueEur);
  }
  function metricLabel(metric){
    if(metric === 'plpct') return '|P/L%| ASSOLUTO';
    if(metric === 'qty') return 'QUANTIT&Agrave; IN PORTAFOGLIO';
    return 'VALORE POSIZIONE (EUR, attuale)';
  }

  function buildTrackingShell(){
    var body = document.getElementById('body-tracking');
    if(!body) return;
    body.innerHTML =
      '<div class="tracking-toolbar" id="trkChips"></div>' +
      '<div class="tracking-legend" id="trkLegend"></div>' +
      '<div class="tracking-canvas" id="trkCanvas"></div>';
  }

  function renderTrackingBody(){
    var chipsWrap = document.getElementById('trkChips');
    var legendWrap = document.getElementById('trkLegend');
    if(!chipsWrap || !legendWrap) return;

    var sectors = Array.from(new Set(holdings.map(function(h){return h.sector;})));

    var sectorChips = ['ALL'].concat(sectors).map(function(s){
      var active = trackingSector === s;
      return '<button type="button" class="chip'+(active?' active':'')+'" data-sector="'+s+'">'+s+'</button>';
    }).join('');
    var metricChips = [
      {id:'valore', label:'VALORE'},
      {id:'plpct', label:'|P/L%|'},
      {id:'qty', label:'QUANTIT&Agrave;'}
    ].map(function(m){
      var active = trackingMetric === m.id;
      return '<button type="button" class="chip'+(active?' active':'')+'" data-metric="'+m.id+'">'+m.label+'</button>';
    }).join('');
    chipsWrap.innerHTML = sectorChips + '<span class="chip-sep"></span>' + metricChips +
      '<input type="text" class="tracking-search" id="trkSearch" placeholder="cerca ticker&hellip;" value="'+trackingSearch.replace(/"/g,'')+'">';

    chipsWrap.querySelectorAll('[data-sector]').forEach(function(btn){
      btn.addEventListener('click', function(){ trackingSector = btn.getAttribute('data-sector'); renderTrackingBody(); });
    });
    chipsWrap.querySelectorAll('[data-metric]').forEach(function(btn){
      btn.addEventListener('click', function(){ trackingMetric = btn.getAttribute('data-metric'); renderTrackingBody(); });
    });
    var searchInput = document.getElementById('trkSearch');
    searchInput.addEventListener('input', function(){
      trackingSearch = searchInput.value;
      renderTrackingTiles();
      renderLegendText();
    });

    renderLegendText();
    renderTrackingTiles();

    function renderLegendText(){
      legendWrap.innerHTML =
        '<span><span class="legend-sw" style="background:'+plColor(8)+'"></span>▲ su</span>' +
        '<span><span class="legend-sw" style="background:'+plColor(-8)+'"></span>▼ giù</span>' +
        '<span>AREA = ' + metricLabel(trackingMetric) + ' &middot; colore/intensit&agrave; = P/L% dal prezzo medio</span>';
    }
  }

  function renderTrackingTiles(){
    var canvasWrap = document.getElementById('trkCanvas');
    if(!canvasWrap) return;

    if(!holdings.length){
      canvasWrap.innerHTML = '<div class="empty-note">Nessun titolo in portafoglio.</div>';
      return;
    }

    var q = trackingSearch.trim().toLowerCase();
    var pool = holdings.filter(function(h){
      if(trackingSector !== 'ALL' && h.sector !== trackingSector) return false;
      if(q && h.name.toLowerCase().indexOf(q)===-1 && h.symbol.toLowerCase().indexOf(q)===-1) return false;
      return true;
    });

    if(!pool.length){
      canvasWrap.innerHTML = '<div class="empty-note">Nessun titolo corrisponde al filtro.</div>';
      return;
    }

    var w = canvasWrap.clientWidth || 800;
    var h = canvasWrap.clientHeight || 440;
    var grouped = trackingSector === 'ALL' && sectorsCount(pool) > 1;

    var rootData;
    if(grouped){
      var bySector = {};
      pool.forEach(function(hd){ (bySector[hd.sector] = bySector[hd.sector]||[]).push(hd); });
      rootData = {children: Object.keys(bySector).map(function(sec){
        return {sector:sec, children: bySector[sec].map(function(hd){
          return Object.assign({}, hd, {value: metricValue(hd, trackingMetric)});
        })};
      })};
    } else {
      rootData = {children: pool.map(function(hd){
        return Object.assign({}, hd, {value: metricValue(hd, trackingMetric)});
      })};
    }

    var root = d3.hierarchy(rootData).sum(function(d){ return d.value || 0; })
      .sort(function(a,b){ return b.value - a.value; });

    d3.treemap()
      .size([w,h])
      .paddingOuter(2)
      .paddingInner(2)
      .paddingTop(function(d){ return (d.depth===1 && d.children) ? 20 : 0; })
      .round(true)(root);

    var html = '';
    if(grouped){
      root.children.forEach(function(g){
        var gw = g.x1-g.x0, gh = g.y1-g.y0;
        html += '<div class="tracking-group" style="left:'+g.x0+'px;top:'+g.y0+'px;width:'+gw+'px;height:'+gh+'px">' +
          '<div class="grp-label">'+g.data.sector+' &middot; n='+g.children.length+'</div></div>';
      });
    }
    root.leaves().forEach(function(leaf){
      var lw = leaf.x1-leaf.x0, lh = leaf.y1-leaf.y0;
      if(lw<=0 || lh<=0) return;
      var hdata = leaf.data;
      var up = hdata.plPct >= 0;
      var compact = lw < 78 || lh < 54;
      var bg = plColor(hdata.plPct);
      if(compact){
        html += '<div class="tracking-tile compact" style="left:'+leaf.x0+'px;top:'+leaf.y0+'px;width:'+lw+'px;height:'+lh+'px;background:'+bg+'">' +
          '<span class="tt-sym">'+hdata.symbol+'</span>' +
          '<span class="tt-bottom">'+(up?'▲':'▼')+' '+pct(hdata.plPct)+'</span>' +
        '</div>';
      } else {
        html += '<div class="tracking-tile" style="left:'+leaf.x0+'px;top:'+leaf.y0+'px;width:'+lw+'px;height:'+lh+'px;background:'+bg+'">' +
          '<div><span class="tt-sym">'+hdata.symbol+'</span> <span class="tt-name" style="opacity:.9">'+(hdata.exchange||'')+'</span>' +
          '<div class="tt-name">'+hdata.name+'</div></div>' +
          '<div class="tt-bottom"><span>'+money(hdata.price,hdata.currency)+'</span><span>'+(up?'▲':'▼')+' '+pct(hdata.plPct)+'</span></div>' +
        '</div>';
      }
    });
    canvasWrap.innerHTML = html;
  }

  function sectorsCount(list){
    return new Set(list.map(function(h){return h.sector;})).size;
  }

  // ---------- andamento (valore reale del portafoglio nel tempo) ----------
  function computeAndamentoSeries(){
    var bySymbolMap = {};
    holdings.forEach(function(h){
      var m = {};
      (historyBySymbol[h.symbol]||[]).forEach(function(p){ m[p.date] = p.close; });
      bySymbolMap[h.symbol] = m;
    });
    var dateSet = new Set();
    holdings.forEach(function(h){ (historyBySymbol[h.symbol]||[]).forEach(function(p){ dateSet.add(p.date); }); });
    var dates = Array.from(dateSet).sort();
    var values = dates.map(function(date){
      var total = 0;
      holdings.forEach(function(h){
        if(h.buyDate && date < h.buyDate) return;
        var close = bySymbolMap[h.symbol][date];
        if(close == null) return;
        total += h.quantity * close * (h.fxRate||1);
      });
      return total;
    });
    return {dates:dates, values:values};
  }

  function renderAndamento(totalValue){
    var body = document.getElementById('body-andamento');
    if(!holdings.length){
      body.innerHTML = '<div class="empty-note">Aggiungi almeno un titolo per vedere l&rsquo;andamento.</div>';
      return;
    }
    var s = computeAndamentoSeries();
    if(s.values.length < 2){
      body.innerHTML = '<div class="empty-note">Storico non ancora disponibile per questi titoli.</div>';
      return;
    }
    body.innerHTML =
      '<div class="chart-meta">' +
        '<span>VALORE ATTUALE <b id="chartValue">&mdash;</b></span>' +
        '<span>MIN PERIODO <b id="chartMin">&mdash;</b></span>' +
        '<span>MAX PERIODO <b id="chartMax">&mdash;</b></span>' +
      '</div>' +
      '<canvas id="lineChart" height="150"></canvas>' +
      '<canvas id="barChart" height="46"></canvas>';

    var series = s.values;
    var days = series.length;
    var min = Math.min.apply(null, series);
    var max = Math.max.apply(null, series);
    document.getElementById('chartValue').textContent = money(series[days-1],'EUR');
    document.getElementById('chartMin').textContent = money(min,'EUR');
    document.getElementById('chartMax').textContent = money(max,'EUR');

    var lc = document.getElementById('lineChart');
    var dpr = window.devicePixelRatio || 1;
    var w = lc.clientWidth, h = 150;
    lc.width = w*dpr; lc.height = h*dpr;
    var ctx = lc.getContext('2d');
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,w,h);

    ctx.strokeStyle = '#1a2328';
    ctx.lineWidth = 1;
    for(var g=1; g<4; g++){
      var y = (h-20) * g/4 + 6;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }

    function xy(i,v){
      var x = (i/(days-1)) * w;
      var y = 6 + (h-26) * (1 - (v-min)/((max-min)||1));
      return [x,y];
    }

    var grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, 'rgba(255,140,30,0.28)');
    grad.addColorStop(1, 'rgba(255,140,30,0)');
    ctx.beginPath();
    series.forEach(function(v,i){
      var p = xy(i,v);
      if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
    });
    ctx.lineTo(w, h-20); ctx.lineTo(0, h-20); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    series.forEach(function(v,i){
      var p = xy(i,v);
      if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
    });
    ctx.strokeStyle = '#ff8c1e';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    var last = xy(days-1, series[days-1]);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 3, 0, Math.PI*2);
    ctx.fillStyle = '#ff8c1e';
    ctx.fill();

    var bc = document.getElementById('barChart');
    var bh = 46;
    bc.width = w*dpr; bc.height = bh*dpr;
    var bctx = bc.getContext('2d');
    bctx.scale(dpr,dpr);
    bctx.clearRect(0,0,w,bh);
    var bw = w/days;
    var maxDelta = 0;
    var deltas = series.map(function(v,i){ return i===0?0:v-series[i-1]; });
    deltas.forEach(function(d){ maxDelta = Math.max(maxDelta, Math.abs(d)); });
    deltas.forEach(function(d,i){
      var bhh = maxDelta ? (Math.abs(d)/maxDelta) * (bh-4) : 0;
      bctx.fillStyle = d>=0 ? '#21d68c' : '#ff5c5c';
      var x = i*bw;
      var y = d>=0 ? (bh/2 - bhh) : bh/2;
      bctx.fillRect(x, y, Math.max(1,bw-1), bhh);
    });
  }

  // ---------- confronto normalizzato (performance % reale per titolo) ----------
  function renderConfronto(){
    var body = document.getElementById('body-confronto');
    if(!holdings.length){
      body.innerHTML = '<div class="empty-note">Aggiungi almeno un titolo da confrontare.</div>';
      return;
    }
    var lines = holdings.map(function(h, idx){
      var hist = (historyBySymbol[h.symbol]||[]).slice(-60);
      if(hist.length < 2) return null;
      var base = hist[0].close;
      var series = hist.map(function(p){ return ((p.close-base)/base)*100; });
      return {h:h, series:series, color: palette[idx % palette.length], end: series[series.length-1]};
    }).filter(Boolean);

    if(!lines.length){
      body.innerHTML = '<div class="empty-note">Storico non ancora disponibile per il confronto.</div>';
      return;
    }

    body.innerHTML = '<canvas id="cmpChart" height="140"></canvas><div class="cmp-legend" id="cmpLegend"></div>';

    var days = Math.max.apply(null, lines.map(function(l){return l.series.length;}));
    var allVals = lines.reduce(function(acc,l){ return acc.concat(l.series); }, []);
    var min = Math.min.apply(null, allVals.concat([0]));
    var max = Math.max.apply(null, allVals.concat([0]));

    var cv = document.getElementById('cmpChart');
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = 140;
    cv.width = w*dpr; cv.height = h*dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,w,h);

    function xy(i,v,n){
      var x = (i/((n-1)||1)) * w;
      var y = 8 + (h-16) * (1 - (v-min)/((max-min)||1));
      return [x,y];
    }

    var zeroY = xy(0,0,days)[1];
    ctx.strokeStyle = '#2a3439';
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(0,zeroY); ctx.lineTo(w,zeroY); ctx.stroke();
    ctx.setLineDash([]);

    lines.forEach(function(l){
      var n = l.series.length;
      ctx.beginPath();
      l.series.forEach(function(v,i){
        var p = xy(i,v,n);
        if(i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
      });
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      var last = xy(n-1, l.series[n-1], n);
      ctx.beginPath();
      ctx.arc(last[0], last[1], 2.5, 0, Math.PI*2);
      ctx.fillStyle = l.color;
      ctx.fill();
    });

    var maxAbs = Math.max.apply(null, lines.map(function(l){ return Math.abs(l.end); })) || 1;
    document.getElementById('cmpLegend').innerHTML = lines.map(function(l){
      var up = l.end >= 0;
      var barPct = Math.min(100, Math.abs(l.end)/maxAbs*100);
      return '<div class="cmp-row">' +
        '<span class="cmp-swatch" style="background:'+l.color+'"></span>' +
        '<span class="cmp-sym">'+l.h.symbol+'</span>' +
        '<span class="cmp-track"><span class="cmp-fill" style="width:'+barPct+'%;background:'+(up?'var(--positive)':'var(--negative)')+'"></span></span>' +
        '<span class="cmp-pct '+(up?'up-text':'down-text')+'">'+pct(l.end)+'</span>' +
      '</div>';
    }).join('');
  }

  // ---------- allocazione ----------
  function renderAllocazione(totalValue){
    var body = document.getElementById('body-allocazione');
    if(!holdings.length){
      body.innerHTML = '<div class="empty-note">Nessuna posizione da ripartire.</div>';
      return;
    }
    var bySector = {};
    holdings.forEach(function(h){
      bySector[h.sector] = (bySector[h.sector]||0) + h.valueEur;
    });
    var rows = Object.keys(bySector).sort(function(a,b){return bySector[b]-bySector[a];});
    body.innerHTML = rows.map(function(sector){
      var v = bySector[sector];
      var p = totalValue ? (v/totalValue*100) : 0;
      return '<div class="alloc-row">' +
        '<div class="alloc-label">'+sector+'</div>' +
        '<div class="alloc-track"><div class="alloc-fill" style="width:'+p.toFixed(1)+'%"></div></div>' +
        '<div class="alloc-pct">'+p.toFixed(1)+'%</div>' +
      '</div>';
    }).join('');
  }

  // =========================================================
  // aggiungi posizione (ricerca reale + form, costruito una volta)
  // =========================================================
  function buildAggiungi(prefill){
    var body = document.getElementById('body-aggiungi');
    if(!body) return;
    body.innerHTML =
      '<div class="search-wrap">' +
        '<input type="text" id="searchInput" placeholder="Cerca per nome o ticker&hellip;" autocomplete="off">' +
        '<div class="results" id="searchResults" hidden></div>' +
      '</div>' +
      '<div id="selectedChip" hidden></div>' +
      '<form id="addForm" hidden>' +
        '<div class="field-row">' +
          '<div class="field"><label for="qty">Quantit&agrave; (vuoto = solo osservazione)</label><input type="number" id="qty" min="0" step="any" placeholder="0"></div>' +
          '<div class="field"><label for="price">Prezzo / unit&agrave;</label><input type="number" id="price" min="0" step="any" placeholder="0.00"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="buyDate">Data acquisto</label><input type="date" id="buyDate"></div>' +
          '<div class="field"><label for="ccy">Valuta</label><select id="ccy"><option>EUR</option><option>USD</option><option>GBP</option><option>CHF</option></select></div>' +
        '</div>' +
        '<button type="submit" class="btn-add">Aggiungi agli osservati speciali</button>' +
        '<div class="form-error" id="formError" hidden></div>' +
      '</form>' +
      '<div class="hint">Ricerca e quotazioni via Yahoo Finance. Lascia la quantit&agrave; vuota per tenere un titolo d&rsquo;occhio in OSSERVATI SPECIALI senza registrare un acquisto.</div>';

    var input = document.getElementById('searchInput');
    var results = document.getElementById('searchResults');
    var chip = document.getElementById('selectedChip');
    var form = document.getElementById('addForm');
    var formError = document.getElementById('formError');
    var picked = null;
    var searchToken = 0;
    var debounceTimer = null;

    input.addEventListener('input', function(){
      var q = input.value.trim();
      clearTimeout(debounceTimer);
      if(!q){ results.hidden = true; results.innerHTML=''; return; }
      debounceTimer = setTimeout(function(){ runSearch(q); }, 300);
    });

    function positionResults(){
      var r = input.getBoundingClientRect();
      results.style.left = r.left + 'px';
      results.style.top = (r.bottom + 2) + 'px';
      results.style.width = r.width + 'px';
    }
    window.addEventListener('resize', function(){ if(!results.hidden) positionResults(); });
    // il pannello che contiene l'input scorre internamente (per il resize dei pannelli):
    // più semplice chiudere il menu che inseguirlo mentre si scrolla.
    window.addEventListener('scroll', function(){ if(!results.hidden) results.hidden = true; }, true);

    async function runSearch(q){
      var myToken = ++searchToken;
      results.innerHTML = '<div class="result-row"><span class="result-name">Cerco&hellip;</span></div>';
      positionResults();
      results.hidden = false;
      var matches = [];
      try{
        var res = await fetch('/api/search?q='+encodeURIComponent(q));
        matches = await res.json();
      }catch(e){ matches = []; }
      if(myToken !== searchToken) return; // risposta superata da una ricerca più recente
      if(!Array.isArray(matches) || !matches.length){
        results.innerHTML = '<div class="result-row"><span class="result-name">Nessun risultato per &laquo;'+q+'&raquo;</span></div>';
        return;
      }
      results.innerHTML = matches.map(function(m, idx){
        return '<div class="result-row" tabindex="0" data-idx="'+idx+'">' +
          '<div><div class="result-sym">'+m.symbol+'</div><div class="result-name">'+m.name+'</div></div>' +
          '<div class="result-tag">'+(m.sector||m.quoteType||'')+' &middot; '+(m.exchange||'')+'</div>' +
        '</div>';
      }).join('');
      Array.prototype.forEach.call(results.querySelectorAll('.result-row[data-idx]'), function(row){
        function choose(){ selectTicker(matches[Number(row.getAttribute('data-idx'))]); }
        row.addEventListener('click', choose);
        row.addEventListener('keydown', function(e){ if(e.key==='Enter') choose(); });
      });
    }

    document.addEventListener('click', function(e){
      if(!e.target.closest('.search-wrap')) results.hidden = true;
    });

    var submitBtn = form.querySelector('.btn-add');
    var qtyInput = document.getElementById('qty');
    qtyInput.addEventListener('input', function(){
      var hasQty = qtyInput.value.trim() !== '' && parseFloat(qtyInput.value) > 0;
      submitBtn.textContent = hasQty ? 'Aggiungi al portafoglio' : 'Aggiungi agli osservati speciali';
    });

    async function selectTicker(m){
      picked = m;
      input.value = '';
      results.hidden = true;
      chip.hidden = false;
      chip.className = 'selected-chip';
      chip.innerHTML = '<div><span class="result-sym">'+m.symbol+'</span> &nbsp;<span class="name-dim">'+m.name+'</span></div>' +
        '<button type="button" aria-label="Rimuovi selezione">&times;</button>';
      chip.querySelector('button').addEventListener('click', function(){
        picked = null; chip.hidden = true; form.hidden = true; form.reset();
      });
      form.hidden = false;
      formError.hidden = true;
      qtyInput.value = '';
      submitBtn.textContent = 'Aggiungi agli osservati speciali';
      document.getElementById('buyDate').valueAsDate = new Date();
      document.getElementById('price').value = '';
      try{
        var res = await fetch('/api/quote?symbol='+encodeURIComponent(m.symbol));
        var q = await res.json();
        if(q.currency) document.getElementById('ccy').value = q.currency;
        if(q.price != null) document.getElementById('price').value = q.price;
      }catch(e){ /* prefill facoltativo, l'utente può comunque compilare a mano */ }
    }

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      if(!picked) return;
      var qtyRaw = document.getElementById('qty').value.trim();
      var hasQty = qtyRaw !== '' && parseFloat(qtyRaw) > 0;
      var qty = parseFloat(qtyRaw) || 0;
      var price = parseFloat(document.getElementById('price').value) || 0;
      var ccy = document.getElementById('ccy').value;
      var buyDate = document.getElementById('buyDate').value;

      submitBtn.disabled = true;
      formError.hidden = true;
      try{
        var res;
        if(hasQty){
          // quantità compilata: registra una posizione vera, serve anche il prezzo
          if(price<=0){ throw new Error('Inserisci il prezzo di acquisto per registrare la posizione.'); }
          res = await fetch('/api/holdings', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              symbol: picked.symbol, exchange: picked.exchange, name: picked.name, sector: picked.sector,
              currency: ccy, quantity: qty, avgPrice: price, buyDate: buyDate
            })
          });
        } else {
          // quantità vuota: solo osservazione, niente prezzo/data d'acquisto da registrare
          res = await fetch('/api/watchlist', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              symbol: picked.symbol, exchange: picked.exchange, name: picked.name, sector: picked.sector,
              currency: ccy
            })
          });
        }
        if(!res.ok){
          var err = await res.json().catch(function(){ return {}; });
          throw new Error(err.error || 'Errore nel salvataggio.');
        }
        form.hidden = true; form.reset(); chip.hidden = true; picked = null;
        await loadPortfolio();
      }catch(err){
        formError.textContent = err.message;
        formError.hidden = false;
      }finally{
        submitBtn.disabled = false;
      }
    });

    if(prefill) selectTicker(prefill);
  }

  // =========================================================
  // orchestrazione: rete + rendering
  // =========================================================
  function refreshData(){
    renderTape();
    var s = renderStats();
    renderPosizioni();
    renderMappa();
    renderWatchlist();
    renderTrackingTiles();
    renderAndamento(s.totalValue);
    renderConfronto();
    renderAllocazione(s.totalValue);
  }

  async function loadHistory(){
    var symbols = [...new Set(holdings.map(function(h){return h.symbol;}).concat(watchlist.map(function(w){return w.symbol;})))];
    if(!symbols.length){ historyBySymbol = {}; return; }
    try{
      var res = await fetch('/api/history?symbols='+encodeURIComponent(symbols.join(','))+'&days=90');
      historyBySymbol = await res.json();
    }catch(e){
      historyBySymbol = {};
    }
  }

  async function loadWatchlist(){
    try{
      var res = await fetch('/api/watchlist');
      var data = await res.json();
      watchlist = data.items || [];
      if(data.warning) setWarning(data.warning);
    }catch(e){
      watchlist = [];
    }
  }

  async function loadPortfolio(){
    if(loading) return;
    loading = true;
    var refreshBtn = document.getElementById('refreshBtn');
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⟳ AGGIORNO…';
    try{
      var res = await fetch('/api/portfolio');
      var data = await res.json();
      holdings = data.holdings || [];
      setWarning(data.warning || null);
    }catch(e){
      setWarning('Impossibile contattare il server. Verifica che sia in esecuzione.');
    }
    await loadWatchlist();
    await loadHistory();
    refreshData();
    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = '⟳ AGGIORNA';
  }

  // ---------- avvio ----------
  initPanels();
  syncWidgetMenu();
  buildAggiungi();
  buildTrackingShell();
  renderTrackingBody();
  loadPortfolio();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(loadPortfolio, 60000);
  window.addEventListener('resize', function(){ renderTrackingTiles(); });
})();
