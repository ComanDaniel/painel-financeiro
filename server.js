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
const FEEDS = [
  { name: 'InfoMoney',        url: 'https://www.infomoney.com.br/feed/' },
  { name: 'Money Times',      url: 'https://www.moneytimes.com.br/feed/' },
  { name: 'G1 Economia',      url: 'https://g1.globo.com/rss/g1/economia/' },
  { name: 'Agência Brasil',   url: 'https://agenciabrasil.ebc.com.br/rss/economia/feed.xml' },
  { name: 'Exame',            url: 'https://exame.com/feed/' },
  { name: 'CNN Brasil',       url: 'https://www.cnnbrasil.com.br/economia/feed/' },
  { name: 'Investing.com BR', url: 'https://br.investing.com/rss/news.rss' }
];

// Cotações (Yahoo Finance, endpoint público não oficial).
const QUOTES = [
  { id: 'ibov',   group: 'mercado',  name: 'Ibovespa',         sym: '^BVSP',   unit: 'pts', dec: 0 },
  { id: 'sp500',  group: 'exterior', name: 'S&P 500',          sym: '^GSPC',   dec: 2 },
  { id: 'nasdaq', group: 'exterior', name: 'Nasdaq Composite', sym: '^IXIC',   dec: 2 },
  { id: 'dow',    group: 'exterior', name: 'Dow Jones',        sym: '^DJI',    dec: 2 },
  { id: 'ust10',  group: 'exterior', name: 'Treasury 10 anos', sym: '^TNX',    kind: 'yield' },
  { id: 'brent',  group: 'commod',   name: 'Petróleo Brent',   sym: 'BZ=F',    prefix: 'US$ ', dec: 2 },
  { id: 'ouro',   group: 'commod',   name: 'Ouro (oz)',        sym: 'GC=F',    prefix: 'US$ ', dec: 2 },
  { id: 'btc',    group: 'commod',   name: 'Bitcoin',          sym: 'BTC-USD', prefix: 'US$ ', dec: 0 }
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
  return { price, prev, t: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now() };
}

