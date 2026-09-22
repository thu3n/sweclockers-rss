/**
 * FyndRadar - SweClockers Deals Ranking
 *
 * Fetches RSS feeds from SweClockers "Dagens fynd" and "Övriga fynd",
 * parses deal data, and renders a filterable/sortable ranking grid.
 * Optionally uses OpenAI API to score and rank deals.
 */

// ============================================================
// Constants
// ============================================================

/**
 * Primär datakälla: flödena hämtas av GitHub Actions (scripts/fetch-feeds.mjs)
 * var 15:e minut och sparas i data/. Sidan läser dem same-origin, helt utan
 * CORS-proxy. Proxyerna nedan är bara en sista reserv om data/ saknas
 * (t.ex. när sidan öppnas lokalt via file://).
 */
const LOCAL_DATA_DIR = 'data';

/** Publika CORS-proxies - opålitliga, används bara som reserv. */
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

/** Proxies som svarat med hårt fel (401/403/429/timeout) hoppas över resten av sessionen. */
const deadProxies = new Set();

const FEEDS = [
  {
    url: 'https://www.sweclockers.com/feeds/forum/trad/999559',
    threadUrl: 'https://www.sweclockers.com/forum/trad/999559',
    source: 'tech',
    label: 'Teknik',
  },
  {
    url: 'https://www.sweclockers.com/feeds/forum/trad/1465406',
    threadUrl: 'https://www.sweclockers.com/forum/trad/1465406',
    source: 'other',
    label: 'Övrigt',
  },
];

/** Hur ofta sidan tyst kollar efter nya fynd (ms). */
const AUTO_REFRESH_INTERVAL = 10 * 60 * 1000;

/** localStorage-nycklar för användarens egna data. */
const LS_FAVORITES = 'fyndradar_favorites';
const LS_HIDDEN = 'fyndradar_hidden';
const LS_LAST_VISIT = 'fyndradar_last_visit';
const LS_WATCH_WORDS = 'fyndradar_watch_words';
const LS_THEME = 'fyndradar_theme';
const LS_SNAPSHOT = 'fyndradar_snapshot_v1';
const LS_NOTIFIED = 'fyndradar_notified';

/** Text som tyder på att fyndet inte längre gäller. */
const SOLD_OUT_RE = /slutsåld|slut i lager|sold out|utgång(?:et|en)|utgått|expired|inte längre|gäller ej|edit:?\s*slut/i;

const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/** localStorage key prefix for cached rankings */
const CACHE_KEY_PREFIX = 'fyndradar_rankings_';

// ============================================================
// State
// ============================================================

/** @type {Deal[]} */
let allDeals = [];

/** @type {Deal[]} */
let displayDeals = [];

/** @type {Map<string, AiRanking>} */
let aiRankings = new Map();

let isAiRanked = false;

/** Metadata från data/meta.json (när flödena senast hämtades av GitHub Actions). */
let dataMeta = null;

/** Hur flödena hämtades senast: 'local' (data/) eller 'proxy'. */
let lastDataSource = null;

/** Pågår en (om)laddning just nu? */
let isLoading = false;

/** Användarens sparade fynd (inläggs-URL:er). */
let favorites = new Set(loadJsonFromStorage(LS_FAVORITES, []));

/** Fynd användaren dolt. */
let hiddenDeals = new Set(loadJsonFromStorage(LS_HIDDEN, []));

/** Tidsstämpel (ms) för föregående besök - allt nyare markeras som nytt. */
const previousVisitAt = Number(localStorage.getItem(LS_LAST_VISIT) ?? 0) || 0;

/** Bevakningsord för notiser. */
let watchWords = loadJsonFromStorage(LS_WATCH_WORDS, []);

/** Prishistorik från data/history.json: prisjaktId -> [{ d, p, post }]. */
let priceHistory = {};

/** Länkstatus från data/status.json: inläggs-URL -> 'gone' | 'ok'. */
let linkStatus = {};

/** Visa bara sparade fynd? */
let showFavoritesOnly = false;

/** Visa dolda fynd (för att kunna ångra)? */
let showHidden = false;

function loadJsonFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* kvoten full - ignorera */
  }
}

// ============================================================
// DOM References
// ============================================================

const sourceFilter = document.getElementById('source-filter');
const categoryFilter = document.getElementById('category-filter');
const sortSelect = document.getElementById('sort-select');
const searchInput = document.getElementById('search-input');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const openaiKeyInput = document.getElementById('openai-key');
const aiRankBtn = document.getElementById('ai-rank-btn');
const statusText = document.getElementById('status-text');
const dealCount = document.getElementById('deal-count');
const dealsGrid = document.getElementById('deals-grid');
const aiBanner = document.getElementById('ai-banner');
const aiBannerText = document.getElementById('ai-banner-text');
const aiClearBtn = document.getElementById('ai-clear-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const refreshBtn = document.getElementById('refresh-btn');
const storeFilter = document.getElementById('store-filter');
const favoritesToggle = document.getElementById('favorites-toggle');
const themeToggle = document.getElementById('theme-toggle');
const statsStrip = document.getElementById('stats-strip');
const watchWordsInput = document.getElementById('watch-words');
const notifyBtn = document.getElementById('notify-btn');
const notifyStatus = document.getElementById('notify-status');
const showHiddenBtn = document.getElementById('show-hidden-btn');

let currentSourceFilter = 'all';

// ============================================================
// Types (documented via JSDoc)
// ============================================================

/**
 * @typedef {Object} Deal
 * @property {string} id - Unique post URL
 * @property {string} title - Product name
 * @property {string} description - Full text content
 * @property {string} author - Forum username
 * @property {string} link - Permalink to the post
 * @property {string} pubDate - ISO date string
 * @property {number|null} price - Numeric price in SEK, null if unparseable
 * @property {string} category - Product category
 * @property {string} source - 'tech' | 'other'
 * @property {string} sourceLabel - Human-readable source name
 * @property {string[]} productLinks - Links to buy the product
 * @property {string[]} prisjaketLinks - Prisjakt/Pricerunner comparison links
 */

/**
 * @typedef {Object} AiRanking
 * @property {number} rank - 1-based rank position
 * @property {number} score - 0-100 score
 * @property {string} reason - Why the AI ranked it here
 */

// ============================================================
// RSS Parsing
// ============================================================

/**
 * Fetches a URL through CORS proxies with fallback.
 * Tries each proxy in order until one succeeds.
 * @param {string} targetUrl - The original URL to fetch
 * @returns {Promise<string>} The response text
 */
async function fetchWithCorsProxy(targetUrl, expectXml = false) {
  for (let i = 0; i < CORS_PROXIES.length; i++) {
    if (deadProxies.has(i)) continue;
    const proxyUrl = CORS_PROXIES[i](targetUrl);
    try {
      const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const text = await response.text();
        if (expectXml) {
          // Sanity check: response should look like XML
          if (text.includes('<rss') || text.includes('<channel')) {
            return text;
          }
        } else {
          return text;
        }
      } else if ([401, 403, 429].includes(response.status)) {
        // Kräver API-nyckel, blockerar domänen eller ratebegränsar - lönlöst att fortsätta fråga.
        deadProxies.add(i);
        console.warn(`Proxy ${i + 1} avstängd för sessionen (HTTP ${response.status})`);
      }
    } catch (err) {
      // Timeout eller nätverksfel (ofta nere helt) - hoppa över resten av sessionen.
      deadProxies.add(i);
      console.warn(`Proxy ${i + 1}/${CORS_PROXIES.length} failed for ${targetUrl}:`, err.message ?? err);
    }
  }
  throw new Error(`Alla CORS-proxies misslyckades för ${targetUrl}`);
}

/**
 * Hämtar en fil från data/ (skapad av GitHub Actions) same-origin.
 * Cache-bustas med tidsstämpel så att GitHub Pages inte serverar en gammal kopia.
 * @param {string} name - Filnamn i data/
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchLocalData(name, timeoutMs = 8000) {
  const url = `${LOCAL_DATA_DIR}/${name}?t=${Math.floor(Date.now() / 60000)}`;
  const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} för ${url}`);
  return response;
}

/**
 * Hämtar data/meta.json och data/images.json. Fel ignoreras tyst - de är
 * bara förbättringar ovanpå flödena.
 */
async function loadLocalMetadata() {
  const [metaRes, imagesRes, historyRes, statusRes] = await Promise.allSettled([
    fetchLocalData('meta.json').then((r) => r.json()),
    fetchLocalData('images.json').then((r) => r.json()),
    fetchLocalData('history.json').then((r) => r.json()),
    fetchLocalData('status.json').then((r) => r.json()),
  ]);

  if (metaRes.status === 'fulfilled' && metaRes.value?.updatedAt) {
    dataMeta = metaRes.value;
  }
  if (historyRes.status === 'fulfilled' && historyRes.value && typeof historyRes.value === 'object') {
    priceHistory = historyRes.value;
  }
  if (statusRes.status === 'fulfilled' && statusRes.value?.status && typeof statusRes.value.status === 'object') {
    linkStatus = statusRes.value.status;
  }

  if (imagesRes.status === 'fulfilled' && imagesRes.value && typeof imagesRes.value === 'object') {
    let seeded = 0;
    for (const [dealId, imageUrl] of Object.entries(imagesRes.value)) {
      if (typeof imageUrl !== 'string' || !imageUrl) continue;
      // Server-upplöst bild vinner över tidigare klientmisslyckanden.
      if (!productImageCache[dealId] || productImageCache[dealId] === 'FAILED') {
        productImageCache[dealId] = imageUrl;
        seeded++;
      }
    }
    if (seeded > 0) saveImageCache();
  }
}

