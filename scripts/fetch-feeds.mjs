/**
 * Hämtar SweClockers-flödena server-side (GitHub Actions) och sparar dem i
 * data/, så att sidan kan läsa dem same-origin utan CORS-proxy.
 *
 * Skriver:
 *   data/feed-tech.xml   - Dagens fynd (tråd 999559)
 *   data/feed-other.xml  - Övriga fynd (tråd 1465406)
 *   data/images.json     - { "<inläggs-URL>": "<bild-URL>" | null }
 *   data/meta.json       - { updatedAt, feeds: { tech: n, other: n } }
 *
 * Körs med: node scripts/fetch-feeds.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

const FEEDS = [
  { key: 'tech', url: 'https://www.sweclockers.com/feeds/forum/trad/999559' },
  { key: 'other', url: 'https://www.sweclockers.com/feeds/forum/trad/1465406' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/** Domäner som klienten redan löser deterministiskt eller som inte är butiker. */
const SKIP_IMAGE_HOSTS = [
  'sweclockers.com',
  'prisjakt.nu',
  'pricespy.',
  'pricerunner.',
  'prisbot.',
  'webhallen.com',
  'komplett.',
];

/** Max antal nya bildupplösningar per körning, så jobbet håller sig snabbt. */
const MAX_NEW_IMAGES = 40;

async function fetchText(url, { timeoutMs = 15000, maxBytes = 400_000, accept = '*/*' } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: accept,
      'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // Läs bara början av svaret; og:image ligger i <head>.
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Plockar ut inlägg (post-URL + första butikslänk) ur rå RSS-XML. */
function extractItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    const link = body.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
    if (!link) continue;
    const desc = body.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? '';
    const hrefs = [...desc.matchAll(/href="([^"]+)"/g)].map((h) => decodeEntities(h[1]));
    const productUrl = hrefs.find((h) => {
      try {
        const host = new URL(h).hostname.toLowerCase();
        return !SKIP_IMAGE_HOSTS.some((s) => host.includes(s));
      } catch {
        return false;
      }
    });
    items.push({ link, productUrl: productUrl ?? null });
  }
  return items;
}

function extractOgImage(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  ];
  for (const re of patterns) {
    const hit = html.match(re);
    if (hit) {
      const raw = decodeEntities(hit[1]).trim();
      try {
        const abs = new URL(raw, baseUrl).toString();
        if (/^https?:\/\//.test(abs)) return abs;
      } catch {
        /* ogiltig URL */
      }
    }
  }
  return null;
}

/**
 * @returns {Promise<string|null|undefined>} bild-URL, null = permanent miss,
 *   undefined = tillfälligt fel (429/timeout) som ska försökas igen nästa körning.
 */
async function resolveImage(productUrl) {
  try {
    const html = await fetchText(productUrl, {
      timeoutMs: 10000,
      accept: 'text/html,application/xhtml+xml',
    });
    return extractOgImage(html, productUrl);
  } catch (err) {
    const transient = /HTTP (429|5\d\d)|timeout|Timeout|ECONN|fetch failed/.test(err.message ?? '');
    console.warn(`  bild misslyckades ${productUrl}: ${err.message}${transient ? ' (försöker igen senare)' : ''}`);
    return transient ? undefined : null;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const meta = { updatedAt: new Date().toISOString(), feeds: {} };
  const allItems = [];
  let anyFeedOk = false;

  for (const feed of FEEDS) {
    const outFile = path.join(DATA_DIR, `feed-${feed.key}.xml`);
    try {
      const xml = await fetchText(feed.url, {
        maxBytes: 5_000_000,
        accept: 'application/rss+xml,application/xml,text/xml',
      });
      if (!xml.includes('<rss') && !xml.includes('<channel')) {
        throw new Error('svaret ser inte ut som RSS');
      }
      const items = extractItems(xml);
      if (items.length === 0) throw new Error('inga <item> hittades');

      // lastBuildDate ändras vid varje hämtning; ta bort så att commits bara sker
      // när själva innehållet ändrats.
      const stable = xml.replace(/\s*<lastBuildDate>[^<]*<\/lastBuildDate>/, '');
      await writeFile(outFile, stable, 'utf8');

      meta.feeds[feed.key] = items.length;
      allItems.push(...items);
      anyFeedOk = true;
      console.log(`OK ${feed.key}: ${items.length} inlägg`);
    } catch (err) {
      console.error(`FEL ${feed.key}: ${err.message} (behåller tidigare fil)`);
      meta.feeds[feed.key] = null;
    }
  }

  if (!anyFeedOk) {
    console.error('Inget flöde kunde hämtas. Avbryter utan att skriva meta.json.');
    process.exit(1);
  }

  // Bilder: behåll tidigare upplösta, lös bara nya inlägg.
  const imagesFile = path.join(DATA_DIR, 'images.json');
  const previous = await readJson(imagesFile, {});
  const images = {};
  const currentLinks = new Set(allItems.map((i) => i.link));

  // Behåll bara bilder för inlägg som fortfarande finns i något flöde.
  for (const [link, img] of Object.entries(previous)) {
    if (currentLinks.has(link)) images[link] = img;
  }

  const pending = allItems
    .filter((i) => i.productUrl && !(i.link in images))
    .slice(0, MAX_NEW_IMAGES);
  console.log(`Löser bilder för ${pending.length} nya inlägg...`);

  const CONCURRENCY = 5;
  let idx = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (idx < pending.length) {
        const item = pending[idx++];
        const result = await resolveImage(item.productUrl);
        if (result !== undefined) images[item.link] = result;
      }
    })
  );

  const resolved = Object.values(images).filter(Boolean).length;
  console.log(`Bilder: ${resolved}/${Object.keys(images).length} upplösta`);

  await writeFile(imagesFile, JSON.stringify(images, null, 2) + '\n', 'utf8');
  await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`Klart. Uppdaterad ${meta.updatedAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
