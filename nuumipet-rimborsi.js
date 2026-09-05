/* ============================================================================
   Rimborsi e contestazioni NuumiPet — dati dalla dash di Serena
   ----------------------------------------------------------------------------
   Non tocca il codice della dashboard: si aggancia dopo, riempie RF e CT (che
   arrivavano dai fogli Drive, fermi a luglio/agosto) e aggiunge i tagli che
   nella dash di Serena ci sono e qui mancavano — soprattutto lo stato della
   merce, che nessun'altra fonte tiene.

   Due accortezze:
   · RF e CT sono const: non si riassegnano, si riempiono (Object.assign).
   · Il fatturato mensile resta quello che c'era (CheckoutChamp): io cambio
     solo i rimborsi, il denominatore non e' un dato mio da riscrivere.
   ========================================================================== */
(function () {
  'use strict';

  var FILE = 'nuumipet-rimborsi.json';          // fotografia dalla dash di Serena
  var FILE_SHOPIFY = 'dati/shopify-nuumipet.json';  // numeri vivi, rifatti ogni mattina
  var D = null, S = null;

  /* ------------------------------------------------------------- utilita' */
  function $(id) { return document.getElementById(id); }
  function usd(v) {
    return '$ ' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function num(v) { return Number(v || 0).toLocaleString('it-IT'); }
  function perc(p, t) { return t ? (p / t * 100).toFixed(1).replace('.', ',') + '%' : '—'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* Barra orizzontale con le classi della dashboard: identica alle sue.
     L'etichetta resta corta — la spiegazione va nel tooltip, non nella colonna,
     altrimenti le righe vanno a capo e la tabella si sfilaccia. */
  function barra(o) {
    return '<div class="rbar-row"' + (o.spiega ? ' title="' + esc(o.spiega) + '"' : '') + '>'
      + '<div class="lab">' + esc(o.lab)
      + (o.meta ? ' <span class="cnt" style="color:var(--muted);font-size:11px">' + esc(o.meta) + '</span>' : '')
      + '</div>'
      + '<div class="rbar-track"><div class="rbar-fill" style="width:'
      + (o.max ? o.v / o.max * 100 : 0).toFixed(1) + '%;background:' + o.col + '"></div></div>'
      + '<div class="rbar-val">' + o.val + '</div></div>';
  }
  function scheda(titolo, sottotitolo, corpo) {
    return '<div class="card"><h3>' + esc(titolo) + '</h3>'
      + (sottotitolo ? '<p class="chart-sub">' + esc(sottotitolo) + '</p>' : '') + corpo + '</div>';
  }
  function kpi(lab, big, sub, col) {
    if (typeof kpiCard === 'function') return kpiCard(lab, big, sub, col);
    return '<div class="card kpi"><h3>' + esc(lab) + '</h3><div class="big" style="font-size:clamp(24px,3.4vw,40px)'
      + (col ? ';color:' + col : '') + '">' + big + '</div><div class="sub">' + (sub || '') + '</div></div>';
  }
  function dataIt(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso || '');
  }
  function nota(html) { return '<p class="note" style="margin-top:12px">' + html + '</p>'; }
  function max(arr, k) { return Math.max.apply(null, arr.map(function (x) { return x[k]; }).concat(1)); }

  /* Colori di stato: dicono se il prodotto e' tornato o no. Non sono
     categorie da distinguere, sono stati — per questo good/warn/serious. */
  var COLORE = {
    non_partito: 'var(--axis)', recuperato: 'var(--u)', perso: 'var(--n)',
    tenuto: 'var(--warn)', attesa: 'var(--m)'
  };

  /* =============================== MERCE ===============================
     Il pezzo forte: di ogni rimborso si sa se il prodotto e' tornato indietro.
     I pezzi sono il dato solido; il valore in dollari dipende dal costo unitario
     impostato nella dash, quindi lo dichiaro invece di spacciarlo per esatto. */
  function sezioneMerce() {
    var m = D.RF.merce || [];
    var pezzi = m.reduce(function (s, x) { return s + x.pz; }, 0);
    function g() {
      var nomi = [].slice.call(arguments);
      return m.filter(function (x) { return nomi.indexOf(x.gruppo) >= 0; })
        .reduce(function (a, x) { return { pz: a.pz + x.pz, val: a.val + x.val, n: a.n + x.n }; },
          { pz: 0, val: 0, n: 0 });
    }
    var rec = g('recuperato'), per = g('perso'), ten = g('tenuto'),
        att = g('attesa'), np = g('non_partito');
    var partita = pezzi - np.pz;
    var costo = D.costoPezzo || 0;

    return '<section class="grid kpis" style="margin-top:18px">'
      + kpi('Merce recuperata', num(rec.pz) + ' pz',
            perc(rec.pz, partita) + ' della merce partita · ' + num(rec.n) + ' rimborsi', 'var(--u)')
      + kpi('Merce persa', num(per.pz) + ' pz',
            'non consegnata o rifiutata · ' + num(per.n) + ' rimborsi', 'var(--n)')
      + kpi('Tenuta dal cliente', num(ten.pz) + ' pz',
            'rimborso parziale, il prodotto resta a lui', 'var(--warn)')
      + kpi('Stato da inserire', num(att.pz) + ' pz',
            perc(att.pz, pezzi) + ' dei pezzi · ' + num(att.n) + ' rimborsi', 'var(--m)')
      + '</section>'
      + scheda('Che fine fa la merce',
          'ogni rimborso dice se il prodotto è tornato indietro · ' + num(pezzi) + ' pezzi in tutto',
          m.map(function (x) {
            return barra({
              lab: x.lab, meta: num(x.n) + ' rimb.', v: x.pz, max: max(m, 'pz'),
              val: num(x.pz) + ' pz', col: COLORE[x.gruppo] || 'var(--m)',
              spiega: x.spieg + ' — ' + usd(x.imp) + ' rimborsati'
                + (costo ? ', ' + usd(x.val) + ' di prodotto al costo di $ ' + costo + '/pz' : '')
            });
          }).join('')
          + nota('La merce <b>non partita</b> resta fuori dal conto delle perdite: soldi restituiti, '
            + 'ma nessun prodotto perso. Le righe <b>da indicare</b> sono ' + num(att.n) + ' su '
            + num(D.RF.summary.n) + ': finché restano così, la perdita reale è sottostimata.'
            + (costo ? ' Il valore in dollari usa il costo di $ ' + costo + '/pz impostato nella dash.' : '')));
  }

  /* ====================== MOTIVI E TIPO DI ORDINE ======================
     Qui la notizia non e' la classifica, e' quanto manca: il motivo e' compilato
     su poche righe. Un grafico con una barra al 96% direbbe solo quello, male.
     Meglio dirlo a parole e mostrare la classifica di cio' che c'e' davvero. */
  function sezioneMotivi() {
    var mo = D.RF.motivi || [], vuoti = D.RF.motivi_vuoti || 0;
    var tot = D.RF.summary.n, compilati = tot - vuoti;
    var somma = mo.reduce(function (s, x) { return s + x.n; }, 0);
    var t = D.RF.tipo || [], tVuoti = D.RF.tipo_vuoti || 0;
    var tNoti = tot - tVuoti;
    var COLT = { 'Primo acquisto': 'var(--m)', 'Rinnovo': 'var(--u)' };

    var sx = compilati
      ? mo.slice(0, 7).map(function (x) {
          return barra({ lab: x.k, v: x.n, max: max(mo, 'n'), val: num(x.n),
            col: 'var(--n)', meta: perc(x.n, somma), spiega: usd(x.imp) + ' rimborsati' });
        }).join('')
        + nota('Il motivo è compilato su <b>' + num(compilati) + ' rimborsi su ' + num(tot)
          + '</b> (' + perc(compilati, tot) + '): le percentuali qui sopra sono su quei ' + num(compilati) + '. '
          + 'Sulle righe importate da Shopify il campo arriva vuoto e va messo a mano.')
      : nota('Il motivo del cliente non è ancora compilato su nessuna riga.');

    var dx = tNoti
      ? t.map(function (x) {
          return barra({ lab: x.k, v: x.n, max: max(t, 'n'), val: num(x.n),
            col: COLT[x.k] || 'var(--m)', meta: perc(x.n, tNoti), spiega: usd(x.imp) + ' rimborsati' });
        }).join('')
        + nota('Su <b>' + num(tNoti) + ' rimborsi su ' + num(tot) + '</b> sappiamo se l’ordine era un primo '
          + 'acquisto o un rinnovo. Sugli altri ' + num(tVuoti) + ' il dato non c’è, quindi questa '
          + 'ripartizione non è ancora rappresentativa.')
      : nota('Nessuna riga dice se era primo acquisto o rinnovo.');

    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">'
      + scheda('Perché chiedono il rimborso', 'motivo dichiarato dal cliente', sx)
      + scheda('Primo acquisto o rinnovo', 'da dove nasce il rimborso', dx)
      + '</div>';
  }

  /* ============================== FORMATI ============================== */
  function sezioneFormati() {
    var f = (D.RF.formati || []).slice(0, 8);
    if (!f.length) return '';
    return scheda('Per formato', 'quale offerta torna indietro più spesso',
      f.map(function (x) {
        var lab = x.k === 'n/a' ? 'non applicabile' : x.k === 'non indicato' ? 'da indicare' : x.k;
        return barra({ lab: lab, v: x.n, max: max(f, 'n'),
          val: num(x.n), col: 'var(--m)', meta: num(x.pz) + ' pz',
          spiega: (x.k === 'n/a' ? 'corsi, spedizione: prodotti che un formato non ce l’hanno — ' : '')
            + usd(x.imp) + ' rimborsati su ' + num(x.n) + ' righe' });
      }).join(''));
  }

  /* ========================= COSTO DELLE CONTESTAZIONI ========================= */
  function sezioneContestazioni() {
    var c = D.CT, chiuse = c.vinte + c.perse;
    var mo = (c.motivi || []).slice(0, 7);
    return '<section class="grid kpis" style="margin-top:18px">'
      + kpi('Costo reale', usd(c.perso + c.fee),
            usd(c.perso) + ' persi + ' + usd(c.fee) + ' di commissioni', 'var(--n)')
      + kpi('Ancora senza esito', num(c.aperte),
            perc(c.aperte, c.total) + ' del totale · nel peggiore dei casi si perdono', 'var(--warn)')
      + kpi('Vinte sulle chiuse', perc(c.vinte, chiuse),
            num(c.vinte) + ' su ' + num(chiuse) + ' chiuse', 'var(--good)')
      + '</section>'
      + (mo.length ? scheda('Motivi delle contestazioni', 'come le classifica il gateway',
          mo.map(function (x) {
            return barra({ lab: x.k, v: x.n, max: max(mo, 'n'), val: num(x.n),
              col: 'var(--warn)', meta: perc(x.n, c.total) });
          }).join('')) : '');
  }


  /* ========================= SHOPIFY, DAL VIVO =========================
     Questa e' l'altra meta': il file qui sopra e' una fotografia (la dash di
     Serena, aggiornata quando qualcuno la aggiorna), questo lo rifa' ogni
     mattina un lavoro automatico che interroga Shopify.

     Numeratore e denominatore vengono tutti e due da Shopify, cosi' la
     percentuale sta in piedi da sola e arriva fino a ieri. Non li mescolo con
     CheckoutChamp: sarebbero due verita' diverse nello stesso rapporto.
     Copre il solo incasso passato dal checkout Shopify, e lo dico. */

  function ultimiGiorni(n) {
    var g = (S.giornaliero || []).slice(-n);
    return g.reduce(function (s, x) { return s + x[1]; }, 0);
  }

  function strisciaShopify() {
    var t = S.totali || {};
    var quando = dataIt(S.aggiornato).slice(0, 5);
    return '<div class="card" style="display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;'
      + 'padding:12px 18px;margin-bottom:14px">'
      + '<span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;'
      + 'text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">'
      + '<span style="width:7px;height:7px;border-radius:50%;background:var(--u);display:inline-block"></span>'
      + 'Shopify · ' + esc(quando) + '</span>'
      + '<span class="cnt" style="font-size:14px">'
      + '<b style="color:var(--n)">' + usd(t.rim) + '</b> di rimborsi su ' + usd(t.fat)
      + ' di fatturato · <b>' + String(t.pct || 0).replace('.', ',') + '%</b>'
      + (t.n ? ' · ' + num(t.n) + ' rimborsi' : '')
      + (S.giornaliero && S.giornaliero.length
          ? ' · <span style="color:var(--ink-2)">ultimi 30 giorni ' + usd(ultimiGiorni(30)) + '</span>' : '')
      + '</span></div>';
  }

  var MESE = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  function nomeMese(m) {
    var p = String(m).split('-');
    return (MESE[Number(p[1]) - 1] || m) + ' ' + String(p[0]).slice(2);
  }

  function sezioneShopify() {
    var mesi = (S.mesi || []).filter(function (m) { return m.fat > 0 || m.rim > 0; });
    var can = S.canali || [];
    if (!mesi.length && !can.length) return '';

    var conFat = mesi.filter(function (m) { return m.fat > 0; });
    var incidenze = conFat.map(function (m) { return m.rim / m.fat * 100; });
    var maxInc = Math.max.apply(null, incidenze.concat(1));

    var inCorso = String(S.aggiornato || '').slice(0, 7);
    var sx = conFat.map(function (m) {
      var inc = m.rim / m.fat * 100;
      var parziale = m.m === inCorso;
      return barra({
        lab: nomeMese(m.m), v: inc, max: maxInc,
        val: inc.toFixed(1).replace('.', ',') + '%', col: parziale ? 'var(--warn)' : 'var(--n)',
        meta: usd(m.rim) + (parziale ? ' · in corso' : ''),
        spiega: usd(m.rim) + ' di rimborsi su ' + usd(m.fat) + ' di fatturato'
          + (parziale ? ' — mese non finito: i rimborsi arrivano anche su ordini dei mesi prima, '
                        + 'quindi a inizio mese la percentuale parte alta e scende' : '')
      });
    }).join('');

    var dx = can.map(function (c) {
      return barra({
        lab: c.k, v: c.imp, max: max(can, 'imp'), val: usd(c.imp),
        col: 'var(--m)', meta: num(c.n) + ' rimb.',
        spiega: num(c.n) + ' rimborsi per ' + usd(c.imp)
      });
    }).join('');

    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:18px">'
      + scheda('Incidenza mese per mese, secondo Shopify',
          'rimborsi sul fatturato dello stesso mese — tutti e due presi da Shopify',
          sx + nota('Sopra e sotto arrivano dal <b>checkout Shopify</b>: fatturato e rimborsi della '
            + 'stessa fonte, quindi la percentuale regge. Restano fuori gli incassi che non passano '
            + 'di lì. È il taglio che arriva fino a ieri: il resto della pagina è la fotografia della dash.'
            + (conFat.some(function (m) { return m.m === inCorso; })
                ? ' L’ultima barra è il <b>mese in corso</b>, in giallo: non è ancora confrontabile con '
                  + 'le altre, perché il fatturato è solo di qualche giorno mentre i rimborsi arrivano '
                  + 'anche su ordini vecchi.' : '')))
      + (dx ? scheda('Da quale incassatore esce il rimborso', 'come li ha registrati Shopify', dx) : '')
      + '</div>';
  }

  function fonte() {
    return nota('<b>Fonte.</b> Rimborsi e contestazioni arrivano dalla dash <i>Rimborsi e Contestazioni '
      + 'NuumiPet</i>, dove l’assistenza li registra e li importa da Shopify: ' + num(D.RF.summary.n)
      + ' rimborsi e ' + num(D.CT.total) + ' contestazioni, aggiornati al ' + esc(D.updated) + '. '
      + 'Sostituiscono le fotografie dei fogli Drive, che si fermavano a luglio e agosto. '
      + 'Il fatturato al denominatore resta quello di CheckoutChamp: la percentuale sul fatturato '
      + 'copre i ' + num(D.RF.summary.mesiFat || 0) + ' mesi per cui il fatturato è già caricato, '
      + 'i rimborsi dei mesi successivi restano fuori da quel rapporto.'
      + (S ? ' <b>La riga in cima e il blocco “secondo Shopify”</b> sono un’altra cosa: li rifà '
             + 'ogni mattina un lavoro automatico che interroga Shopify, e arrivano fino al '
             + esc(dataIt(S.aggiornato)) + '. Coprono il solo checkout Shopify, ma non aspettano nessuno.'
           : ' Il collegamento diretto a Shopify non ha ancora prodotto il suo file: '
             + 'finché non gira, in pagina c’è solo la fotografia della dash.'));
  }

  /* ============================== AGGANCIO ============================== */
  function box(id) {
    var el = $(id);
    if (!el) { el = document.createElement('div'); el.id = id; }
    return el;
  }
  function innesta() {
    var r = $('pg-refund');
    if (r && !$('np-merce')) {
      // la riga di Shopify va in cima: e' il numero piu' fresco della pagina
      var primo = $('rfKpi') || r.firstElementChild;
      if (primo) r.insertBefore(box('np-vivo'), primo); else r.appendChild(box('np-vivo'));
      ['np-merce', 'np-motivi', 'np-formati', 'np-shopify', 'np-fonte']
        .forEach(function (id) { r.appendChild(box(id)); });
    }
    var c = $('pg-contest');
    if (c && !$('np-contest')) {
      var nb = c.querySelector('#cbNote'), b = box('np-contest');
      if (nb) c.insertBefore(b, nb); else c.appendChild(b);
    }
  }
  function disegna() {
    if (!D && !S) return;
    innesta();
    try {
      if ($('np-vivo')) $('np-vivo').innerHTML = S ? strisciaShopify() : '';
      if ($('np-shopify')) $('np-shopify').innerHTML = S ? sezioneShopify() : '';
      if (D) {
        if ($('np-merce')) $('np-merce').innerHTML = sezioneMerce();
        if ($('np-motivi')) $('np-motivi').innerHTML = sezioneMotivi();
        if ($('np-formati')) $('np-formati').innerHTML = sezioneFormati();
        if ($('np-fonte')) $('np-fonte').innerHTML = fonte();
        if ($('np-contest')) $('np-contest').innerHTML = sezioneContestazioni();
      }
    } catch (e) {
      if (window.console) console.warn('[rimborsi NuumiPet] disegno:', e);
    }
  }

  function applica(dati) {
    D = dati;

    /* Il fatturato mensile resta il loro (CheckoutChamp): non lo riscrivo, ci innesto
       dentro i rimborsi. Cosi' resta una sola verita' sul denominatore, e i mesi in cui
       il fatturato non c'e' ancora restano fuori dal conto invece di gonfiare la
       percentuale. */
    var cassaMese = {};
    (dati.RF.months || []).forEach(function (m) { cassaMese[m.m] = m.cassa; });
    if (typeof RF !== 'undefined' && RF.months && RF.months.length) {
      RF.months.forEach(function (m) { if (m && cassaMese[m.m] != null) m.cassa = cassaMese[m.m]; });
      delete dati.RF.months;                       // tengo il loro array, non lo sostituisco
      var conFat = RF.months.filter(function (m) { return m.fat > 0; });
      var fat = conFat.reduce(function (s, m) { return s + m.fat; }, 0);
      var cassaConFat = conFat.reduce(function (s, m) { return s + (m.cassa || 0); }, 0);
      dati.RF.summary.fat = fat;
      dati.RF.summary.pct = fat ? Math.round(cassaConFat / fat * 10000) / 100 : 0;
      dati.RF.summary.mesiFat = conFat.length;
    }

    if (typeof RF !== 'undefined') Object.assign(RF, dati.RF, { updated: dati.updated });
    if (typeof CT !== 'undefined') Object.assign(CT, dati.CT, { updated: dati.updated });

    /* la dashboard ridisegna quando si cambia pagina: mi aggancio a showPage
       per riapplicare i blocchi nuovi, e aggiorno subito quella aperta */
    if (typeof showPage === 'function' && !showPage.__np) {
      var orig = showPage;
      window.showPage = function (id) {
        var out = orig.apply(this, arguments);
        if (id === 'refund' || id === 'contest') setTimeout(disegna, 0);
        return out;
      };
      window.showPage.__np = true;
    }
    ['renderRefund', 'renderContest', 'renderHome'].forEach(function (f) {
      try { if (typeof window[f] === 'function') window[f](); } catch (e) { }
    });
    disegna();
  }

  /* Due file, due ritmi: la fotografia della dash e i numeri vivi di Shopify.
     Se uno dei due manca la pagina resta buona lo stesso, con quello che c'e'. */
  function leggi(file) {
    return fetch(file + '?t=' + Date.now())
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function (e) {
        if (window.console) console.warn('[rimborsi NuumiPet] ' + file + ' non letto:', e.message);
        return null;
      });
  }

  function avvia() {
    Promise.all([leggi(FILE), leggi(FILE_SHOPIFY)]).then(function (r) {
      S = r[1];
      if (r[0]) applica(r[0]);
      else disegna();          // senza la fotografia disegno comunque la parte Shopify
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avvia);
  else avvia();
})();