/**
 * Parses an XML string into Deal objects.
 * @param {string} xmlText - Raw RSS XML
 * @param {{ source: string, label: string }} meta - Feed metadata
 * @returns {Deal[]}
 */
function parseRssXml(xmlText, meta) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const items = doc.querySelectorAll('item');

  /** @type {Deal[]} */
  const deals = [];

  items.forEach((item) => {
    const rawDesc = item.querySelector('description')?.textContent ?? '';
    const link = item.querySelector('link')?.textContent ?? '';
    const author = (item.querySelector('title')?.textContent ?? '').replace(/^Av:\s*/, '');
    const pubDate = item.querySelector('pubDate')?.textContent ?? '';

    const parsed = parseDescription(rawDesc);

    // Pre-seed the image cache with any direct image URLs found in the description.
    // This gives instant images for deals where the forum user embedded CDN links
    // (e.g. next-media.elkjop.com) without requiring a separate scraping round-trip.
    if (parsed.imageLinks.length > 0 && !productImageCache[link]) {
      productImageCache[link] = parsed.imageLinks[0];
    }

    const storeUrl = parsed.productLinks[0] ?? '';
    const prisjaktId = parsed.prisjaketLinks
      .map((u) => u.match(/[?&]p=(\d+)/)?.[1] ?? u.match(/prisjakt\.nu\/(?:en\/)?product(?:\.php)?\/?(\d+)/)?.[1])
      .find(Boolean) ?? null;

    deals.push({
      id: link,
      postId: link.match(/\/post\/(\d+)/)?.[1] ?? link,
      title: parsed.productName,
      description: parsed.cleanText,
      author,
      link,
      pubDate: pubDate ? new Date(pubDate).toISOString() : '',
      price: parsed.price,
      originalPrice: parsed.originalPrice,
      discountPct: parsed.discountPct,
      soldOut: parsed.soldOut,
      category: parsed.category,
      source: meta.source,
      sourceLabel: meta.label,
      productLinks: parsed.productLinks,
      prisjaketLinks: parsed.prisjaketLinks,
      prisjaktId,
      store: storeUrl ? extractStoreName(storeUrl) : '',
      storeDomain: storeUrl ? safeHostname(storeUrl) : '',
    });
  });

  return deals;
}

/**
 * Fetches and parses a single RSS feed into Deal objects.
 * @param {{ url: string, source: string, label: string }} feedConfig
 * @returns {Promise<Deal[]>}
 */
async function fetchFeed(feedConfig) {
  // 1. Primärt: förhämtad kopia i data/ (same-origin, ingen CORS).
  try {
    const res = await fetchLocalData(`feed-${feedConfig.source}.xml`);
    const xmlText = await res.text();
    if (xmlText.includes('<rss') || xmlText.includes('<channel')) {
      lastDataSource = lastDataSource === 'proxy' ? 'proxy' : 'local';
      return parseRssXml(xmlText, feedConfig);
    }
    console.warn(`data/feed-${feedConfig.source}.xml såg inte ut som RSS`);
  } catch (err) {
    console.warn(`Lokal data saknas för ${feedConfig.label}, provar proxy:`, err.message ?? err);
  }

  // 2. Reserv: publik CORS-proxy direkt mot SweClockers.
  try {
    const xmlText = await fetchWithCorsProxy(feedConfig.url, true);
    lastDataSource = 'proxy';
    return parseRssXml(xmlText, feedConfig);
  } catch (err) {
    console.error(`Feed fetch failed for ${feedConfig.url}:`, err);
    return [];
  }
}

/** Image URL extensions that identify a direct image link. */
const IMAGE_EXTS = /\.(?:jpe?g|png|gif|webp|svg)(\?[^"'>]*)?$/i;

/**
 * Image CDN hostnames we trust as direct product image sources.
 * Checked before scraping to avoid unnecessary proxy calls.
 */
const TRUSTED_IMAGE_HOSTS = [
  'next-media.elkjop.com',
  'postimg.cc',
  'i.postimg.cc',
];

/**
 * Parses HTML description from RSS item to extract structured deal data.
 * @param {string} html - Raw HTML string from RSS description
 * @returns {{ productName: string, price: number|null, category: string, cleanText: string, productLinks: string[], prisjaketLinks: string[], imageLinks: string[] }}
 */
function parseDescription(html) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  const textContent = tempDiv.textContent ?? '';

  // Extract product name - look for "Produkt:" field first
  let productName = '';
  const produktMatch = textContent.match(/Produkt:\s*(.+?)(?:\n|$)/);
  if (produktMatch) {
    productName = produktMatch[1].trim();
  } else {
    // Inget "Produkt:"-fält - använd första meningen, kapad till rimlig rubriklängd.
    const firstLine = (textContent.trim().split('\n')[0] ?? '').trim();
    const sentence = firstLine.match(/^(.{12,90}?[.!?])(\s|$)/)?.[1] ?? firstLine;
    productName = sentence.length > 90 ? sentence.substring(0, 88).replace(/\s+\S*$/, '') + '…' : sentence;
  }

  // Extract price - Swedish format: 8.243 kr = 8 243 SEK (dot = thousands, comma = decimal)
  let price = null;
  const pricePatterns = [
    /Pris:\s*([\d\s.,]+)\s*(?:kr|:-)/i,
    /([\d][\d\s.,]*)\s*kr/i,
  ];
  for (const pattern of pricePatterns) {
    const match = textContent.match(pattern);
    if (match) {
      const raw = match[1].trim();
      // Remove whitespace and thousands-separator dots, then swap decimal comma → dot
      const cleaned = raw
        .replace(/\s/g, '')       // remove spaces (e.g. "8 243")
        .replace(/\./g, '')       // remove thousand-sep dots (e.g. "8.243" → "8243")
        .replace(',', '.');       // swap decimal comma if present (e.g. "2.146,59" → "214659" → "2146.59")
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed) && parsed > 10 && parsed < 10000000) {
        price = Math.round(parsed);
        break;
      }
    }
  }

  // Ordinarie pris och rabatt - "ord. pris 1 499 kr", "tidigare 999:-", "(1 299 kr)", "nedsatt 71 %", "-40%"
  let originalPrice = null;
  let discountPct = null;
  const origPatterns = [
    /(?:ord(?:inarie|\.)?\s*pris|ordinarie|tidigare|rek(?:ommenderat|\.)?\s*pris|normalpris|listpris|förut|innan)\s*:?\s*(?:ca\.?\s*)?([\d][\d\s.]*)\s*(?:kr|:-|sek)/i,
    /\(\s*(?:ord\.?\s*|ordinarie\s*)?([\d][\d\s.]*)\s*(?:kr|:-)\s*\)/i,
  ];
  for (const pattern of origPatterns) {
    const m = textContent.match(pattern);
    if (m) {
      const parsed = parseFloat(m[1].replace(/\s/g, '').replace(/\./g, ''));
      if (!isNaN(parsed) && price && parsed > price && parsed < 10000000) {
        originalPrice = Math.round(parsed);
        break;
      }
    }
  }
  const pctMatch = textContent.match(/(?:nedsatt(?:\s+med)?|rabatt(?:erat)?(?:\s+med)?|spara|-)\s*(\d{1,2})\s*%/i) ||
                   textContent.match(/(\d{1,2})\s*%\s*(?:rabatt|billigare|nedsatt|off)/i);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct >= 5 && pct <= 95) discountPct = pct;
  }
  if (originalPrice && price) {
    discountPct = Math.round((1 - price / originalPrice) * 100);
  } else if (discountPct && price && !originalPrice) {
    originalPrice = Math.round(price / (1 - discountPct / 100));
  }
  if (discountPct !== null && discountPct < 5) {
    discountPct = null;
    originalPrice = null;
  }

  const soldOut = SOLD_OUT_RE.test(textContent);

  // Extract category
  let category = 'Övrigt';
  const catMatch = textContent.match(/Kategori:\s*(.+?)(?:\n|$)/i);
  if (catMatch) {
    category = catMatch[1].trim();
  }

  // Extract links
  const allLinks = Array.from(tempDiv.querySelectorAll('a'));
  const productLinks = [];
  const prisjaketLinks = [];

  /**
   * Direct image URLs embedded in the forum post (e.g. elkjop CDN, postimg).
   * These are used as an instant, zero-latency image source without scraping.
   */
  const imageLinks = [];

  allLinks.forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#')) return;

    // Detect anchors that point directly to a product image on trusted CDN hosts
    try {
      const u = new URL(href);
      const isTrustedImageHost = TRUSTED_IMAGE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
      const isImageExt = IMAGE_EXTS.test(u.pathname);
      if (isTrustedImageHost || isImageExt) {
        // Decode HTML entities in query strings that may have been escaped (e.g. &amp;)
        const decoded = href.replace(/&amp;/g, '&');
        imageLinks.push(decoded);
        return; // Don't add to productLinks - image links aren't buy-links
      }
    } catch {
      // href was not a valid URL - fall through
    }

    if (
      href.includes('prisjakt.') ||
      href.includes('pricerunner.') ||
      href.includes('prisbot.')
    ) {
      prisjaketLinks.push(href);
    } else if (
      href.includes('amazon.') ||
      href.includes('komplett.') ||
      href.includes('inet.') ||
      href.includes('webhallen.') ||
      href.includes('elgiganten.') ||
      href.includes('netonnet.') ||
      href.includes('dustin.') ||
      href.includes('sony.') ||
      href.includes('apple.') ||
      href.includes('samsung.') ||
      href.includes('scandinavianphoto.') ||
      href.includes('jula.') ||
      href.includes('bauhaus.') ||
      href.includes('granngarden.') ||
      href.includes('rusta.') ||
      href.includes('dollarstore.') ||
      href.includes('naturkompaniet.') ||
      href.includes('strauss.') ||
      href.includes('grillhouse.') ||
      href.includes('ica.') ||
      href.includes('booztlet.') ||
      href.includes('disneyplus.')
    ) {
      productLinks.push(href);
    } else if (!href.includes('sweclockers.') && !href.includes('postimg.') && !href.includes('docs.google.')) {
      productLinks.push(href);
    }
  });

  // Also collect any <img src="..."> tags that point to images (e.g. forum-embedded screenshots)
  const allImgs = Array.from(tempDiv.querySelectorAll('img'));
  allImgs.forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (!src || !src.startsWith('http')) return;
    const decoded = src.replace(/&amp;/g, '&');
    if (!imageLinks.includes(decoded)) {
      imageLinks.push(decoded);
    }
  });

  // Clean up text for display (remove field labels)
  let cleanText = textContent
    .replace(/Produkt:.*?\n/g, '')
    .replace(/Länk:.*?\n/g, '')
    .replace(/Kategori:.*?\n/g, '')
    .replace(/Prisjakt:.*?\n/g, '')
    .replace(/Pris:.*?\n/g, '')
    .trim();

  // Upprepa inte rubriken i beskrivningen när den hämtats från första meningen.
  if (!produktMatch && productName) {
    const head = productName.replace(/…$/, '');
    if (cleanText.startsWith(head)) {
      cleanText = cleanText.slice(head.length).replace(/^[\s.!?:,-]+/, '');
    }
  }
  cleanText = cleanText.substring(0, 300);

  return { productName, price, originalPrice, discountPct, soldOut, category, cleanText, productLinks, prisjaketLinks, imageLinks };
}

