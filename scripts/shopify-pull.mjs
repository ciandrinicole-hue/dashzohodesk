#!/usr/bin/env node
/**
 * Prende da Shopify i numeri di rimborsi e fatturato di NuumiPet e scrive
 * dati/shopify-nuumipet.json, che la dashboard legge dal proprio dominio.
 *
 * Gira dentro GitHub Actions. Le credenziali arrivano dai secret del
 * repository e non compaiono mai nel file prodotto ne' nei log.
 *
 * Nel file finiscono SOLO numeri aggregati: nessun nome, nessuna email,
 * nessun numero d'ordine.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NEGOZIO = process.env.SHOPIFY_STORE;          // es. evsedm-j1.myshopify.com
const TOKEN   = process.env.SHOPIFY_TOKEN;          // Admin API access token
const DA      = process.env.DAL || '2026-01-01';
const USCITA  = process.env.USCITA || 'dati/shopify-nuumipet.json';
const API     = '2025-07';

if (!NEGOZIO || !TOKEN) {
  console.error('Mancano i secret SHOPIFY_STORE o SHOPIFY_TOKEN.');
  process.exit(1);
}

const URL_API = `https://${NEGOZIO}/admin/api/${API}/graphql.json`;

// di norma e' il fetch del runtime; nei test viene sostituito con una finta risposta
let fetchImpl = (...a) => fetch(...a);
export function _usaFetch(f) { fetchImpl = f; }

async function chiedi(query, variables = {}) {
  for (let tentativo = 1; tentativo <= 5; tentativo++) {
    const r = await fetchImpl(URL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429 || r.status >= 500) {          // limite di frequenza: aspetto e riprovo
      await new Promise(s => setTimeout(s, 1500 * tentativo));
      continue;
    }
    const j = await r.json();
    if (j.errors) {
      const msg = JSON.stringify(j.errors);
      if (/THROTTLED/i.test(msg)) { await new Promise(s => setTimeout(s, 2000 * tentativo)); continue; }
      throw new Error('Shopify: ' + msg);
    }
    return j.data;
  }
  throw new Error('Shopify non risponde dopo 5 tentativi');
}

/* ---------- 1. la guardia: e' davvero il negozio giusto? ---------- */

const ATTESO = (process.env.DOMINIO_ATTESO || 'nuumipet.com').toLowerCase();

async function verificaNegozio() {
  const d = await chiedi(`{ shop { name primaryDomain { host } currencyCode ianaTimezone } }`);
  const host = (d.shop.primaryDomain?.host || '').toLowerCase();
  if (host !== ATTESO) {
    throw new Error(`negozio sbagliato: il token punta a ${host}, mi aspettavo ${ATTESO}`);
  }
  return d.shop;
}

/* ---------- 2. ShopifyQL: fatturato e rimborsi, per mese e per settimana ---------- */

const QL = `query($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData { columns { name dataType } rows }
  }
}`;

async function ql(q) {
  const d = await chiedi(QL, { q });
  const res = d.shopifyqlQuery;
  if (res?.parseErrors?.length) throw new Error('ShopifyQL: ' + JSON.stringify(res.parseErrors));
  // rows arriva gia' come lista di oggetti, con le chiavi uguali ai nomi delle colonne
  return res?.tableData?.rows || [];
}

const num = v => Math.abs(Number(v || 0));
const q2  = v => Math.round(v * 100) / 100;
const giorno = v => String(v || '').slice(0, 10);

async function periodi(oggi) {
  const fino = oggi;
  const mesi = await ql(`FROM sales SHOW returns, gross_sales GROUP BY month SINCE ${DA} UNTIL ${fino} ORDER BY month ASC`);
  const sett = await ql(`FROM sales SHOW returns, gross_sales GROUP BY week  SINCE ${DA} UNTIL ${fino} ORDER BY week ASC`);
  const prod = await ql(`FROM sales SHOW returns, net_sales GROUP BY product_title SINCE ${DA} UNTIL ${fino} ORDER BY returns ASC LIMIT 30`);
  return {
    mesi: mesi.map(r => ({ m: giorno(r.month).slice(0, 7), fat: q2(num(r.gross_sales)), rim: q2(num(r.returns)) })),
    settimane: sett.map(r => ({ iso: giorno(r.week), fat: q2(num(r.gross_sales)), rim: q2(num(r.returns)) })),
    prodotti: prod
      .filter(r => num(r.returns) > 0)
      .map(r => ({ nome: (r.product_title || 'Senza titolo').trim() || 'Senza titolo',
                   rim: q2(num(r.returns)), fat: q2(Number(r.net_sales || 0)) })),
  };
}

