'use strict';
/**
 * Painel Financeiro ao vivo — servidor sem dependências (Node 18+).
 *
 *  GET /                 -> front-end (index.html)
 *  GET /api/indicators   -> cotações, séries do Banco Central e expectativas Focus
 *  GET /api/news         -> notícias agregadas de feeds RSS (título, resumo curto e link)
 *  GET /healthz          -> health check
 *
 * Cada fonte falha de forma isolada: se uma cair, o resto continua funcionando
 * e o erro aparece em `errors` / `sources` na resposta.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const UA = 'Mozilla/5.0 (compatible; PainelFinanceiro/1.0)';
const TIMEOUT_MS = 8000;

/* ======================================================================
   CONFIGURAÇÃO — edite aqui
   ====================================================================== */

// Feeds RSS/Atom. Se algum endereço mudar, ele aparece como "falha" no rodapé do app.
// Apenas veículos focados em mercado financeiro; mesmo assim, tudo passa por um filtro de assunto (ver CATS).
const FEEDS = [
  { name: 'InfoMoney',        url: 'https://www.infomoney.com.br/mercados/feed/' },
  { name: 'Money Times',      url: 'https://www.moneytimes.com.br/feed/' },
  { name: 'Investing.com BR', url: 'https://br.investing.com/rss/news.rss' },
  { name: 'Seu Dinheiro',     url: 'https://www.seudinheiro.com/feed/' },
  { name: 'E-Investidor',     url: 'https://einvestidor.estadao.com.br/feed/' },
  { name: 'Exame Invest',     url: 'https://exame.com/invest/feed/' }
];

// Cotações (Yahoo Finance, endpoint público não oficial).
const QUOTES = [
  { id: 'ibov',    group: 'mercado',    name: 'Ibovespa',                    sym: '^BVSP',   unit: 'pts', dec: 0 },
  { id: 'sp500',   group: 'exterior',   name: 'S&P 500',                     sym: '^GSPC',   dec: 2 },
  { id: 'nasdaq',  group: 'exterior',   name: 'Nasdaq Composite',            sym: '^IXIC',   dec: 2 },
  { id: 'dow',     group: 'exterior',   name: 'Dow Jones',                   sym: '^DJI',    dec: 2 },
  { id: 'ust10',   group: 'exterior',   name: 'Treasury 10 anos',            sym: '^TNX',    kind: 'yield' },
  { id: 'brent',   group: 'commod',     name: 'Petróleo Brent',              sym: 'BZ=F',    prefix: 'US$ ', dec: 2 },
  { id: 'ouro',    group: 'commod',     name: 'Ouro (oz)',                   sym: 'GC=F',    prefix: 'US$ ', dec: 2 },
  { id: 'btc',     group: 'commod',     name: 'Bitcoin',                     sym: 'BTC-USD', prefix: 'US$ ', dec: 0 },
  { id: 'arabica', group: 'agro',       name: 'Café Arábica (ICE Nova York)', sym: 'KC=F',   prefix: 'US¢ ', unit: '/lb', dec: 2 },
  { id: 'robusta', group: 'agro',       name: 'Café Robusta/Conilon (ICE Londres)', sym: 'RM=F', prefix: 'US$ ', unit: '/t', dec: 0 },
  { id: 'vix',     group: 'sentimento', name: 'VIX (volatilidade)',          sym: '^VIX',    dec: 2 },
  { id: 'dxy',     group: 'sentimento', name: 'Índice do Dólar (DXY)',       sym: 'DX-Y.NYB', dec: 2 },
  { id: 'ust3m',   group: 'sentimento', name: 'Treasury 3 meses',            sym: '^IRX',    kind: 'yield' }
];

// Valores que não têm série pública simples — atualize quando mudarem (normalmente em janeiro).
const TETO_INSS = { valor: 8475.55, ano: 2026 };
const SALARIO_MINIMO_FALLBACK = 1621.0;