// ============================================================
// Rendering
// ============================================================

/**
 * Renders skeleton loaders in the grid
 * @param {number} count 
 */
function renderSkeletons(count = 12) {
  dealsGrid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-card';
    skeleton.innerHTML = `
      <div class="skeleton-pulse skeleton-badge"></div>
      <div class="skeleton-pulse skeleton-title"></div>
      <div class="skeleton-pulse skeleton-desc"></div>
      <div class="skeleton-pulse skeleton-desc-2"></div>
      <div class="skeleton-pulse skeleton-desc-3"></div>
      <div class="skeleton-footer">
        <div class="skeleton-pulse skeleton-price"></div>
        <div class="skeleton-pulse skeleton-meta"></div>
      </div>
    `;
    dealsGrid.appendChild(skeleton);
  }
}

/**
 * Renders the deal cards into the grid.
 */
function renderDeals() {
  dealsGrid.innerHTML = '';

  if (displayDeals.length === 0) {
    dealsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
        </div>
        <p>Inga fynd matchar dina filter</p>
      </div>`;
    dealCount.textContent = '';
    return;
  }

  dealCount.textContent = `${displayDeals.length} fynd`;

  displayDeals.forEach((deal, index) => {
    const card = document.createElement('article');
    card.className = 'deal-card';
    card.id = `post-${deal.postId}`;
    card.dataset.id = deal.id;
    if (deal.soldOut || linkStatus[deal.id] === 'gone') card.classList.add('is-gone');
    if (hiddenDeals.has(deal.id)) card.classList.add('is-hidden');
    if (isNewSinceLastVisit(deal)) card.classList.add('is-new');
    card.style.animationDelay = `${Math.min(index * 40, 400)}ms`;

    const aiRanking = aiRankings.get(deal.id);

    // Build links HTML
    const linksHtml = buildLinksHtml(deal);

    // Build AI badge
    const aiBadgeHtml = aiRanking
      ? `<div class="ai-rank" title="AI Score: ${aiRanking.score}/100">#${aiRanking.rank}</div>`
      : '';

    // Build AI reason
    const aiReasonHtml = aiRanking?.reason
      ? `<div class="card-ai-reason">${escapeHtml(aiRanking.reason)}</div>`
      : '';

    // Price display
    const priceHtml = deal.price
      ? `<span class="card-price">${formatPrice(deal.price)}</span>${deal.originalPrice ? `<span class="card-price-original">${formatPrice(deal.originalPrice)}</span>` : ''}`
      : `<span class="card-price no-price">Pris ej angivet</span>`;

    const isGone = deal.soldOut || linkStatus[deal.id] === 'gone';
    const isNew = isNewSinceLastVisit(deal);
    const isFav = favorites.has(deal.id);
    const isHidden = hiddenDeals.has(deal.id);
    const history = getPriceHistorySummary(deal);

    const badges = [];
    if (deal.discountPct) badges.push(`<span class="badge badge-discount">-${deal.discountPct} %</span>`);
    if (history?.isLowest) badges.push(`<span class="badge badge-lowest" title="Lägsta pris som tipsats för produkten hittills">Lägsta hittills</span>`);
    if (isGone) badges.push(`<span class="badge badge-gone">${deal.soldOut ? 'Troligen slut' : 'Sidan borta'}</span>`);
    if (isNew) badges.push(`<span class="badge badge-new">Nytt</span>`);
    const badgesHtml = badges.length ? `<div class="card-badges">${badges.join('')}</div>` : '';

    const historyHtml = history && !history.isLowest && history.previous
      ? `<div class="card-history" title="Baserat på tidigare tips i trådarna">Tidigare tipsat för ${formatPrice(history.previous.p)} (${getRelativeTime(history.previous.d)})${history.lowest < history.previous.p ? `, lägst ${formatPrice(history.lowest)}` : ''}</div>`
      : history?.isLowest && history.count > 0
        ? `<div class="card-history">Lägre än ${history.count} tidigare ${history.count === 1 ? 'tips' : 'tips'} (lägst innan: ${formatPrice(history.lowest)})</div>`
        : '';

    const actionsHtml = `
      <div class="card-actions">
        <button type="button" class="card-action${isFav ? ' active' : ''}" data-action="favorite" data-id="${escapeHtml(deal.id)}" title="${isFav ? 'Ta bort från sparade' : 'Spara fynd'}" aria-label="${isFav ? 'Ta bort från sparade' : 'Spara fynd'}" aria-pressed="${isFav}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        </button>
        <button type="button" class="card-action" data-action="share" data-id="${escapeHtml(deal.id)}" title="Dela fynd" aria-label="Dela fynd">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
        </button>
        <button type="button" class="card-action" data-action="hide" data-id="${escapeHtml(deal.id)}" title="${isHidden ? 'Visa igen' : 'Dölj fynd'}" aria-label="${isHidden ? 'Visa igen' : 'Dölj fynd'}">
          ${isHidden
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'}
        </button>
      </div>`;

    // Relative time
    const timeAgo = deal.pubDate ? getRelativeTime(deal.pubDate) : '';

    // Determine SVG Icon based on category
    let catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>`; // default shopping bag

    const catLower = deal.category.toLowerCase();
    if (deal.source === 'tech') {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`; // Monitor
    } else if (catLower.includes('hem')) {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`; // Home
    } else if (catLower.includes('ljud') || catLower.includes('hörl')) {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>`; // Headphones
    } else if (catLower.includes('mobil') || catLower.includes('tele')) {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`; // Smartphone
    } else if (catLower.includes('spel') || catLower.includes('konsol')) {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="3"></rect></svg>`; // Gamepad
    } else if (catLower.includes('kläder') || catLower.includes('mode') || catLower.includes('skor')) {
      catIconSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`; // Tag
    }

    // Set imageUrl if cached
    if (productImageCache[deal.id]) {
      deal.imageUrl = productImageCache[deal.id];
    }

    // Determine visual HTML (cached image or SVG icon) and adaptive container background class
    const hasImage = deal.imageUrl && deal.imageUrl !== 'FAILED';
    const containerClass = `card-visual-placeholder${hasImage ? ' has-image' : ''}`;

    let visualHtml = `<span class="card-visual-icon">${catIconSvg}</span>`;
    if (hasImage) {
      visualHtml = `
        <img class="card-visual-image" src="${escapeHtml(deal.imageUrl)}" alt="${escapeHtml(deal.title)}" loading="lazy" referrerpolicy="no-referrer"
          onload="if(this.naturalWidth===1 && this.naturalHeight===1){ this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}'); }"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}');" />
        <span class="card-visual-icon" style="display:none">${catIconSvg}</span>
      `;
    }

    card.innerHTML = `
      ${aiBadgeHtml}
      <div class="${containerClass}">
        ${visualHtml}
        ${badgesHtml}
        ${actionsHtml}
      </div>
      <div class="card-content-inner">
        <div class="card-header">
          <span class="card-source-badge ${deal.source}">${deal.sourceLabel}</span>
          ${deal.category !== 'Övrigt' ? `<span class="card-category">${escapeHtml(deal.category)}</span>` : ''}
        </div>
        <h3 class="card-title">${escapeHtml(deal.title)}</h3>
        ${deal.description ? `<p class="card-description">${escapeHtml(deal.description)}</p>` : ''}
        ${aiReasonHtml}
        ${historyHtml}

        <div class="card-footer">
          <div class="price-wrapper">
            <span class="price-label">${isGone ? 'Pris vid tipset' : 'Nuvarande pris'}</span>
            ${priceHtml}
          </div>
          <div class="card-meta">
            <span class="card-author">${escapeHtml(deal.author)}</span>
            <span class="card-date">${timeAgo}</span>
          </div>
        </div>
        
        <div class="card-links-wrapper">${linksHtml}</div>
      </div>`;

    dealsGrid.appendChild(card);
  });
  queueImageLoading();
}

/**
 * Builds HTML for product and prisjakt links.
 * @param {Deal} deal
 * @returns {string}
 */
function buildLinksHtml(deal) {
  const parts = [];

  // Main CTA
  let mainUrl = deal.link;
  let mainLabel = 'Gå till fynd';
  let isStoreLink = false;

  if (deal.productLinks.length > 0) {
    mainUrl = deal.productLinks[0];
    const store = extractStoreName(mainUrl);
    const domain = safeHostname(mainUrl);
    const favicon = domain
      ? `<img class="store-favicon" src="https://icons.duckduckgo.com/ip3/${escapeHtml(domain)}.ico" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : '';
    mainLabel = `${favicon}Till ${escapeHtml(store)}`;
    isStoreLink = true;
  }

  parts.push(`<a href="${escapeHtml(mainUrl)}" target="_blank" rel="noopener" class="card-link primary-cta">${mainLabel}</a>`);

  // Secondary Links Container
  parts.push('<div class="secondary-links">');
  
  // Deduplicate prisjakt links
  const uniquePrisjaket = [...new Set(deal.prisjaketLinks)];
  if (uniquePrisjaket.length > 0) {
    const url = uniquePrisjaket[0];
    const name = url.includes('pricerunner') ? 'PriceRunner' : url.includes('prisbot') ? 'Prisbot' : 'Prisjakt';
    parts.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="card-link prisjakt secondary-cta" title="${name}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></a>`);
  }

  // Forum post link
  if (isStoreLink && deal.link) {
    parts.push(`<a href="${escapeHtml(deal.link)}" target="_blank" rel="noopener" class="card-link secondary-cta" title="Gå till forumtråd"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></a>`);
  }
  parts.push('</div>');

  return parts.join('');
}