/* ---------- 3. GraphQL: quanti rimborsi e su quale incassatore ---------- */

const ORDINI = `query($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      refunds(first: 20) {
        createdAt
        totalRefundedSet { shopMoney { amount } }
      }
      transactions(first: 20) { gateway kind status }
    }
  }
}`;

const ETICHETTA = { stripev2: 'Stripe', stripe: 'Stripe', paypal: 'PayPal',
                    shopify_payments: 'Shopify Payments', nmi: 'NMI', 'nmi-payments': 'NMI',
                    manual: 'Manuale', gift_card: 'Buono regalo' };
const etichetta = g => ETICHETTA[String(g || '').toLowerCase()] || (g || 'Non indicato');

async function rimborsiDettaglio(oggi) {
  const q = `updated_at:>=${DA} financial_status:refunded,partially_refunded`;
  const canali = new Map();
  const perGiorno = new Map();
  let n = 0, tot = 0, pagine = 0, cursor = null;

  do {
    const d = await chiedi(ORDINI, { cursor, q });
    const o = d.orders;
    for (const ordine of o.nodes) {
      const gw = etichetta((ordine.transactions.find(t => t.kind === 'REFUND' && t.status === 'SUCCESS')
                         || ordine.transactions[0] || {}).gateway);
      for (const r of ordine.refunds || []) {
        const g = giorno(r.createdAt);
        if (g < DA || g > oggi) continue;
        const imp = Number(r.totalRefundedSet?.shopMoney?.amount || 0);
        n++; tot += imp;
        const c = canali.get(gw) || { k: gw, n: 0, imp: 0 };
        c.n++; c.imp += imp; canali.set(gw, c);
        perGiorno.set(g, q2((perGiorno.get(g) || 0) + imp));
      }
    }
    cursor = o.pageInfo.hasNextPage ? o.pageInfo.endCursor : null;
    if (++pagine > 200) { console.warn('fermato a 200 pagine'); break; }
  } while (cursor);

  return {
    n, tot: q2(tot), pagine,
    canali: [...canali.values()].map(c => ({ ...c, imp: q2(c.imp) })).sort((a, b) => b.imp - a.imp),
    giornaliero: [...perGiorno.entries()].sort().map(([g, v]) => [g, v]),
  };
}

/* ---------- 4. assemblo e scrivo ---------- */

async function main() {
  const oggi = new Date().toISOString().slice(0, 10);
  const shop = await verificaNegozio();
  console.log(`negozio: ${shop.name} (${shop.primaryDomain.host}) · ${shop.currencyCode}`);

  const p = await periodi(oggi);
  const dett = await rimborsiDettaglio(oggi);

  const fat = p.mesi.reduce((s, m) => s + m.fat, 0);
  const rim = p.mesi.reduce((s, m) => s + m.rim, 0);

  const fuori = {
    generato: new Date().toISOString(),
    aggiornato: oggi,
    negozio: shop.primaryDomain.host,
    valuta: shop.currencyCode,
    dal: DA,
    al: oggi,
    fonte: 'Shopify Admin API',
    totali: { fat: q2(fat), rim: q2(rim), pct: fat ? q2(rim / fat * 100) : 0, n: dett.n },
    mesi: p.mesi,
    settimane: p.settimane,
    prodotti: p.prodotti,
    canali: dett.canali,
    giornaliero: dett.giornaliero,
  };

  const testo = JSON.stringify(fuori);
  const sospetti = testo.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  if (sospetti.length) throw new Error('nel file ci sono indirizzi email: mi fermo');

  mkdirSync(dirname(USCITA), { recursive: true });
  writeFileSync(USCITA, testo);

  console.log(`rimborsi ${dett.n} · $ ${fuori.totali.rim.toLocaleString('en-US')} su $ ${fuori.totali.fat.toLocaleString('en-US')} (${fuori.totali.pct}%)`);
  console.log(`canali: ${dett.canali.map(c => `${c.k} ${c.n}`).join(', ')}`);
  console.log(`mesi ${p.mesi.length} · settimane ${p.settimane.length} · prodotti ${p.prodotti.length}`);
  console.log(`scritto ${USCITA} (${(testo.length / 1024).toFixed(0)} KB) · email nel file: 0`);
}

export { main, ql, periodi, rimborsiDettaglio, verificaNegozio };

// parte da sola solo se lanciato come programma, non se importato da un test
const lanciato = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (lanciato) main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