// Tempo de cache no servidor (ms)
const TTL = { quotes: 20 * 1000, fx: 20 * 1000, sgs: 30 * 60 * 1000, focus: 60 * 60 * 1000, feed: 4 * 60 * 1000 };

/* ======================================================================
   UTILITÁRIOS
   ====================================================================== */
const cache = new Map();
const inflight = new Map();

/** Cache com dedupe de requisições em andamento e "stale on error". */
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      cache.set(key, { t: Date.now(), v });
      return v;
    } catch (e) {
      if (hit) return hit.v; // devolve o último valor bom
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function fetchText(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers || {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
const fetchJson = async (url, headers) => JSON.parse(await fetchText(url, headers));

const nf = (n, d = 2) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const signed = (n, d = 2, suffix = '%') =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + nf(Math.abs(n), d) + suffix;
const toneOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const errMsg = (e) => String((e && e.message) || e);

/* ======================================================================
   FONTES DE COTAÇÃO
   ====================================================================== */
async function yahooQuote(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=5d&interval=1d';
  const j = await fetchJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('sem dados para ' + sym);
  const meta = r.meta || {};
  const closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0].close) || []).filter((x) => x != null);
  const last = closes[closes.length - 1];
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : last;
  if (price == null) throw new Error('sem preço para ' + sym);
  let prev;
  if (closes.length >= 2 && (last == null || Math.abs(price - last) < 1e-9 * Math.max(1, Math.abs(price)))) {
    prev = closes[closes.length - 2]; // a última barra é a de hoje
  } else if (last != null) {
    prev = last; // a barra de hoje ainda não existe
  } else {
    prev = meta.chartPreviousClose;
  }
  return { price, prev, first: closes.length ? closes[0] : null, t: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now() };
}

// Moedas oferecidas na calculadora de câmbio (todas cotadas contra o Real, via Yahoo Finance — mesma fonte já usada para as demais cotações).
const FX_CCY = [
  { code: 'USD', name: 'Dólar americano' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'Libra esterlina' },
  { code: 'ARS', name: 'Peso argentino' },
  { code: 'CAD', name: 'Dólar canadense' },
  { code: 'CHF', name: 'Franco suíço' },
  { code: 'JPY', name: 'Iene japonês' }
];
const fxPair = (code) => yahooQuote(code + 'BRL=X');

/** Séries temporais do Banco Central (SGS). */
async function sgs(code, n) {
  return cached('sgs:' + code + ':' + n, TTL.sgs, async () => {
    const rows = await fetchJson(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.' + code + '/dados/ultimos/' + n + '?formato=json'
    );
    const out = rows
      .map((r) => ({ data: r.data, valor: parseFloat(String(r.valor).replace(',', '.')) }))
      .filter((r) => Number.isFinite(r.valor));
    if (!out.length) throw new Error('série ' + code + ' vazia');
    return out;
  });
}
const refMonth = (data) => data.slice(3); // dd/mm/aaaa -> mm/aaaa

/** Expectativas Focus (mediana anual mais recente). */
async function focus() {
  return cached('focus', TTL.focus, async () => {
    const base = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoAnuais';
    const year = new Date().getFullYear();
    const wanted = [
      ['IPCA', 'IPCA', '%'],
      ['PIB Total', 'PIB', '%'],
      ['Selic', 'Selic (fim do ano)', '%'],
      ['Câmbio', 'Câmbio (fim do ano)', 'R$']
    ];
    const rows = [];
    let refDate = '';
    for (const [ind, label, unit] of wanted) {
      const filter = "Indicador eq '" + ind + "' and baseCalculo eq 0";
      const url =
        base + '?$top=40&$format=json&$orderby=' + encodeURIComponent('Data desc') +
        '&$filter=' + encodeURIComponent(filter);
      const j = await fetchJson(url);
      const vals = (j.value || []);
      const pick = (y) => vals.find((v) => String(v.DataReferencia) === String(y));
      const a = pick(year), b = pick(year + 1);
      if (a && a.Data > refDate) refDate = a.Data;
      const f = (v) => (v ? (unit === 'R$' ? 'R$ ' + nf(v.Mediana) : nf(v.Mediana) + '%') : '—');
      rows.push([label, f(a), f(b)]);
    }
    const [yy, mm, dd] = (refDate || '').split('-');
    return {
      ref: refDate ? 'Boletim Focus de ' + dd + '/' + mm + '/' + yy + ' (medianas)' : 'Boletim Focus',
      cols: [String(year), String(year + 1)],
      rows
    };
  });
}