/**
 * Extracts a human-readable store name from a product URL.
 * @param {string} url
 * @returns {string}
 */
function extractStoreName(url) {
  const storeMap = {
    'amazon.se': 'Amazon',
    'komplett.se': 'Komplett',
    'inet.se': 'Inet',
    'webhallen.com': 'Webhallen',
    'elgiganten.se': 'Elgiganten',
    'netonnet.se': 'NetOnNet',
    'dustin.se': 'Dustin',
    'sony.se': 'Sony',
    'apple.com': 'Apple',
    'samsung.se': 'Samsung',
    'scandinavianphoto.se': 'ScanPhoto',
    'jula.se': 'Jula',
    'bauhaus.se': 'Bauhaus',
    'granngarden.se': 'Granngården',
    'rusta.com': 'Rusta',
    'dollarstore.se': 'Dollarstore',
    'naturkompaniet.se': 'Naturkompaniet',
    'ica.se': 'ICA',
    'disneyplus.com': 'Disney+',
    'booztlet.com': 'Booztlet',
    'grillhouse.se': 'Grillhouse',
    'strauss.com': 'Strauss',
  };

  for (const [domain, name] of Object.entries(storeMap)) {
    if (url.includes(domain)) return name;
  }

  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return hostname.split('.')[0] ?? 'Köp';
  } catch {
    return 'Köp';
  }
}

// ============================================================
// Filtering & Sorting
// ============================================================

/**
 * Applies current filter/sort state and re-renders.
 */
function applyFiltersAndSort() {
  const sourceVal = currentSourceFilter;
  const catVal = categoryFilter.value;
  const sortVal = sortSelect.value;
  const searchVal = searchInput.value.toLowerCase().trim();

  let filtered = [...allDeals];

  // Source filter
  if (sourceVal !== 'all') {
    filtered = filtered.filter((d) => d.source === sourceVal);
  }

  // Search filter
  if (searchVal) {
    filtered = filtered.filter((d) => 
      d.title.toLowerCase().includes(searchVal) || 
      (d.description && d.description.toLowerCase().includes(searchVal)) ||
      (d.author && d.author.toLowerCase().includes(searchVal))
    );
  }

  // Category filter
  if (catVal !== 'all') {
    filtered = filtered.filter((d) => d.category.toLowerCase() === catVal.toLowerCase());
  }

  // Store filter
  const storeVal = storeFilter?.value ?? 'all';
  if (storeVal !== 'all') {
    filtered = filtered.filter((d) => d.storeDomain === storeVal);
  }

  // Favorites / hidden
  if (showFavoritesOnly) {
    filtered = filtered.filter((d) => favorites.has(d.id));
  }
  if (!showHidden) {
    filtered = filtered.filter((d) => !hiddenDeals.has(d.id));
  }

  // Sort
  if (isAiRanked) {
    // Sort by AI rank when AI ranking is active
    filtered.sort((a, b) => {
      const rankA = aiRankings.get(a.id)?.rank ?? 999;
      const rankB = aiRankings.get(b.id)?.rank ?? 999;
      return rankA - rankB;
    });
  } else {
    switch (sortVal) {
      case 'date':
        filtered.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
        break;
      case 'price-asc':
        filtered.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        break;
      case 'price-desc':
        filtered.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
        break;
      case 'discount':
        filtered.sort((a, b) => (b.discountPct ?? -1) - (a.discountPct ?? -1));
        break;
    }
  }

  displayDeals = filtered;
  renderDeals();
  renderStats();
}

/**
 * Fyller butiksfiltret med de butiker som förekommer i listan.
 */
function populateStoreFilter() {
  if (!storeFilter) return;
  const counts = new Map();
  allDeals.forEach((d) => {
    if (!d.storeDomain) return;
    counts.set(d.storeDomain, (counts.get(d.storeDomain) ?? 0) + 1);
  });
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const currentVal = storeFilter.value;
  storeFilter.innerHTML = '<option value="all">Alla butiker</option>';
  sorted.forEach(([domain, count]) => {
    const opt = document.createElement('option');
    opt.value = domain;
    const deal = allDeals.find((d) => d.storeDomain === domain);
    opt.textContent = `${deal?.store || domain} (${count})`;
    storeFilter.appendChild(opt);
  });
  if (currentVal && counts.has(currentVal)) storeFilter.value = currentVal;
}

/**
 * Liten statistikrad ovanför rutnätet: nya idag, billigaste, populäraste kategori.
 */
function renderStats() {
  if (!statsStrip) return;
  const visible = allDeals.filter((d) => !hiddenDeals.has(d.id));
  if (visible.length === 0) {
    statsStrip.classList.add('hidden');
    return;
  }
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const today = visible.filter((d) => d.pubDate && new Date(d.pubDate).getTime() > dayAgo).length;
  const newSince = previousVisitAt ? visible.filter(isNewSinceLastVisit).length : 0;
  const priced = visible.filter((d) => d.price && !d.soldOut);
  const cheapest = priced.length ? priced.reduce((a, b) => (a.price < b.price ? a : b)) : null;
  const bestDiscount = priced.filter((d) => d.discountPct).sort((a, b) => b.discountPct - a.discountPct)[0] ?? null;
  const catCounts = new Map();
  visible.forEach((d) => {
    if (d.category !== 'Övrigt') catCounts.set(d.category, (catCounts.get(d.category) ?? 0) + 1);
  });
  const topCat = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const items = [];
  items.push(`<span class="stat"><strong>${today}</strong> nya senaste dygnet</span>`);
  if (newSince > 0) items.push(`<span class="stat stat-new"><strong>${newSince}</strong> sedan ditt förra besök</span>`);
  if (cheapest) items.push(`<span class="stat">Billigast <a href="#post-${escapeHtml(cheapest.postId)}"><strong>${formatPrice(cheapest.price)}</strong></a></span>`);
  if (bestDiscount) items.push(`<span class="stat">Störst rabatt <a href="#post-${escapeHtml(bestDiscount.postId)}"><strong>-${bestDiscount.discountPct} %</strong></a></span>`);
  if (topCat) items.push(`<span class="stat">Hetast: <strong>${escapeHtml(topCat[0])}</strong> (${topCat[1]})</span>`);
  if (favorites.size > 0) items.push(`<span class="stat"><strong>${favorites.size}</strong> sparade</span>`);

  statsStrip.innerHTML = items.join('<span class="stat-sep">·</span>');
  statsStrip.classList.remove('hidden');
}

/**
 * Populates the category filter dropdown based on current deals.
 */
function populateCategoryFilter() {
  const categories = new Set(allDeals.map((d) => d.category));
  const sorted = [...categories].sort((a, b) => a.localeCompare(b, 'sv'));

  // Preserve current selection
  const currentVal = categoryFilter.value;

  categoryFilter.innerHTML = '<option value="all">Alla kategorier</option>';
  sorted.forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    categoryFilter.appendChild(opt);
  });

  if (currentVal && sorted.includes(currentVal)) {
    categoryFilter.value = currentVal;
  }
}

// ============================================================
// OpenAI Integration
// ============================================================

// ============================================================
// Ranking Cache (localStorage)
// ============================================================