const awesomeFx = () => fetchJson('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL');

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
  const groups = { mercado: [], juros: [], atividade: [], exterior: [], commod: [] };

  const settle = (id, p) => p.then((v) => ({ id, v }), (e) => { errors.push({ id, error: errMsg(e) }); return { id, v: null }; });

  const quoteJobs = QUOTES.map((q) => settle(q.id, cached('y:' + q.sym, TTL.quotes, () => yahooQuote(q.sym))));
  const fxJob = settle('fx', cached('fx', TTL.fx, awesomeFx));
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

  const [quoteRes, fx, focusRes] = await Promise.all([Promise.all(quoteJobs), fxJob, focusJob]);
  const S = {};
  for (const k of Object.keys(sgsJobs)) S[k] = (await sgsJobs[k]).v;

  // --- Mercado brasileiro: dólar/euro
  if (fx.v && fx.v.USDBRL) {
    const o = fx.v.USDBRL;
    const pct = parseFloat(o.pctChange);
    groups.mercado.push({ id: 'usd', name: 'Dólar comercial', value: 'R$ ' + nf(parseFloat(o.bid), 4),
      delta: signed(pct), tone: toneOf(pct), t: Number(o.timestamp) * 1000 || Date.now(), note: 'Cotação de compra (AwesomeAPI)' });
  } else if (S.usdSgs) {
    const a = S.usdSgs, l = a[a.length - 1], p = a[a.length - 2];
    const pct = p ? (l.valor / p.valor - 1) * 100 : 0;
    groups.mercado.push({ id: 'usd', name: 'Dólar comercial', value: 'R$ ' + nf(l.valor, 4),
      delta: p ? signed(pct) : '', tone: toneOf(pct), note: 'PTAX/BCB de ' + l.data });
  }
  if (fx.v && fx.v.EURBRL) {
    const o = fx.v.EURBRL;
    const pct = parseFloat(o.pctChange);
    groups.mercado.push({ id: 'eur', name: 'Euro', value: 'R$ ' + nf(parseFloat(o.bid), 4),
      delta: signed(pct), tone: toneOf(pct), t: Number(o.timestamp) * 1000 || Date.now(), note: 'Cotação de compra (AwesomeAPI)' });
  }

  // --- Cotações Yahoo
  QUOTES.forEach((q, i) => {
    const r = quoteRes[i].v;
    if (!r) return;
    let item;
    if (q.kind === 'yield') {
      const v = r.price > 20 ? r.price / 10 : r.price; // alguns feeds trazem o yield x10
      const pv = r.prev > 20 ? r.prev / 10 : r.prev;
      const diff = pv != null ? v - pv : 0;
      item = { id: q.id, name: q.name, value: nf(v, 3) + '%', delta: pv != null ? signed(diff, 3, ' p.p.') : '', tone: 'flat', t: r.t, note: 'Rendimento do título americano' };
    } else {
      const pct = r.prev ? (r.price / r.prev - 1) * 100 : 0;
      item = { id: q.id, name: q.name, value: (q.prefix || '') + nf(r.price, q.dec), unit: q.unit,
        delta: r.prev ? signed(pct) : '', tone: toneOf(pct), t: r.t };
    }
    groups[q.group].push(item);
  });

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

  const titles = { mercado: 'Mercado brasileiro', juros: 'Juros e inflação', atividade: 'Atividade, emprego e previdência', exterior: 'Exterior', commod: 'Commodities e cripto' };
  return {
    updatedAt: Date.now(),
    groups: Object.keys(titles).map((k) => ({ id: k, title: titles[k], items: groups[k] })).filter((g) => g.items.length),
    focus: focusRes.v || null,
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

const CATS = [
  ['Juros & Inflação',      /\b(selic|copom|ipca\w*|igp-?m|inpc|inflac\w*|deflac\w*|juros|taxa basica|focus|cdi|di futuro)\b/],
  ['Trabalho & Previdência', /\b(inss|fgts|previdenc\w*|trabalhist\w*|clt|esocial|aposentador\w*|salario minimo|seguro-desemprego|imposto de renda|irrf|irpf|folha de pagamento|sindicat\w*|caged|pasep|reforma tributaria)\b/],
  ['Commodities & Cripto',  /\b(petroleo|brent|wti|ouro|bitcoin|btc|cripto\w*|ethereum|commodit\w*|minerio|soja|etanol|gasolina|diesel|opep)\b/],
  ['Mundo',                 /\b(fed|federal reserve|eua|estados unidos|wall street|china|europa|zona do euro|japao|bce|trump|nasdaq|s&p|dow jones|treasuries|ormuz|oriente medio|tarifa\w*)\b/],
  ['Política & Fiscal',     /\b(governo|fiscal|arcabouco|congresso|senado|camara|eleic\w*|lula|haddad|orcamento|divida publica|meta fiscal|stf|pec|bolsa familia|imposto\w*|tribut\w*)\b/],
  ['Atividade & Emprego',   /\b(pib|desemprego|emprego\w*|desocupac\w*|pnad|industri\w*|varejo|vendas|producao|ibc-?br|atividade economica|consumo)\b/],
  ['Mercados',              /\b(ibovespa|bolsa|b3|dolar|acoes|acao|cambio|fundos|fii\w*|dividendos|balanco|mercado)\b/]
];
const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function categorize(title, summary) {
  const t = strip(title);
  for (const [name, re] of CATS) if (re.test(t)) return name;
  const full = strip(title + ' ' + (summary || ''));
  for (const [name, re] of CATS) if (re.test(full)) return name;
  return 'Economia';
}

async function buildNews() {
  const results = await Promise.allSettled(
    FEEDS.map((f) => cached('feed:' + f.url, TTL.feed, async () => parseFeed(await fetchText(f.url, { Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' }), f.name)))
  );
  const sources = [];
  let all = [];
  results.forEach((r, i) => {
    const f = FEEDS[i];
    if (r.status === 'fulfilled') {
      const newest = r.value.slice().sort((a, b) => b.ts - a.ts).slice(0, 30);
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
    .slice(0, 120)
    .map((n) => ({ title: n.title, link: n.link, source: n.source, ts: n.ts, summary: n.summary, cat: categorize(n.title, n.summary) }));
  return { updatedAt: Date.now(), items, sources };
}

/* ======================================================================
   HTTP
   ====================================================================== */
const INDEX_PATH = path.join(__dirname, 'index.html');
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
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