/* ======================================================================
   /api/indicators
   ====================================================================== */
async function buildIndicators() {
  const errors = [];
  const groups = { mercado: [], juros: [], atividade: [], exterior: [], commod: [], agro: [], sentimento: [] };

  const settle = (id, p) => p.then((v) => ({ id, v }), (e) => { errors.push({ id, error: errMsg(e) }); return { id, v: null }; });

  const quoteJobs = QUOTES.map((q) => settle(q.id, cached('y:' + q.sym, TTL.quotes, () => yahooQuote(q.sym))));
  const fxJobs = FX_CCY.map((c) => settle('fx:' + c.code, cached('fx:' + c.code, TTL.fx, () => fxPair(c.code))));
  const sgsJobs = {
    selic: settle('selic', sgs(432, 400)),
    cdi: settle('cdi', sgs(4389, 3)),
    ipca12: settle('ipca12', sgs(13522, 3)),
    ipcaM: settle('ipcaM', sgs(433, 3)),
    igpm: settle('igpm', sgs(189, 3)),
    inpc: settle('inpc', sgs(188, 3)),
    desemp: settle('desemp', sgs(24369, 3)),
    smin: settle('smin', sgs(1619, 2)),
    usdSgs: settle('usdSgs', sgs(1, 3))
  };
  const focusJob = settle('focus', focus());

  const [quoteRes, fxRes, focusRes] = await Promise.all([Promise.all(quoteJobs), Promise.all(fxJobs), focusJob]);
  const S = {};
  for (const k of Object.keys(sgsJobs)) S[k] = (await sgsJobs[k]).v;
  const fxByCode = {};
  FX_CCY.forEach((c, i) => { if (fxRes[i].v) fxByCode[c.code] = fxRes[i].v; });

  // --- Mercado brasileiro: dólar/euro
  if (fxByCode.USD) {
    const r = fxByCode.USD;
    const pct = r.prev ? (r.price / r.prev - 1) * 100 : 0;
    groups.mercado.push({ id: 'usd', name: 'Dólar comercial', value: 'R$ ' + nf(r.price, 4),
      delta: r.prev ? signed(pct) : '', tone: toneOf(pct), t: r.t, note: 'Câmbio comercial' });
  } else if (S.usdSgs) {
    const a = S.usdSgs, l = a[a.length - 1], p = a[a.length - 2];
    const pct = p ? (l.valor / p.valor - 1) * 100 : 0;
    groups.mercado.push({ id: 'usd', name: 'Dólar comercial', value: 'R$ ' + nf(l.valor, 4),
      delta: p ? signed(pct) : '', tone: toneOf(pct), note: 'PTAX/BCB de ' + l.data });
  }
  if (fxByCode.EUR) {
    const r = fxByCode.EUR;
    const pct = r.prev ? (r.price / r.prev - 1) * 100 : 0;
    groups.mercado.push({ id: 'eur', name: 'Euro', value: 'R$ ' + nf(r.price, 4),
      delta: r.prev ? signed(pct) : '', tone: toneOf(pct), t: r.t, note: 'Câmbio comercial' });
  }

  // --- Câmbio para a calculadora (todas as moedas cotadas em Reais; cada uma busca e falha de forma independente)
  const fxCalc = { updatedAt: Date.now(), base: 'BRL', source: null,
    rates: [{ code: 'BRL', name: 'Real brasileiro', bid: 1, pct: 0, t: Date.now() }] };
  FX_CCY.forEach((c) => {
    const r = fxByCode[c.code];
    if (!r) return;
    const pct = r.prev ? (r.price / r.prev - 1) * 100 : 0;
    fxCalc.rates.push({ code: c.code, name: c.name, bid: r.price, pct, t: r.t });
    fxCalc.source = 'Yahoo Finance';
  });

  // --- Cotações Yahoo
  let yield10 = null, yield3m = null, vixVal = null, dxyVal = null, dxyPrev = null, ibovPrice = null, ibovFirst = null;
  QUOTES.forEach((q, i) => {
    const r = quoteRes[i].v;
    if (!r) return;
    let item;
    if (q.kind === 'yield') {
      const v = r.price > 20 ? r.price / 10 : r.price; // alguns feeds trazem o yield x10
      const pv = r.prev > 20 ? r.prev / 10 : r.prev;
      const diff = pv != null ? v - pv : 0;
      item = { id: q.id, name: q.name, value: nf(v, 3) + '%', delta: pv != null ? signed(diff, 3, ' p.p.') : '', tone: 'flat', t: r.t, note: 'Rendimento do título americano' };
      if (q.id === 'ust10') yield10 = v;
      if (q.id === 'ust3m') yield3m = v;
    } else {
      const pct = r.prev ? (r.price / r.prev - 1) * 100 : 0;
      item = { id: q.id, name: q.name, value: (q.prefix || '') + nf(r.price, q.dec), unit: q.unit,
        delta: r.prev ? signed(pct) : '', tone: toneOf(pct), t: r.t,
        note: q.id === 'arabica' ? 'Referência internacional (ICE); não é o indicador CEPEA/ESALQ do Conilon capixaba'
          : q.id === 'robusta' ? 'Referência internacional (ICE Londres); não é o indicador CEPEA/ESALQ do Conilon capixaba'
          : undefined };
      if (q.id === 'vix') vixVal = r.price;
      if (q.id === 'dxy') { dxyVal = r.price; dxyPrev = r.prev; }
      if (q.id === 'ibov') { ibovPrice = r.price; ibovFirst = r.first; }
    }
    groups[q.group].push(item);
  });

  // --- Sentimento: índice próprio de Medo ↔ FOMO (0 a 100), a partir de VIX, força do dólar e fôlego do Ibovespa na semana
  if (vixVal != null && dxyVal != null && dxyPrev && ibovPrice != null && ibovFirst) {
    const clamp = (n) => Math.max(0, Math.min(100, n));
    const scoreVix = clamp(100 - ((vixVal - 12) / (35 - 12)) * 100);
    const pctWeek = (ibovPrice / ibovFirst - 1) * 100;
    const scoreMom = clamp(50 + pctWeek * 10);
    const dxyPctDay = (dxyVal / dxyPrev - 1) * 100;
    const scoreDxy = clamp(50 - dxyPctDay * 20);
    const overall = Math.round((scoreVix + scoreMom + scoreDxy) / 3);
    const label = overall < 25 ? 'Medo extremo' : overall < 45 ? 'Medo' : overall <= 55 ? 'Neutro' : overall <= 75 ? 'Ganância (FOMO)' : 'Ganância extrema (FOMO)';
    groups.sentimento.push({ id: 'fomo', name: 'Índice de sentimento (Medo ↔ FOMO)', value: String(overall), unit: '/100',
      tone: overall < 45 ? 'down' : overall > 55 ? 'up' : 'flat',
      note: label + ' · calculado a partir do VIX, da força do dólar (DXY) e da variação do Ibovespa na semana — versão própria e simplificada, não é o índice oficial CNN Fear & Greed' });
  }
  if (yield10 != null && yield3m != null) {
    const spread = yield10 - yield3m;
    groups.sentimento.push({ id: 'curve', name: 'Curva de juros EUA (10a − 3m)', value: signed(spread, 2, ' p.p.'),
      tone: spread < 0 ? 'down' : 'up', note: spread < 0 ? 'Curva invertida — sinal clássico de risco de recessão' : 'Curva normal (positiva)' });
  }

  // --- Juros e inflação (SGS)
  if (S.selic) {
    const a = S.selic, last = a[a.length - 1];
    let j = a.length - 1;
    while (j > 0 && a[j - 1].valor === last.valor) j--;
    const prev = j > 0 ? a[j - 1] : null;
    groups.juros.push({ id: 'selic', name: 'Selic (meta)', value: nf(last.valor) + '%', unit: 'a.a.',
      delta: prev ? signed(last.valor - prev.valor, 2, ' p.p.') : '', tone: 'flat',
      note: 'Vigente desde ' + a[j].data });
  }
  if (S.cdi) {
    const l = S.cdi[S.cdi.length - 1];
    groups.juros.push({ id: 'cdi', name: 'CDI', value: nf(l.valor) + '%', unit: 'a.a.', tone: 'flat', note: 'Em ' + l.data });
  }
  const monthly = (key, id, name, withDelta, unitNote) => {
    const a = S[key];
    if (!a) return;
    const l = a[a.length - 1], p = a[a.length - 2];
    groups.juros.push({ id, name, value: nf(l.valor) + '%',
      delta: withDelta && p ? signed(l.valor - p.valor, 2, ' p.p.') : '', tone: 'flat',
      note: (unitNote || '') + 'ref. ' + refMonth(l.data) });
  };
  monthly('ipca12', 'ipca12', 'IPCA 12 meses', true, 'Meta 3% (tolerância 1,5%–4,5%) · ');
  monthly('ipcaM', 'ipcaM', 'IPCA no mês', false);
  monthly('igpm', 'igpm', 'IGP-M no mês', false);
  monthly('inpc', 'inpc', 'INPC no mês', false);

  // --- Atividade, emprego e previdência
  if (S.desemp) {
    const a = S.desemp, l = a[a.length - 1], p = a[a.length - 2];
    groups.atividade.push({ id: 'desemp', name: 'Desemprego (PNAD)', value: nf(l.valor, 1) + '%',
      delta: p ? signed(l.valor - p.valor, 1, ' p.p.') : '', tone: 'flat', note: 'Trimestre móvel até ' + refMonth(l.data) });
  }
  const smin = S.smin ? S.smin[S.smin.length - 1].valor : SALARIO_MINIMO_FALLBACK;
  groups.atividade.push({ id: 'smin', name: 'Salário mínimo', value: 'R$ ' + nf(smin), tone: 'flat',
    note: S.smin ? 'Série BCB/SGS 1619' : 'Valor de referência (fonte indisponível)' });
  groups.atividade.push({ id: 'teto', name: 'Teto do INSS', value: 'R$ ' + nf(TETO_INSS.valor), tone: 'flat',
    note: 'Valor de ' + TETO_INSS.ano + ' definido em config (server.js)' });

  const titles = { mercado: 'Mercado brasileiro', juros: 'Juros e inflação', atividade: 'Atividade, emprego e previdência', exterior: 'Exterior', commod: 'Commodities e cripto', agro: 'Agro — Café', sentimento: 'Sentimento & risco' };
  return {
    updatedAt: Date.now(),
    groups: Object.keys(titles).map((k) => ({ id: k, title: titles[k], items: groups[k] })).filter((g) => g.items.length),
    focus: focusRes.v || null,
    fx: fxCalc,
    errors
  };
}