/**
 * Generates a stable cache key from the current set of deal IDs.
 * Different feeds/posts = different key = new API call needed.
 * @returns {string}
 */
function buildCacheKey() {
  const ids = displayDeals
    .slice(0, 30)
    .map((d) => d.id)
    .join('|');
  // Simple djb2 hash - no crypto needed, just needs to be stable
  let hash = 5381;
  for (let i = 0; i < ids.length; i++) {
    hash = ((hash << 5) + hash) ^ ids.charCodeAt(i);
    hash = hash >>> 0; // Keep as unsigned 32-bit int
  }
  return `${CACHE_KEY_PREFIX}${hash.toString(36)}`;
}

/**
 * Saves ranking results to localStorage.
 * @param {string} cacheKey
 * @param {Array<{id: string, rank: number, score: number, reason: string}>} rankings
 */
function saveRankingToCache(cacheKey, rankings) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      rankings,
      cachedAt: new Date().toISOString(),
      model: OPENAI_MODEL,
    }));
  } catch (err) {
    // localStorage kan vara full - ignorera tyst
    console.warn('Kunde inte spara ranking till cache:', err);
  }
}

/**
 * Loads a cached ranking from localStorage if it exists.
 * @param {string} cacheKey
 * @returns {{ rankings: Array<{id: string, rank: number, score: number, reason: string}>, cachedAt: string, model: string } | null}
 */
function loadRankingFromCache(cacheKey) {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Applies a set of rankings to the aiRankings map and updates UI.
 * @param {Array<{id: string, rank: number, score: number, reason: string}>} rankings
 * @param {string} cachedAt - ISO date string, empty string if fresh from API
 * @returns {void}
 */
function applyRankings(rankings, cachedAt = '') {
  aiRankings.clear();
  rankings.forEach((r) => {
    aiRankings.set(r.id, { rank: r.rank, score: r.score, reason: r.reason });
  });

  isAiRanked = true;
  aiBanner.classList.remove('hidden');

  if (cachedAt) {
    const when = getRelativeTime(cachedAt);
    aiBannerText.innerHTML = `AI-ranking återställd från cache (${when}) &mdash; <button id="ai-force-refresh" class="btn-clear" style="margin-left:0.25rem; display: inline-flex; align-items: center; gap: 0.25rem;">Uppdatera <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg></button>`;
    document.getElementById('ai-force-refresh')?.addEventListener('click', () => {
      const key = openaiKeyInput.value.trim();
      if (key.length < 10) {
        statusText.textContent = 'Klistra in din OpenAI-nyckel för att uppdatera rankningen.';
        return;
      }
      rankWithAi(key, true);
    });
  } else {
    aiBannerText.textContent = `AI-rankad lista - ${rankings.length} fynd analyserade med ${OPENAI_MODEL}`;
  }

  applyFiltersAndSort();
}

/**
 * Sends deals to OpenAI for ranking/scoring.
 * Checks localStorage cache first - only calls the API if no valid cache exists.
 * The API key is NEVER stored.
 * @param {string} apiKey
 * @param {boolean} [forceRefresh=false] - Skip cache and always call API
 */
async function rankWithAi(apiKey, forceRefresh = false) {
  const cacheKey = buildCacheKey();

  // Check cache first (unless force-refreshing)
  if (!forceRefresh) {
    const cached = loadRankingFromCache(cacheKey);
    if (cached?.rankings?.length > 0) {
      statusText.textContent = 'Ranking laddad från cache - inga API-anrop gjordes.';
      applyRankings(cached.rankings, cached.cachedAt);
      return;
    }
  }

  renderSkeletons(Math.min(30, displayDeals.length));
  statusText.textContent = 'AI analyserar...';

  // Build a compact representation of deals for the prompt
  const dealsForPrompt = displayDeals.slice(0, 30).map((d) => ({
    id: d.id,
    title: d.title.substring(0, 100),
    price: d.price,
    category: d.category,
    source: d.sourceLabel,
    description: d.description.substring(0, 150),
  }));

  const systemPrompt = `Du är en expert på att hitta de bästa fynden/erbjudandena. 
Användaren skickar en lista med deals/fynd från SweClockers forum.
Ranka dem från bäst till sämst baserat på:
- Prisvärdhet (hur bra pris jämfört med vad produkten normalt kostar)
- Användbarhet (hur bred målgrupp som har nytta av produkten)
- Aktualitet (är det fortfarande aktuellt/tillgängligt)
- Kvalitet (kända bra varumärken/produkter)

Svara med ett JSON-objekt med nyckeln "rankings" som innehåller en array med fynden.
I 'reason', skriv max 30 ord om vad du tror produkten normalt kostar och varför detta är ett bra köp.

Formatet måste vara exakt:
{
  "rankings": [
    {
      "id": "<deal id>",
      "rank": 1,
      "score": 95,
      "reason": "<resonemang>"
    }
  ]
}

Ranka ALLA deals i listan. rank ska vara 1 för bäst, 2 för näst bäst, osv. score ska vara 0-100.`;

  const userPrompt = JSON.stringify(dealsForPrompt, null, 0);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error('Kunde inte tolka AI-svaret som JSON');
    }

    if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
      throw new Error('AI-svaret saknade den förväntade "rankings"-arrayen');
    }

    /** @type {Array<{id: string, rank: number, score: number, reason: string}>} */
    const rankings = parsed.rankings;

    // Save to cache - API key is NOT saved
    saveRankingToCache(cacheKey, rankings);

    statusText.textContent = 'AI-ranking klar! Sparad i cache - inga fler API-anrop behövs.';
    applyRankings(rankings);
  } catch (error) {
    console.error('AI ranking failed:', error);
    statusText.textContent = `AI-fel: ${error instanceof Error ? error.message : 'Okänt fel'}`;
    renderDeals(); // fallback to normal
  }
}

// ============================================================
// Event Listeners
// ============================================================

// Segmented control handling
sourceFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('button.segment');
  if (btn) {
    sourceFilter.querySelectorAll('.segment').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentSourceFilter = btn.dataset.value;
    applyFiltersAndSort();
  }
});

categoryFilter.addEventListener('change', applyFiltersAndSort);
storeFilter?.addEventListener('change', applyFiltersAndSort);
searchInput.addEventListener('input', applyFiltersAndSort);

favoritesToggle?.addEventListener('click', () => {
  showFavoritesOnly = !showFavoritesOnly;
  favoritesToggle.classList.toggle('active', showFavoritesOnly);
  favoritesToggle.setAttribute('aria-pressed', String(showFavoritesOnly));
  applyFiltersAndSort();
});

// Kortåtgärder (spara / dela / dölj) via delegering så att omrendering inte tappar lyssnare.
dealsGrid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.card-action');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.id;
  const deal = allDeals.find((d) => d.id === id);
  if (!deal) return;

  switch (btn.dataset.action) {
    case 'favorite':
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      saveJsonToStorage(LS_FAVORITES, [...favorites]);
      applyFiltersAndSort();
      break;
    case 'hide':
      if (hiddenDeals.has(id)) hiddenDeals.delete(id);
      else hiddenDeals.add(id);
      saveJsonToStorage(LS_HIDDEN, [...hiddenDeals]);
      applyFiltersAndSort();
      break;
    case 'share':
      await shareDeal(deal, btn);
      break;
  }
});

/**
 * Delar ett fynd via Web Share API, annars kopieras länken till urklipp.
 * @param {Deal} deal
 * @param {HTMLElement} btn
 */
async function shareDeal(deal, btn) {
  const url = `${location.origin}${location.pathname}#post-${deal.postId}`;
  const text = deal.price ? `${deal.title} - ${formatPrice(deal.price)}` : deal.title;
  try {
    if (navigator.share) {
      await navigator.share({ title: `FyndRadar: ${deal.title}`, text, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    flashButton(btn, 'Länk kopierad');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.warn('Delning misslyckades:', err);
      flashButton(btn, 'Kunde inte dela');
    }
  }
}

/** Visar en kort bekräftelse bredvid en knapp. */
function flashButton(btn, message) {
  const tip = document.createElement('span');
  tip.className = 'action-toast';
  tip.textContent = message;
  btn.parentElement?.appendChild(tip);
  setTimeout(() => tip.remove(), 1800);
}

// Tema
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle?.setAttribute('aria-label', theme === 'light' ? 'Byt till mörkt tema' : 'Byt till ljust tema');
  themeToggle?.setAttribute('title', theme === 'light' ? 'Byt till mörkt tema' : 'Byt till ljust tema');
}

themeToggle?.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(LS_THEME, next);
  applyTheme(next);
});

// Bevakningar & notiser
function updateNotifyStatus() {
  if (!notifyStatus) return;
  if (!('Notification' in window)) {
    notifyStatus.textContent = 'Din webbläsare stödjer inte notiser.';
    notifyBtn?.setAttribute('disabled', '');
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    notifyStatus.textContent = watchWords.length
      ? `Notiser på. Bevakar: ${watchWords.join(', ')}`
      : 'Notiser på. Lägg till bevakningsord ovan.';
    if (notifyBtn) notifyBtn.textContent = 'Notiser aktiva';
    notifyBtn?.setAttribute('disabled', '');
  } else if (perm === 'denied') {
    notifyStatus.textContent = 'Notiser är blockerade i webbläsarens inställningar.';
    notifyBtn?.setAttribute('disabled', '');
  } else {
    notifyStatus.textContent = 'Notiser skickas när ett nytt fynd matchar dina ord, så länge fliken är öppen.';
    notifyBtn?.removeAttribute('disabled');
  }
}

