/**
 * FyndRadar — SweClockers Deals Ranking
 *
 * Fetches RSS feeds from SweClockers "Dagens fynd" and "Övriga fynd",
 * parses deal data, and renders a filterable/sortable ranking grid.
 * Optionally uses OpenAI API to score and rank deals.
 */

// ============================================================
// Constants
// ============================================================

/** Multiple CORS proxies — tried in order until one succeeds */
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const FEEDS = [
  {
    url: 'https://www.sweclockers.com/feeds/forum/trad/999559',
    source: 'tech',
    label: 'Teknik',
  },
  {
    url: 'https://www.sweclockers.com/feeds/forum/trad/1465406',
    source: 'other',
    label: 'Övrigt',
  },
];

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
    const proxyUrl = CORS_PROXIES[i](targetUrl);
    try {
      const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
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
      }
    } catch (err) {
      console.warn(`Proxy ${i + 1}/${CORS_PROXIES.length} failed for ${targetUrl}:`, err.message ?? err);
    }
  }
  throw new Error(`Alla CORS-proxies misslyckades för ${targetUrl}`);
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

    deals.push({
      id: link,
      title: parsed.productName,
      description: parsed.cleanText,
      author,
      link,
      pubDate: pubDate ? new Date(pubDate).toISOString() : '',
      price: parsed.price,
      category: parsed.category,
      source: meta.source,
      sourceLabel: meta.label,
      productLinks: parsed.productLinks,
      prisjaketLinks: parsed.prisjaketLinks,
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
  try {
    const xmlText = await fetchWithCorsProxy(feedConfig.url, true);
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

  // Extract product name — look for "Produkt:" field first
  let productName = '';
  const produktMatch = textContent.match(/Produkt:\s*(.+?)(?:\n|$)/);
  if (produktMatch) {
    productName = produktMatch[1].trim();
  } else {
    // Use first sentence as fallback
    const firstLine = textContent.trim().split('\n')[0] ?? '';
    productName = firstLine.substring(0, 120);
  }

  // Extract price — Swedish format: 8.243 kr = 8 243 SEK (dot = thousands, comma = decimal)
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
        return; // Don't add to productLinks — image links aren't buy-links
      }
    } catch {
      // href was not a valid URL — fall through
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
    .trim()
    .substring(0, 300);

  return { productName, price, category, cleanText, productLinks, prisjaketLinks, imageLinks };
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
    card.dataset.id = deal.id;
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
      ? `<span class="card-price">${formatPrice(deal.price)}</span>`
      : `<span class="card-price no-price">Pris ej angivet</span>`;

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
      </div>
      <div class="card-content-inner">
        <div class="card-header">
          <span class="card-source-badge ${deal.source}">${deal.sourceLabel}</span>
          ${deal.category !== 'Övrigt' ? `<span class="card-category">${escapeHtml(deal.category)}</span>` : ''}
        </div>
        <h3 class="card-title">${escapeHtml(deal.title)}</h3>
        ${deal.description ? `<p class="card-description">${escapeHtml(deal.description)}</p>` : ''}
        ${aiReasonHtml}
        
        <div class="card-footer">
          <div class="price-wrapper">
            <span class="price-label">Nuvarande pris</span>
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
    mainLabel = `Till erbjudandet (${store})`;
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
    }
  }

  displayDeals = filtered;
  renderDeals();
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
  // Simple djb2 hash — no crypto needed, just needs to be stable
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
    // localStorage kan vara full — ignorera tyst
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
    aiBannerText.textContent = `AI-rankad lista — ${rankings.length} fynd analyserade med ${OPENAI_MODEL}`;
  }

  applyFiltersAndSort();
}