/* ======================================================================
   NOTÍCIAS (RSS/Atom)
   ====================================================================== */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}
function cleanText(raw) {
  let s = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s); // conteúdo que veio escapado duas vezes
  return s.replace(/\s+/g, ' ').trim();
}
function tagText(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? cleanText(m[1]) : '';
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return cut.slice(0, sp > n * 0.6 ? sp : n).replace(/[\s.,;:!?-]+$/, '') + '…';
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = tagText(b, 'title');
    let link = tagText(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = decodeEntities(m[1]);
    }
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const dateStr = tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date');
    const ts = Date.parse(dateStr);
    let summary = tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content:encoded');
    if (summary && summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) summary = '';
    items.push({ title, link, source, ts: Number.isFinite(ts) ? ts : 0, summary: truncate(summary, 220) });
  }
  return items;
}

// Só entra notícia que casar com algum tema de mercado financeiro abaixo. O resto é descartado.
// `ctx` (opcional) exige também um termo de mercado no texto (evita política/eleição "pura").
const MKT_CTX = /\b(mercados?|bolsa|ibovespa|dolar|cambio|juros|fiscal|investidor\w*|ativos|risco|acoes|titulos|tesouro|selic|di futuro)\b/;
const CATS = [
  ['Juros & Inflação',     /\b(selic|copom|ipca\w*|igp-?m|inpc|inflac\w*|deflac\w*|juros|taxa basica|boletim focus|focus|cdi|di futuro|curva de juros|tesouro (direto|selic|ipca|prefixado)|renda fixa)\b/],
  ['Commodities & Cripto', /\b(petroleo|brent|wti|ouro|bitcoin|btc|cripto\w*|ethereum|commodit\w*|minerio|soja|etanol|opep|opec)\b/],
  ['Mundo',                /\b(fed|fomc|federal reserve|wall street|nasdaq|s&p 500|dow jones|treasuries|treasury|banco central europeu|bce|banco do japao|boj|banco da inglaterra|boe|ormuz|oriente medio|tarifa\w*)\b/],
  ['Política & Fiscal',    /\b(arcabouco fiscal|meta fiscal|risco fiscal|divida publica|resultado primario|orcamento|haddad|reforma tributaria|bolsa familia|gastos publicos|superavit|deficit)\b/],
  ['Política & Fiscal',    /\b(eleic\w*|pesquisa eleitoral|datafolha|atlasintel|quaest|campanha)\b/, MKT_CTX],
  ['Atividade & Emprego',  /\b(pib|ibc-?br|desemprego|desocupac\w*|pnad|caged|producao industrial|vendas no varejo|atividade economica|balanca comercial|payroll|pce)\b/],
  ['Mercados',             /\b(ibovespa|bolsa|b3|dolar|cambio|acoes|acao|small caps|fii\w*|fundos imobiliarios|dividendos|proventos|balanco|resultado do (1|2|3|4)?\w* ?(tri|trimestre)|ipo|oferta de acoes|recomendacao|preco-alvo|petrobras|petr4|vale|vale3|itau|bradesco|banco do brasil|btg|xp|nubank|mercado financeiro|mercados|mercado de capitais|tesouro|investidor\w*|cvm)\b/]
];
// Assuntos que não são "mercado financeiro" mesmo quando o veículo é financeiro.
const BLOCK = /\b(mega-?sena|lotofacil|quina|loteria\w*|horoscopo|bbb|futebol|novela|receita de|cupom|black friday|imposto de renda|irpf|restituicao|inss|fgts|aposentadoria|esocial|cnh|iptu|ipva|pix parcelado|consorcio|financiamento imobiliario|emprestimo consignado|cartao de credito|score|serasa|cpf)\b/;
// Notícias que costumam "mexer" no mercado (mesmo tipo de evento do calendário econômico).
const IMPACT = /\b(copom|selic|fed|fomc|payroll|ipca(-15)?|igp-?m|pib|pce|cpi|banco central|bce|boj|opep|opec|ormuz|tarifa\w*|arcabouco fiscal|meta fiscal|rating|intervencao|leilao de linha|ata do copom|boletim focus|decisao de juros)\b/;