watchWordsInput?.addEventListener('change', () => {
  watchWords = watchWordsInput.value
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2);
  saveJsonToStorage(LS_WATCH_WORDS, watchWords);
  updateNotifyStatus();
});

notifyBtn?.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  updateNotifyStatus();
  if (perm === 'granted') {
    new Notification('FyndRadar', { body: 'Notiser är på. Du får ett meddelande när ett bevakat fynd dyker upp.', icon: 'icons/icon-192.png' });
  }
});

showHiddenBtn?.addEventListener('click', () => {
  showHidden = !showHidden;
  showHiddenBtn.textContent = showHidden ? 'Göm dolda fynd igen' : `Visa dolda fynd (${hiddenDeals.size})`;
  settingsModal.classList.add('hidden');
  applyFiltersAndSort();
});

/**
 * Skickar webbnotis för nya fynd som matchar bevakningsorden.
 * @param {Deal[]} newDeals
 */
function notifyWatchedDeals(newDeals) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (watchWords.length === 0 || newDeals.length === 0) return;
  const notified = new Set(loadJsonFromStorage(LS_NOTIFIED, []));
  const matches = newDeals.filter((d) => {
    if (notified.has(d.id)) return false;
    const hay = `${d.title} ${d.description} ${d.category} ${d.store}`.toLowerCase();
    return watchWords.some((w) => hay.includes(w));
  });
  matches.slice(0, 3).forEach((d) => {
    const n = new Notification(d.title, {
      body: `${d.price ? formatPrice(d.price) + ' · ' : ''}${d.store || d.sourceLabel}`,
      icon: 'icons/icon-192.png',
      tag: d.id,
    });
    n.onclick = () => {
      window.focus();
      location.hash = `#post-${d.postId}`;
      n.close();
    };
    notified.add(d.id);
  });
  saveJsonToStorage(LS_NOTIFIED, [...notified].slice(-200));
}

/**
 * Scrollar till och markerar kortet som URL-hashen pekar på (#post-123).
 */
function focusHashedCard() {
  const hash = location.hash;
  if (!hash.startsWith('#post-')) return;
  const card = document.getElementById(hash.slice(1));
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('is-highlighted');
  setTimeout(() => card.classList.remove('is-highlighted'), 3000);
}
window.addEventListener('hashchange', focusHashedCard);

// Modal handling
settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
});

closeModalBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hidden');
  }
});
sortSelect.addEventListener('change', () => {
  if (isAiRanked) {
    // If user manually changes sort, exit AI rank mode
    clearAiRanking();
  }
  applyFiltersAndSort();
});

openaiKeyInput.addEventListener('input', () => {
  aiRankBtn.disabled = openaiKeyInput.value.trim().length < 10;
});

aiRankBtn.addEventListener('click', () => {
  const key = openaiKeyInput.value.trim();
  if (key.length < 10) return;
  rankWithAi(key);
});

aiClearBtn.addEventListener('click', clearAiRanking);

const clearImageCacheBtn = document.getElementById('clear-image-cache-btn');
if (clearImageCacheBtn) {
  clearImageCacheBtn.addEventListener('click', () => {
    localStorage.removeItem('fyndradar_image_cache_v2');
    productImageCache = {};
    
    // Clear imageUrl property on all loaded deals
    allDeals.forEach(d => {
      delete d.imageUrl;
    });
    
    // Reset the display list too
    displayDeals.forEach(d => {
      delete d.imageUrl;
    });

    statusText.textContent = 'Bildcache rensad. Hämtar nya bilder...';
    settingsModal.classList.add('hidden');
    
    // Re-render deals to trigger image queue loading
    renderDeals();
  });
}

/**
 * Clears AI ranking state, removes localStorage cache, and re-renders.
 */
function clearAiRanking() {
  // Remove all ranking caches for this app
  Object.keys(localStorage)
    .filter((k) => k.startsWith(CACHE_KEY_PREFIX))
    .forEach((k) => localStorage.removeItem(k));

  isAiRanked = false;
  aiRankings.clear();
  aiBanner.classList.add('hidden');
  statusText.textContent = 'Ranking rensad.';
  applyFiltersAndSort();
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Escapes HTML entities to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(str ?? '').replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/**
 * Hostname utan www., eller tom sträng vid ogiltig URL.
 * @param {string} url
 * @returns {string}
 */
function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Är fyndet publicerat efter användarens förra besök?
 * @param {Deal} deal
 */
function isNewSinceLastVisit(deal) {
  if (!previousVisitAt || !deal.pubDate) return false;
  return new Date(deal.pubDate).getTime() > previousVisitAt;
}

/**
 * Sammanfattar prishistoriken för ett fynd från data/history.json.
 * @param {Deal} deal
 * @returns {{ lowest: number, count: number, isLowest: boolean, previous: {p:number,d:string}|null }|null}
 */
function getPriceHistorySummary(deal) {
  if (!deal.prisjaktId || !deal.price) return null;
  const entries = (priceHistory[deal.prisjaktId] ?? []).filter((e) => e.p && e.post !== deal.id);
  if (entries.length === 0) return null;
  const lowest = Math.min(...entries.map((e) => e.p));
  const previous = [...entries].sort((a, b) => new Date(b.d) - new Date(a.d))[0];
  return { lowest, count: entries.length, isLowest: deal.price <= lowest, previous };
}

/**
 * Formats a price number to Swedish locale.
 * @param {number} price
 * @returns {string}
 */
function formatPrice(price) {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
}

/**
 * Converts an ISO date string to a relative "time ago" string in Swedish.
 * @param {string} isoDate
 * @returns {string}
 */
function getRelativeTime(isoDate) {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just nu';
  if (diffMin < 60) return `${diffMin} min sedan`;
  if (diffHours < 24) return `${diffHours} tim sedan`;
  if (diffDays < 7) return diffDays === 1 ? '1 dag sedan' : `${diffDays} dagar sedan`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? '1 vecka sedan' : `${weeks} veckor sedan`;
  }
  return new Date(isoDate).toLocaleDateString('sv-SE');
}

// ============================================================
// Product Image Scraping & Caching
// ============================================================

/** Cache map for product image URLs: dealId -> imageUrl */
let productImageCache = {};

/** Queue of deal IDs to fetch images for */
let imageFetchQueue = [];
const CONCURRENT_FETCH_LIMIT = 4;
let activeFetchCount = 0;

/**
 * Loads the image cache from localStorage.
 * Filters out previous 'FAILED' values to ensure we automatically retry
 * fetching images on subsequent sessions if a previous load failed due to
 * temporary network or parsing issues. Also forces a reload of any Komplett
 * images incorrectly cached with the 'en-us' locale.
 */
function loadImageCache() {
  try {
    const raw = localStorage.getItem('fyndradar_image_cache_v2');
    const parsed = raw ? JSON.parse(raw) : {};
    productImageCache = {};
    let cachePruned = false;
    for (const key in parsed) {
      const url = parsed[key];
      if (url && url !== 'FAILED') {
        // Evict generic brand logo icons and incorrect store-specific image URLs.
        // This forces clean, deterministic re-resolution for affected deals.
        const isLogo = url.includes('apple-touch-icon') || url.includes('favicon') || url.includes('/logo/');
        const isBadKomplett = url.includes('komplett.') && (!url.includes('/product-media/b2c/') || !url.includes('/b2c/en-us/'));
        const isBadWebhallen = url.includes('webhallen.com') && !url.includes('/images/product/');

        if (isLogo || isBadKomplett || isBadWebhallen) {
          cachePruned = true;
          continue;
        }
        productImageCache[key] = url;
      }
    }
    if (cachePruned) {
      saveImageCache();
    }
  } catch (e) {
    productImageCache = {};
  }
}

/**
 * Saves the image cache to localStorage.
 * Only persists successful image URLs. Keeps 'FAILED' flags in-memory during the
 * current page session to prevent infinite fetch loop retries, but avoids writing
 * them to disk to keep the cache clean and self-healing.
 */
function saveImageCache() {
  try {
    const cleanCache = {};
    for (const [key, value] of Object.entries(productImageCache)) {
      if (value && value !== 'FAILED') {
        cleanCache[key] = value;
      }
    }
    localStorage.setItem('fyndradar_image_cache_v2', JSON.stringify(cleanCache));
  } catch (e) {
    // Ignore localStorage quota limits
  }
}

/**
 * Decodes HTML entities in a string.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  const temp = document.createElement('textarea');
  temp.innerHTML = str;
  return temp.value;
}

/**
 * Extract og:image or twitter:image URL from HTML using regex.
 * @param {string} html
 * @returns {string|null}
 */
function extractOgImage(html) {
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
                  html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  return ogMatch ? decodeHtmlEntities(ogMatch[1]) : null;
}

/**
 * Resolves product image directly using store-specific URL patterns.
 * Bypasses proxies and scrapes to avoid anti-bot bottlenecks.
 * @param {string} productUrl - The product landing page URL
 * @returns {string|null} Direct image URL, or null if not supported
 */
