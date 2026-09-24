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
  favicon: { type: 'image/x-icon', data: Buffer.from('AAABAAIAEBAAAAAAIADWAgAAJgAAACAgAAAAACAA3QEAAPwCAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAKdSURBVHicdZNBbFRVFIa/c9/tvEfLzJQSakumZrAYpCuqMRBMxIU6hGBCCHEDi5ZVCSt3blixNaQrdk0gISHGNGgEAnFh3Bg0xrpRo5KiVmiDQuswM51O7z2HRYdpa+Sszua75/z/+a8ADJZLFSfJOcMOmKqYmQPADMMwAzDMTAUxupI7hp7/+/f52zJQLh9yTm+JkamqAWJmbRg6fVRMDTMzq64IqW+6QnpYBstD3zsnoxo1AL4DtB/ADFNDtngkTSARiuOvhuWv//RPbv4y40VkVKPa82C8Iz6ss33iDfrG9hNadfK79/gHXdetOv3jqDNV3bT2xslm2GrEFVOWLv/AvcoUcalJXK6ji00xQZ2ZuU2aWStz0vbRkDRhZfYf+j7YD0F5dO0bci/3oRacX3e7bZiArUZ0OeDyOQQID2sU3ttL3+nXuff2FNKTI9mW4bpz+E0woCuBZFtGdrBE7eZvJDt6kMwzMHmEx1PfUvtqlqS3G20GXD7FWVsrZuDAGqu8MFmhPD1G4f0RGnML9H/0LgALH36B789DmuDyOSwqvuN2lyPM1yiO76P7rV3MTXzCzkvHyF4bonhihL9OTaP1Fkm6BYJ2zPadUz1q0PPOLgYvHuX++DUWL39HXFxm+OMzPLjwGdXPf8bvLGLNgMm6ZNlRGohEdbHWYvinszy58Sv3Jz4lfXE7rfkqWyvDtO4+JizUIJH/nlmlvzRgYalpQzdOiss8fxy9AomAGjghVpuQSxAva1Fehw0Qt/pvfSZ/7BXpefOlMHf8KtoKzz4OGiKyNfd/cBAQU5uRXp8dykZLt7pKhaz25axJ5sWidpL4LEwbehNBVK2JcFgACnRXXJqcS3rTAxqjAG5TnDdoXluPO9Hi+Ua1cfspV+SqSrxp0t4AAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6evQAAAGkSURBVHicxZdNbsIwEIVfLE5Q2hBohYRU4HyF9hL89HwE1oXSdlOJ/evCsbGDExPA7qzG1pt8M/6NEzisN+gTJACAAJQv3aMPEqzwXbHf231SZlkdvUGfdR+4Bm7G/uy+NFfEhoNEO3vQHSI2XLXanXvqBGLDTT8JteDKscPdVDfzbKG1rRDw548X1JqhFbeGW7EeI4lWCPim927pR8bwl7Ui9IKrg8sEIsHzzvwkEZDFGgi01XxwAhCh4KPP1xLPrU2y/iPLnbeE5515rVbcGm5uQh8cKHbBxYeMI3ZsVO+DyzVwAXy4nXjhq3TmhVdOgbdy4Hi2q1hDey4ccEyBC24O5aa71P5oN9Xa8f4NJ+b5NgEk6VOXVQIFH24nur0uEnCdcIBR/RlwawqawEHKK/VKOGDcBU3gSlt3wp0DlwlUwE1zwctVr9JZYzjJYhs64Gb1VXClvRQuR8ADX3eXtXAruYZwmcA/wvUucP1GxYATgDCfS9a8R4Affg+J9S5Qq32dLYLDlenq9XMpQuWArN5KAJDPpZjwkwSU3aVthoCbYGV/rlx0h6I/MGkAAAAASUVORK5CYII=', 'base64') },
  icon180: { type: 'image/png', data: Buffer.from('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', 'base64') },
  icon192: { type: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAO9klEQVR4nO2d3ZIUNxKFz0z4BTwDDLBhxzpijZ9v7d2XMMbPB/h6+TFw4Q32uvaCUVOlTkkpKVWtks65cbglvslpvlRpmlHVFTrL079/t2jmRSctKkScW8HYAr9yiomJWtTcgu/p7E9Uvi8f3ry/qgIY56LFPP3h+5Ud+jeW8q+GjTgqtuH7siZ9fPvnxTzc/QtvpHeh/EmGOGzEUbEbye9n72bY7YuJ4gOUX8EQh404KvZO8q+zVyM0/yJB8QHKr2CIw0YcFfsC8q/TuhGawaPiA5RfwRCHjTgq9oXlX6dVI5hDk+IDlF/BEIeNOCp2R/Kva/n47oOps9eWMMpP+X2OpfwA8ODxQ6PivsSkm1TiA5RfwRCHjTgqdsfyn16+/+8ng6tB9RWA8nvsCoY4bMRRsQ8kPwDcGlwNqhqA8nvsCoY4bMRRsQ8mv0ttExQ3AOX32BUMcdiIo2IfVH6XmiYoagDK77ErGOKwEUfFPrj8LqVNkN0AlN9jVzDEYSOOij2I/C4lTZDVAJTfY1cwxGEjjoo9mPyOc3v3IOuPqRuA8nvsCoY4bMRRsQeV3yWnCVQNQPk9dgVDHDbiqNiDy++ibYJkA1B+j13BEIeNOCr2JPK7aJrA5lchKH+SIQ4bcVTsyeTXJtoA/N0eyu9zjiZ/6ioQbADKT/l9ztHkd+ybSBOUb4Eof5IhDhtxVGzKn4zYADzMUs8Qh404Kjbl3yR0Fci/AlD+JEMcNuKo2JRfnbMG4BneOoY4bMRRsSl/kHHz6PZsWH8FoPxJhjhsxFGxKX82Y9MAvHVJOUMcNuKo2JRfxfCvAukrAOVPMsRhI46KTfmLGacG4B3byhjisBFHxab82Yz1VSB8BaD8SYY4bMRRsSl/NUNuAMqfZIjDRhwVm/JXM4D7BuBdmvMY4rARR8Wm/NUMtw36xryITE6QS/llttH78o///NOE0zKvH/929prVyu/ydQtE+ZMMcdiIo2I3eF96zrN3/9r8v7X8gGsAyp9kiMNGHBW7p23PjnFN0EJ+IPN3gSj/atiIo2JPKr+LfyU4xeB9ueYzueIMcdiIo2JPLr/LT34TVL4vC4BvH94sqisA5V8NG3FUbMovx0B+x0g2AOVfDRtxVGzKL8dQfiDRAJR/NWzEUbEpvxxj+YFIA1D+1bARR8Wm/E0iyQ8EGoDyr4aNOCo25W+SkPyA/y/BoPybYSOOir2z/H88/T3KEF8uqMVP8CPNRonJD3hXAMq/GjbiqNg9rfwTyQ+sGoDyr4aNOCo25W8SjfzAfQNQ/tWwEUfFnkT+vaOVHwCuKf9q2IijYk8k/56rf478gNGJMLGISsYWSPllMOXflBCpI5TqE2FiEZWMLZDyy+D+5d8zJfIDUgNQ/iKOij2Z/Hut/qXyA34DUP4ijopN+ZukRn6g8ESYWEQlYwuk/DL4GPLvlVr5gYITYWIRBoV8BVJ+GXwc+XNW/1d3z3O/+pcSFHVock35yzgqNuVvEiv5gYoHZFD+BHtC+XNTsvpbyo9lKWsAyp9gTyp/662PtfxAwRWA8ifYlL9dGjhXdlcIyi+zJ5U/N6U/+JrE+37UDUD5E+yJ5d/jUx+TeN/PAmUDUP4Em/L3H0F+IOeuEJRfZk8sf24utvoH5Ae0d4Wg/DJ7cvkPsfWJyA9o7gpB+WU25c+l75+E/EDqrhCUX2ZPLn8u+yKrv0J+QGgAyp9gU/7z+3RG0rP8QOiuEJRfZlP+LPkvkgz5AemuEJRfZlP+7GhWf9PPmzLlB/y7QlB+mU35AdhvfZbMOuKwfPmB9V0hKL/MpvwA7Lc+PcgPGByICRVC+becI8ufm9Tq34v8QOWBmFAhlH/LObr8llufnuQHKg7EhAqh/FvOTPKruB3Jj6XwQEyoEMq/5Rxd/tzEVv8e5QdqrwCUPwAeQ36rrU+v8gM1DUD5A+D55E9yO5UfEB6QkQuh/FvOCPLnJrT6a+V/+ejX9BdpID9QcgWg/AHwOPJbbH16X/ld8hqA8gfAc8of5R5AfiCnASh/ADyO/LmRVv8jyQ9oG4DyB8BjyV+79Tma/ICmASh/ADyv/EHuweQHUg1A+QPgseTPfV/81f+o8i9QPiKJ8m85o8n/0/t/qzkjyQ8oHpFE+becmeUXuQeWH0g8IonybzmjyZ+b9eo/gvxA5BFJlH/LGVH+0q3PKPIDgUckUf4tZ3b5z7iDyA8IJ8Io/5Yzovy5cav/aPID3okwyr/ljCp/ydZnRPkB6bYoxoVQfu9lI04Wu1D+DXdA+bEs3m1RjAuh/N7LRpwsdsX78uru+dDyA+vbohgXQvm9l404WWyPkbv1GV1+oPREGOUPMsSXjThZ7Ar5T9zB5QcqD8QUFaDkqNiUv5oh5eXd8ynkByoOxBQVoOSo2JRfzchZ/WeSH8g5E0z58eObnzf//8fT34eSP7eOHE6P8gMFB2KKClByVOwLyP/jm5/P5Hevi+iCWtRTDRihqA6na3IQ+YHMAzFFBSg5KvaF5I+Ov/1liy6oRT01k5G19ZlQfiDjQExRARmFJNkdyn+ad98ER5XfLAeTH1AeiCkqILOQKLtj+U/zvSuBphb1VANGLCar/wHlBxQHYooKKCgkyO7p055EnmmboLH8u299Dio/kDgQU1RAYSEiu5NPe3KSbIKO5DfJgeUHIgdiigqoKGQE+V2CTdDRtgcwWP0PLj8AXN1993TRACh/WV4/eXGqRZtS+Xfd+gwg/wLlI5JmkL9Vnr39pTv5qzOI/IDiEUmzyN9i9Xd5przp1B7bHqBy9R9IfiDx7wCU3y6pJqiRf7etz2DyY4k8Ionyyznt6QsSaoK95K/KgPIDgSvALPLnxslv2QR7bXuAitV/UPkBoQFmkr9m62PRBLXy77L1GVh+wGsAyh+OJPzrJy+KGyH4M0ED+YszuPxAyV0hKH/2eChntyRvsO0BClf/CeQHkHlXiAHkz41K7mXB68e/FfFPTZDxvjTf+kwiP5BzV4hB5Df/yHP1PVU3gWZu663PRPIDRifCkkUUMmTwfvInV3/heypuggZiZ6/+k8kPGJwISxZRyJDBfct/+rONmqDp1mdC+YHKE2HJIgoZMni/3+2pkf/EMG6CplufSeUHKk6EJYsoZMjgOvlN9/0Z39OriiaoET5r9Z9YfqDwRFiyiEKGDN5X/ujqX/BbnaVNAHxd9ZttfSaXHyg4EZYsopAhg48tv4tFE5iH8gPIPBGWLKKikHPwvr/P30p+F+nB0tZRr/6U/xTxEUlFRVQW4nNqSWb7fgP5HaNlE1D+sqhOhCWLMChkzdlb/uDqbyi/yx5XgmAo/1mSJ8KSRRgV4jgjy+9i3QSq1Z/yi8m+PXrP8ufWcgn5XV7dPTdpBMpfkSVyIixZhHEhFvJn350twFFPNWA03xJR/gD0C0fdAKPJL67+O8vvUtoEydWf8gegy4mtagDK702N1FKa3Cag/IVZyQ8oGqB3+XPTo/yOO+stypPcRvIDubdF6VD+6n1/J/I7hqYJonMofwB6Lj8QaYAR5T9b/TuT38UJ7ov+8tGvlL8IKssPAFeP/vb43PUAwKIQyu9xjf+SN+xKRnCaESfK3UF+QHNbFMofraU0lD/C3Ul+IHVblA7lrw7lTzKC04w4Ue6O8gOx26J0Kn/V6k/5k4zgNCNOlLuz/EDotiiUP1lLSSh/hHsB+QHptiiUP1lLSSh/hHsh+QGDAzGhQi6556f8eYzgNCNOlHtB+YHKAzGhQqzlL/7HLsqfZASnGXGi3AvLD1QciAkVcmn593wml4pL+WVuB/IDhQdiQoVQfo9L+WVuJ/IDBQdiQoVccs8PUP4cRnCaESfK7Uh+LJkHYkKQFvIX7fspf5IRnGbEiXI7kx+ovQJ0Iv/rJy8ov4IRnGbEiXI7lB+oaQDKf86l/DK3U/mB0gboYM8PUH4tIzjNiBPldiw/UNIADeXP3vdT/iQjOM2IE+V2Lj+Q2wAdyZ9z+3HK700z4kS5B5AfyGkAyn/Opfwy9yDyL8h4RFIr+XO5lD/NCE4z4kS5B5IfUD4iqaX8zyxuZhVg59SSxaX8Mvdg8gOKRyT1JL929af83jQjTpR7QPmBxCOSKL/Hpfwy96DyA5FHJPWy5wcof4oRnGbEiXIPLD8QeERSa/lb7PspvzfNiBPlHlx+QDgR1pv8mtWf8nvTjDhR7gDyA8D1hzfvrxyE8ntcyi9zB5H/81+fr04nwnra8wOUP8YITjPiRLmDyO8i3xbFqJD1q9b7fsrvTTPiRLmDyQ9YnAhrIH9q9af83jQjTpQ7oPyAwYGYVBGUn/L7nC7kv+dcA8DHt39eWRVS881RfpkRnGbEiXIHlf/zf/93BVQciNEUYbnvp/zeNCNOlDuo/OsUHYjRFGG59aH83jQjTpQ7gfzAqgFU26AG2x6A8kuM4DQjTpQ7uPxu+wNkHoipLkII5T9nBKcZcaLcweX3s2mA4FWgkfyxUH5vmhEnyp1A/vXqDygPxJQUIT6O1J8TWP0pvzfNiBPlTiC/lLMG2FwFKlf+WBNQfsofY4hDlRx/9QcSB2Kqi4AsOuWn/DGGOGTE8RP85OfB44dnlOxvLqMQyu9NM+JEuRPJL63+QManQJSf8svQ/uWPJdgAH999OHUM5af8MvQY8odWfyCyBXK5FbZCpYWcTTVgBLmUX+ZS/k1sHpChKORsqgEjyKX8Mncy+TVJNsCn1VbIqhDK700z4kS5E8qfWv0B5RUg2QSUP8kITjPiRLmUPxj1FijYBJQ/yQhOM+JEuZQ/mqyfAc6agPInGcFpRpwol/Ink/1D8KkJKH+SEZxmxIlyKb8q+Uch73N790BVO+X3phlxolzKr07xx6Cf3n9MfkHK700z4kS5lD8rVf8OEGsCyu9NM+JEuZQ/O9X/ECY1AeX3phlxolzKX5RqwDq3dw/CJVP+Kk6UO5n8FuK7mDYAANxIPxxT/ipOlEv5q2LeAC6nRqD8VZwodyL5rcV3adYALjePbovfV8of4U4ifyvxXZo3gEtuI1D+CHcC+VuL77JbA7hoGoHyR7iDy7+X+C67N8A6UjNQ/gh3UPn3ln6dizaAlG8f3tj8LVP+APSy8n/+63NXzv0fGahAQgmcDRMAAAAASUVORK5CYII=', 'base64') },
  icon512: { type: 'image/png', data: Buffer.from('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', 'base64') }
};
const MANIFEST = JSON.stringify({
  name: 'Painel Financeiro',
  short_name: 'Painel Financeiro',
  description: 'Notícias, calendário econômico, câmbio e indicadores de mercado em tempo real.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0d0c',
  theme_color: '#0b0d0c',
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