/**
 * Sends deals to OpenAI for ranking/scoring.
 * Checks localStorage cache first — only calls the API if no valid cache exists.
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
      statusText.textContent = 'Ranking laddad från cache — inga API-anrop gjordes.';
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

    // Save to cache — API key is NOT saved
    saveRankingToCache(cacheKey, rankings);

    statusText.textContent = 'AI-ranking klar! Sparad i cache — inga fler API-anrop behövs.';
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
  if (e.target.tagName === 'BUTTON') {
    sourceFilter.querySelectorAll('.segment').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    currentSourceFilter = e.target.dataset.value;
    applyFiltersAndSort();
  }
});

categoryFilter.addEventListener('change', applyFiltersAndSort);
searchInput.addEventListener('input', applyFiltersAndSort);

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
  return str.replace(/[&<>"']/g, (c) => map[c] ?? c);
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
  if (diffDays < 7) return `${diffDays} dagar sedan`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} veckor sedan`;
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

    // Prisjakt / Prisbot — maps product comparison page to Pricespy's public CDN image.
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

    // Pricerunner — maps product comparison page to their public CDN image.
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
      hostname.includes('netonnet.se') ||
      hostname.includes('dustin.se')
    ) {
      return null;
    }

    // Use Microlink API specifically for sites known to block raw HTML proxies 
    // or return 1x1 pixels for deterministic images
    if (hostname.includes('amazon.') || hostname.includes('amzn.eu') || hostname.includes('lg.com') || hostname.includes('strauss.com')) {
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
      placeholder.innerHTML = `
        <img class="card-visual-image img-fade-in" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(deal.title)}" loading="lazy" referrerpolicy="no-referrer"
          onload="if(this.naturalWidth===1 && this.naturalHeight===1){ this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}'); }"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'; this.closest('.card-visual-placeholder').classList.remove('has-image'); markImageAsFailed('${escapeHtml(deal.id)}');" />
        <span class="card-visual-icon" style="display:none">${catIconSvg}</span>
      `;
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
 * 1. Prisjakt links on the deal — maps comparison page ID to Pricespy CDN image.
 * 2. Primary product link — deterministic URL patterns (Amazon, Webhallen, Komplett).
 * 3. CORS scraper fallback for all other stores not blocked by anti-bot systems.
 * @param {string} dealId - The unique ID of the deal post
 */
async function fetchImageForDeal(dealId) {
  const deal = allDeals.find((d) => d.id === dealId);
  // Require at least one link source — either a store URL or a comparison link
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
    // Only had Prisjakt links, and none resolved deterministically above — nothing more we can do
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

async function init() {
  loadImageCache();
  statusText.textContent = 'Hämtar fynd från SweClockers...';
  renderSkeletons(12);

  try {
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));

    let feedsLoaded = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allDeals.push(...result.value);
        feedsLoaded++;
      } else {
        const reason = result.status === 'rejected' ? result.reason : 'Inga deals hittades';
        console.error(`Feed "${FEEDS[i].label}" misslyckades:`, reason);
      }
    });

    // Deduplicate by post URL
    const seen = new Set();
    allDeals = allDeals.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });

    if (allDeals.length > 0) {
      populateCategoryFilter();
      applyFiltersAndSort(); // Render first so displayDeals is populated

      // Auto-restore cached ranking if one exists for this set of deals
      const cacheKey = buildCacheKey();
      const cached = loadRankingFromCache(cacheKey);
      if (cached?.rankings?.length > 0) {
        statusText.textContent = `${allDeals.length} fynd laddade — ranking återställd från cache automatiskt`;
        applyRankings(cached.rankings, cached.cachedAt);
      } else {
        statusText.textContent = `${allDeals.length} fynd laddade från ${feedsLoaded}/${FEEDS.length} trådar`;
      }
    } else {
      statusText.textContent = 'Inga fynd kunde hämtas. CORS-proxies kan vara nere — prova att ladda om sidan.';
      dealsGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          </div>
          <p>Kunde inte hämta data från SweClockers.</p>
          <p style="font-size: 0.85rem; margin-top: 0.5rem; color: var(--text-muted);">Alla CORS-proxies verkar vara nere. Prova att ladda om om en stund.</p>
        </div>`;
    }
  } catch (error) {
    console.error('Init error:', error);
    statusText.textContent = 'Kunde inte ladda fynd. Försök igen senare.';
    dealsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </div>
        <p>Kunde inte hämta data. Prova att ladda om sidan.</p>
      </div>`;
  }
}

init();