function resolveDeterministicImage(productUrl) {
  try {
    const url = new URL(productUrl);
    const hostname = url.hostname.toLowerCase();

    // If it's already a direct image URL (e.g. from forum post <img>)
    if (productUrl.match(/\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i) && !hostname.includes('amazon.')) {
      return productUrl;
    }

    // Webhallen
    if (hostname.includes('webhallen.com')) {
      const idMatch = productUrl.match(/\/product\/([0-9]+)/);
      if (idMatch) {
        const id = idMatch[1];
        return `https://www.webhallen.com/images/product/${id}?trim`;
      }
    }

    // Komplett
    if (hostname.includes('komplett.')) {
      const idMatch = productUrl.match(/\/product\/([0-9]+)/);
      if (idMatch) {
        const id = idMatch[1];
        // Use the global 'en-us' CDN locale for Komplett product images.
        // Localized folders (e.g. sv-se, no-no) often lack actual product images and fall back to placeholders,
        // while the 'en-us' folder consistently hosts the correct product photography.
        const host = hostname.includes('komplett.no') ? 'www.komplett.no' : hostname.includes('komplett.dk') ? 'www.komplett.dk' : 'www.komplett.se';
        return `https://${host}/product-media/b2c/en-us/1200/${id}.jpg`;
      }
    }

    // Prisjakt / Prisbot - maps product comparison page to Pricespy's public CDN image.
    // The Pricespy CDN (pricespy-75b8.kxcdn.com) uses the same numeric product ID as Prisjakt
    // and serves clean, royalty-free product photography that is publicly accessible without auth.
    if (hostname.includes('prisjakt.nu') || hostname.includes('pricespy.co.uk')) {
      // Prisjakt product pages: /produkt.php?p=12345678 or /en/product/12345678
      const idMatch = productUrl.match(/[?&]p=([0-9]+)/) || productUrl.match(/\/product\/([0-9]+)/);
      if (idMatch) {
        const id = idMatch[1];
        return `https://pricespy-75b8.kxcdn.com/product/standard/800/${id}.jpg`;
      }
    }

    // Pricerunner - maps product comparison page to their public CDN image.
    // PriceRunner product pages: /product/{id}/{slug}
    if (hostname.includes('pricerunner.')) {
      const idMatch = productUrl.match(/\/product\/([A-Z0-9-]+?)(?:\/|$)/);
      if (idMatch) {
        const id = idMatch[1];
        return `https://static.pricerunner.com/product/200/${id}.jpg`;
      }
    }
  } catch (e) {
    console.warn('Error resolving deterministic image:', e);
  }
  return null;
}

/**
 * Fetches the product page and extracts the open graph image URL.
 * Falls back to scraper only if deterministic resolution is not available.
 * @param {string} productUrl
 * @returns {Promise<string|null>}
 */
async function fetchProductImage(productUrl) {
  // Try deterministic direct resolution first to avoid scraper latency/blocks
  const deterministicUrl = resolveDeterministicImage(productUrl);
  if (deterministicUrl) {
    return deterministicUrl;
  }

  // Fast-fail known anti-bot protected stores to prevent long load times
  try {
    const url = new URL(productUrl);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname.includes('elgiganten.se') ||
      hostname.includes('dustin.se')
    ) {
      return null;
    }

    // Use Microlink API specifically for sites known to block raw HTML proxies 
    // or return 1x1 pixels for deterministic images
    if (hostname.includes('amazon.') || hostname.includes('amzn.eu') || hostname.includes('lg.com') || hostname.includes('strauss.com') || hostname.includes('netonnet.se') || hostname.includes('ica.se')) {
      const mlRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(productUrl)}`);
      if (mlRes.ok) {
        const mlData = await mlRes.json();
        if (mlData?.data?.image?.url) {
          return mlData.data.image.url;
        }
      }
      return null; // Skip standard cors proxies for these as they will just fail/hang
    }
  } catch (e) {
    // Ignore URL parsing errors and try fallback
  }

  try {
    const htmlText = await fetchWithCorsProxy(productUrl);
    const ogImage = extractOgImage(htmlText);
    
    if (ogImage) {
      // Resolve relative URLs if necessary
      if (ogImage.startsWith('//')) {
        return 'https:' + ogImage;
      } else if (ogImage.startsWith('/')) {
        const urlObj = new URL(productUrl);
        return urlObj.origin + ogImage;
      }
      return ogImage;
    }
  } catch (err) {
    console.warn(`Misslyckades att hämta bild för ${productUrl}:`, err);
  }
  return null;
}

/**
 * Collects displayed deals lacking an image and schedules background loading.
 * Includes deals with only Prisjakt/PriceRunner comparison links, since those can
 * be resolved deterministically to product images via the Pricespy CDN.
 */
function queueImageLoading() {
  const dealsToFetch = displayDeals.filter(
    (d) =>
      (d.productLinks.length > 0 || d.prisjaketLinks.length > 0) &&
      !d.imageUrl &&
      !productImageCache[d.id]
  );
  
  dealsToFetch.forEach((d) => {
    if (!imageFetchQueue.includes(d.id)) {
      imageFetchQueue.push(d.id);
    }
  });

  if (activeFetchCount < CONCURRENT_FETCH_LIMIT && imageFetchQueue.length > 0) {
    processImageFetchQueue();
  }
}

/**
 * Processes the queue to fetch product images in parallel.
 */
async function processImageFetchQueue() {
  if (imageFetchQueue.length === 0) {
    return;
  }

  while (activeFetchCount < CONCURRENT_FETCH_LIMIT && imageFetchQueue.length > 0) {
    const dealId = imageFetchQueue.shift();
    activeFetchCount++;
    fetchImageForDeal(dealId).finally(() => {
      activeFetchCount--;
      // Schedule next processing step.
      setTimeout(processImageFetchQueue, 100);
    });
  }
}

/**
 * Updates a deal's image in both the in-memory cache and the live DOM card,
 * without requiring a full re-render of the grid.
 * @param {Deal} deal - The deal object to update
 * @param {string} imageUrl - The resolved image URL to display
 * @param {string} catIconSvg - Fallback SVG string used when the image fails to load
 */
function updateDealImage(deal, imageUrl, catIconSvg) {
  productImageCache[deal.id] = imageUrl;
  saveImageCache();
  deal.imageUrl = imageUrl;

  const card = document.querySelector(`.deal-card[data-id="${CSS.escape(deal.id)}"]`);
  if (card) {
    const placeholder = card.querySelector('.card-visual-placeholder');
    if (placeholder) {
      placeholder.classList.add('has-image');
      // Byt bara ut bild/ikon - märken och åtgärdsknappar i samma container ska vara kvar.
      placeholder.querySelectorAll('.card-visual-image, .card-visual-icon').forEach((el) => el.remove());
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
        <img class="card-visual-image img-fade-in" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(deal.title)}" loading="lazy" referrerpolicy="no-referrer"
          onload="if(this.naturalWidth===1 && this.naturalHeight===1){ this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}'); }"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}');" />
        <span class="card-visual-icon" style="display:none">${catIconSvg}</span>
      `;
      placeholder.prepend(...wrapper.childNodes);
    }
  }
}

/**
 * Builds the category SVG icon string for a deal, used as image fallback.
 * @param {Deal} deal
 * @returns {string} SVG markup string
 */