const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Devolve a categoria de mercado ou null (=> descartar). */
function categorize(title, summary) {
  const t = strip(title);
  const full = strip(title + ' ' + (summary || ''));
  if (BLOCK.test(t)) return null;
  for (const [name, re, ctx] of CATS) if (re.test(t) && (!ctx || ctx.test(full))) return name;
  if (BLOCK.test(full)) return null;
  for (const [name, re, ctx] of CATS) if (re.test(full) && (!ctx || ctx.test(full))) return name;
  return null;
}
const isImpact = (title) => IMPACT.test(strip(title));

async function buildNews() {
  const results = await Promise.allSettled(
    FEEDS.map((f) => cached('feed:' + f.url, TTL.feed, async () => parseFeed(await fetchText(f.url, { Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' }), f.name)))
  );
  const sources = [];
  let all = [];
  results.forEach((r, i) => {
    const f = FEEDS[i];
    if (r.status === 'fulfilled') {
      const newest = r.value.slice().sort((a, b) => b.ts - a.ts).slice(0, 40);
      sources.push({ name: f.name, ok: true, count: newest.length });
      all = all.concat(newest);
    } else {
      sources.push({ name: f.name, ok: false, error: errMsg(r.reason) });
    }
  });
  const seen = new Set();
  const items = all
    .sort((a, b) => b.ts - a.ts)
    .filter((n) => {
      const k = strip(n.title).replace(/[^a-z0-9]+/g, ' ').slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((n) => ({ title: n.title, link: n.link, source: n.source, ts: n.ts, summary: n.summary, cat: categorize(n.title, n.summary), impact: isImpact(n.title) }))
    .filter((n) => n.cat) // só mercado financeiro
    .slice(0, 120);
  sources.forEach((s) => { if (s.ok) s.kept = items.filter((n) => n.source === s.name).length; });
  return { updatedAt: Date.now(), items, sources };
}

/* ======================================================================
   HTTP
   ====================================================================== */
const INDEX_PATH = path.join(__dirname, 'index.html');

/* ======================================================================
   ÍCONE DO APP (favicon / "adicionar à tela inicial")
   Guardado em base64 aqui mesmo para não depender de arquivos extras no repositório.
   ====================================================================== */
const ICONS = {
  favicon: { type: 'image/x-icon', data: Buffer.from('AAABAAIAEBAAAAAAIADPAgAAJgAAACAgAAAAACAABQIAAPUCAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAKWSURBVHicbZNPax11FIafc85v7tyZZJpo/mhqSkGwBf+QRqo0IghFMBuln0AQFwoVoRtdiLgQFdwEEcGlLvwIonEhFAy2opaCUmoEF9qoxOSa5CZ3Mnfmd7pI5Cami7N8eM953/cIwNOPLT2TJ3e96c45Yk8MVXNBEWx/BEEhtjV3tXCljOtvf/LtmUWZP/vdUxayL02s7XHHDZODsO5PcMGiIh59uBwRT2JZZd15FdUFU2vT9OpwB9j2YVrQFJE4qnLz+ZV6c7bfbndbCyGxdNbrHQ8SgjpHYDWhtWHcmu+y8tw2yb/K6uNl0I/xqSv3zarHKgYxuSOMoI3guTP19RBnX5sk2VZaG0K6nUj0Kqqhqv+/WQRVwXywfrGS8PuzXTQKJz8/xs5UTatvGo4YJkKIQthVyEAQ0g1j7VzJH/Nd5t64l5g6TeHEzAmDqBQRSGolDjtbpyvGf8ioRx1J4MZLHU4uFkxez6hHnKSvxNzRQVRgsqf824ubXH93lX+e7DG23OaXFzqIw4Of3k01FiGBmDvBdbCBBCHtGKvne2w8ssvD749z49V1tk73+fuJHo8uTJBUSpNGQjMQDYYgJqRbxuZMxfIrHR5aGOPEVwVZ1/jmgz+Z+Wic41eHqCYaQq2HPAsCMdR7SSxf7DD9RcGJxYJyumbq6hDnX56m+KtFPRIPwYai7jG0NFPtVv7zW2vSXg888Nko1T0NSaXUhTP5U4YEIAjqB34jRk81V002+9e6cyZrMzv1mfcmsGa/B74Xp2d7sB2Cvc7tmDSxuqah0kvDt6yce+f+EEqcFEJzoJHxMIy7Z1YEcS9RLumHv566nN2sLkz8mC+10jxaTfzvA4/UOhIzGY6GLu3GrQuvf3/88m1/aArH0DIqUAAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAcxJREFUeJzF171OwzAQB/D/WbxEQykj8AAFCSqoxIdgZmOqRyQGFvoqiAH5UYBKpaKhEhITiJGPvoVZGnN2EicpOHhpr772F18vJ4WQsY42HjWBQADE7NWKtRO7+1mxJlzHa+Ra1geHG4+68MfmxHl8Fa8aV9SNEwin7RdtXUCdeBKftV+1uYC68SQGAArVcO7+UH2aXuvKptlfCIGP1RS+xfNFiJMXLf79hRBl35QNa3+gPlIVoJkjQjeci4PjIIi68F259HMBOqsHAtxqHOcxzxeh8Dt2en7fWz0AgI7Xn/xz4Jf4nlyy/nM3X/w1zk9ahPvnQA4+VlNv/q16Z6X24z89UAEHgJH6KsT3ZasQNxWogidrqD5T+ZXxUj3gjNctGZn3A/Vh8m946UviBIBO1p91Ef7ATt+RUe6EA4CDXqs87u0BD04AurL5azy/BwrwJJ+PV5TB3Fhn9QC7z314Eu/LFgDgsLdcGU/PAYaP1Fe5k+n5cbsHcvBtuejF5yl7ugf+CwdBuLO9TpwAiOt4jZLgnp2+Drw/ich6LujMptyOXAyOJ/U2VT9tv+RPxAD4xaRBAGCeDS/jFaobtyrA13n7TYfA+5Mo5X0DKrO56NnyfXUAAAAASUVORK5CYII=', 'base64') },
  icon180: { type: 'image/png', data: Buffer.from('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', 'base64') },
  icon192: { type: 'image/png', data: Buffer.from('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', 'base64') },
  icon512: { type: 'image/png', data: Buffer.from('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', 'base64') }
};
const MANIFEST = JSON.stringify({
  name: 'Painel Financeiro',
  short_name: 'Painel Financeiro',
  description: 'Notícias, calendário econômico, câmbio e indicadores de mercado em tempo real.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0a14',
  theme_color: '#4338ca',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://sslecal2.investing.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function sendJson(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, { error: 'método não permitido' }, 405);
    if (url.pathname === '/api/indicators') return sendJson(res, await cached('api:ind', 5000, buildIndicators));
    if (url.pathname === '/api/news') return sendJson(res, await cached('api:news', 30000, buildNews));
    if (url.pathname === '/healthz') return sendJson(res, { ok: true });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
      return res.end(html);
    }
    if (url.pathname === '/manifest.json') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }, SEC_HEADERS));
      return res.end(MANIFEST);
    }
    const iconRoutes = {
      '/favicon.ico': ICONS.favicon,
      '/apple-touch-icon.png': ICONS.icon180,
      '/apple-touch-icon-precomposed.png': ICONS.icon180,
      '/icon-180.png': ICONS.icon180,
      '/icon-192.png': ICONS.icon192,
      '/icon-512.png': ICONS.icon512
    };
    if (iconRoutes[url.pathname]) {
      const icon = iconRoutes[url.pathname];
      res.writeHead(200, Object.assign({ 'Content-Type': icon.type, 'Cache-Control': 'public, max-age=604800' }, SEC_HEADERS));
      return res.end(icon.data);
    }
    return sendJson(res, { error: 'não encontrado' }, 404);
  } catch (e) {
    console.error(e);
    return sendJson(res, { error: 'erro interno' }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Painel Financeiro ouvindo na porta ' + PORT));
}

module.exports = { server, buildIndicators, buildNews, parseFeed, categorize, cached };