function buildCatIconSvg(deal) {
  const catLower = deal.category.toLowerCase();
  if (deal.source === 'tech') {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
  } else if (catLower.includes('hem')) {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;
  } else if (catLower.includes('ljud') || catLower.includes('hörl')) {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>`;
  } else if (catLower.includes('mobil') || catLower.includes('tele')) {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;
  } else if (catLower.includes('spel') || catLower.includes('konsol')) {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="3"></rect></svg>`;
  } else if (catLower.includes('kläder') || catLower.includes('mode') || catLower.includes('skor')) {
    return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`;
  }
  // Default: shopping bag
  return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>`;
}

/**
 * Helper to fetch a single product image, update the state, cache, and DOM.
 * Resolution order:
 * 1. Prisjakt links on the deal - maps comparison page ID to Pricespy CDN image.
 * 2. Primary product link - deterministic URL patterns (Amazon, Webhallen, Komplett).
 * 3. CORS scraper fallback for all other stores not blocked by anti-bot systems.
 * @param {string} dealId - The unique ID of the deal post
 */
async function fetchImageForDeal(dealId) {
  const deal = allDeals.find((d) => d.id === dealId);
  // Require at least one link source - either a store URL or a comparison link
  if (!deal || (deal.productLinks.length === 0 && deal.prisjaketLinks.length === 0)) return;

  const catIconSvg = buildCatIconSvg(deal);

  // Strategy 1: Resolve from Prisjakt/Pricerunner comparison links.
  // These are anti-bot-free and deterministically map to Pricespy CDN.
  for (const pjUrl of deal.prisjaketLinks) {
    const deterministicPjImage = resolveDeterministicImage(pjUrl);
    if (deterministicPjImage) {
      updateDealImage(deal, deterministicPjImage, catIconSvg);
      return;
    }
  }

  // Strategy 2 & 3: Deterministic or scraped image from the primary store link
  if (deal.productLinks.length === 0) {
    // Only had Prisjakt links, and none resolved deterministically above - nothing more we can do
    productImageCache[dealId] = 'FAILED';
    deal.imageUrl = 'FAILED';
    return;
  }

  const productUrl = deal.productLinks[0];
  try {
    const imageUrl = await fetchProductImage(productUrl);
    
    if (imageUrl) {
      updateDealImage(deal, imageUrl, catIconSvg);

    } else {
      productImageCache[dealId] = 'FAILED';
      saveImageCache();
      deal.imageUrl = 'FAILED';
    }
  } catch (err) {
    console.error(`Error processing image queue for deal ${dealId}:`, err);
    productImageCache[dealId] = 'FAILED';
    saveImageCache();
    deal.imageUrl = 'FAILED';
  }
}

/**
 * Marks an image URL as failed in the cache to prevent future load attempts.
 * @param {string} dealId
 */
function markImageAsFailed(dealId) {
  if (productImageCache[dealId] !== 'FAILED') {
    productImageCache[dealId] = 'FAILED';
    saveImageCache();
  }
}

// ============================================================
// Initialization
// ============================================================

/** SVG för fel-/tomtillstånd. */
const ERROR_ICON_SVG = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;

/**
 * Uppdaterar statusraden med antal fynd och när datan senast hämtades.
 * @param {string} [prefix] - Valfri text som visas före tidsstämpeln
 */
let statusPrefix = '';
function updateStatusText(prefix = statusPrefix) {
  statusPrefix = prefix;
  const parts = [];
  if (prefix) parts.push(escapeHtml(prefix));

  if (dataMeta?.updatedAt && lastDataSource === 'local') {
    const ageMs = Date.now() - new Date(dataMeta.updatedAt).getTime();
    const when = getRelativeTime(dataMeta.updatedAt);
    const stale = ageMs > 2 * 60 * 60 * 1000; // >2 h betyder att GitHub Actions troligen inte körts
    parts.push(
      `<span class="status-updated${stale ? ' stale' : ''}" title="${escapeHtml(new Date(dataMeta.updatedAt).toLocaleString('sv-SE'))}">Uppdaterat ${escapeHtml(when)}${stale ? ' (kan vara inaktuellt)' : ''}</span>`
    );
  } else if (lastDataSource === 'proxy') {
    parts.push('<span class="status-updated">Hämtat direkt via reservproxy</span>');
  }

  statusText.innerHTML = parts.join(' <span class="status-sep">·</span> ');
}

/**
 * Renderar ett felmeddelande med knapp för att försöka igen och direktlänkar
 * till forumtrådarna, så att sidan aldrig lämnar användaren i en återvändsgränd.
 * @param {string} message
 * @param {string} [detail]
 */
function renderErrorState(message, detail = '') {
  const threadLinks = FEEDS.map(
    (f) => `<a href="${escapeHtml(f.threadUrl)}" target="_blank" rel="noopener">${escapeHtml(f.label)}</a>`
  ).join(' · ');

  dealsGrid.innerHTML = `
    <div class="empty-state error-state">
      <div class="empty-icon">${ERROR_ICON_SVG}</div>
      <p>${escapeHtml(message)}</p>
      ${detail ? `<p class="error-detail">${escapeHtml(detail)}</p>` : ''}
      <div class="error-actions">
        <button type="button" id="retry-btn" class="btn-retry">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          Försök igen
        </button>
        <span class="error-links">Eller läs trådarna direkt: ${threadLinks}</span>
      </div>
    </div>`;

  document.getElementById('retry-btn')?.addEventListener('click', () => loadDeals({ silent: false }));
}

/**
 * Hämtar båda flödena och bygger om listan.
 * @param {{ silent?: boolean }} [opts] - silent = bakgrundsuppdatering utan skeletons
 * @returns {Promise<boolean>} true om fynd laddades
 */
async function loadDeals({ silent = false } = {}) {
  if (isLoading) return false;
  isLoading = true;
  refreshBtn?.classList.add('spinning');
  refreshBtn?.setAttribute('disabled', '');

  if (!silent) {
    statusText.textContent = 'Hämtar fynd från SweClockers...';
    renderSkeletons(12);
  }

  try {
    lastDataSource = null;
    const [results] = await Promise.all([
      Promise.allSettled(FEEDS.map(fetchFeed)),
      loadLocalMetadata(),
    ]);

    /** @type {Deal[]} */
    const fresh = [];
    let feedsLoaded = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        fresh.push(...result.value);
        feedsLoaded++;
      } else {
        const reason = result.status === 'rejected' ? result.reason : 'Inga deals hittades';
        console.error(`Feed "${FEEDS[i].label}" misslyckades:`, reason);
      }
    });

    // Deduplicate by post URL
    const seen = new Set();
    const deduped = fresh.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });

    if (deduped.length === 0) {
      if (silent && allDeals.length > 0) {
        // Behåll det vi redan visar; störa inte användaren.
        updateStatusText(`${allDeals.length} fynd`);
        return false;
      }
      statusText.textContent = 'Inga fynd kunde hämtas.';
      renderErrorState(
        'Kunde inte hämta data från SweClockers.',
        'Varken den förhämtade datan eller reservproxyn svarade. Kontrollera din anslutning och försök igen.'
      );
      return false;
    }

    // Vid tyst uppdatering: hoppa över omrendering om inget ändrats.
    const prevIds = allDeals.map((d) => d.id).join('|');
    const nextIds = deduped.map((d) => d.id).join('|');
    const changed = prevIds !== nextIds;
    const previousIds = new Set(allDeals.map((d) => d.id));
    const newDeals = previousIds.size > 0 ? deduped.filter((d) => !previousIds.has(d.id)) : [];
    const newCount = newDeals.length;

    if (changed || !silent) {
      allDeals = deduped;
      saveSnapshot();
      populateCategoryFilter();
      populateStoreFilter();
      applyFiltersAndSort(); // Render first so displayDeals is populated
      if (newDeals.length > 0) notifyWatchedDeals(newDeals);

      // Auto-restore cached ranking if one exists for this set of deals
      const cacheKey = buildCacheKey();
      const cached = loadRankingFromCache(cacheKey);
      if (cached?.rankings?.length > 0) {
        applyRankings(cached.rankings, cached.cachedAt);
        updateStatusText(`${allDeals.length} fynd · AI-ranking återställd från cache`);
      } else {
        if (isAiRanked && changed) {
          // Listan har ändrats sedan rankingen gjordes - visa det tydligt.
          aiBannerText.textContent = 'Nya fynd har tillkommit sedan AI-rankingen gjordes. Kör AI Ranka igen för att uppdatera.';
        }
        const prefix = newCount > 0
          ? `${allDeals.length} fynd · ${newCount} ${newCount === 1 ? 'nytt' : 'nya'}`
          : `${allDeals.length} fynd laddade från ${feedsLoaded}/${FEEDS.length} trådar`;
        updateStatusText(prefix);
      }
    } else {
      updateStatusText(`${allDeals.length} fynd`);
    }
    return true;
  } catch (error) {
    console.error('Load error:', error);
    if (!silent || allDeals.length === 0) {
      statusText.textContent = 'Kunde inte ladda fynd.';
      renderErrorState('Kunde inte hämta data.', String(error?.message ?? error));
    }
    return false;
  } finally {
    isLoading = false;
    refreshBtn?.classList.remove('spinning');
    refreshBtn?.removeAttribute('disabled');
  }
}

/**
 * Sparar den parsade listan så nästa besök kan rendera direkt, innan nätverket svarat.
 */
function saveSnapshot() {
  const slim = allDeals.map((d) => ({ ...d, imageUrl: undefined }));
  saveJsonToStorage(LS_SNAPSHOT, { savedAt: Date.now(), deals: slim });
}

/**
 * Renderar senaste sparade listan direkt om den är färsk nog (max 24 h).
 * @returns {boolean} true om något renderades
 */
function renderSnapshot() {
  const snap = loadJsonFromStorage(LS_SNAPSHOT, null);
  if (!snap?.deals?.length || Date.now() - snap.savedAt > 24 * 60 * 60 * 1000) return false;
  allDeals = snap.deals;
  populateCategoryFilter();
  populateStoreFilter();
  applyFiltersAndSort();
  statusText.textContent = 'Visar senast hämtade fynd - uppdaterar...';
  return true;
}

async function init() {
  loadImageCache();

  // Tema: sparat val, annars systemets.
  const savedTheme = localStorage.getItem(LS_THEME);
  if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
  else applyTheme(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  if (watchWordsInput) watchWordsInput.value = watchWords.join(', ');
  updateNotifyStatus();
  if (showHiddenBtn) showHiddenBtn.textContent = `Visa dolda fynd (${hiddenDeals.size})`;

  refreshBtn?.addEventListener('click', () => loadDeals({ silent: allDeals.length > 0 }));

  // Snabb första målning från förra besökets data, sedan riktig laddning i bakgrunden.
  const hadSnapshot = renderSnapshot();
  await loadDeals({ silent: hadSnapshot });
  focusHashedCard();

  // Markera besöket först nu, så att "Nytt"-märkena hinner beräknas mot förra besöket.
  localStorage.setItem(LS_LAST_VISIT, String(Date.now()));

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW-registrering misslyckades:', err));
  }

  // Tyst bakgrundsuppdatering med jämna mellanrum, och när fliken blir synlig
  // igen efter att ha varit dold en längre stund.
  let lastLoadAt = Date.now();
  const maybeRefresh = () => {
    if (document.hidden || isLoading) return;
    if (Date.now() - lastLoadAt < AUTO_REFRESH_INTERVAL) return;
    lastLoadAt = Date.now();
    loadDeals({ silent: true });
  };
  setInterval(maybeRefresh, 60 * 1000);
  document.addEventListener('visibilitychange', maybeRefresh);

  // Håll "Uppdaterat X min sedan" färskt utan att hämta något.
  setInterval(() => {
    if (!isLoading && allDeals.length > 0 && statusText.querySelector('.status-updated')) {
      updateStatusText();
    }
  }, 60 * 1000);
}

init();
