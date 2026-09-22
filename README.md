# FyndRadar

Samlade och rankade fynd från SweClockers-trådarna
[Dagens fynd](https://www.sweclockers.com/forum/trad/999559) och
[Övriga fynd](https://www.sweclockers.com/forum/trad/1465406).

Live: <https://thu3n.github.io/sweclockers-rss/>

## Hur datan hämtas

SweClockers RSS-flöden saknar CORS-headers, så en webbläsare kan inte läsa dem
direkt. Tidigare gick sidan via publika CORS-proxies, men de är opålitliga
(corsproxy.io kräver numera API-nyckel, allorigins och codetabs svarar sällan).

Nu hämtas flödena istället av GitHub Actions:

1. [update-feeds.yml](.github/workflows/update-feeds.yml) körs var 15:e minut
   (samt manuellt via *Run workflow*).
2. [fetch-feeds.mjs](scripts/fetch-feeds.mjs) laddar ner båda flödena, löser
   produktbilder via `og:image` för nya inlägg och skriver resultatet till `data/`:
   - `data/feed-tech.xml` och `data/feed-other.xml` - råa RSS-flöden
   - `data/images.json` - inläggs-URL till bild-URL
   - `data/meta.json` - tidsstämpel för senaste hämtning
3. Jobbet committar bara när något faktiskt ändrats.
4. Sidan läser `data/` same-origin. Om filerna saknas (t.ex. lokalt via `file://`)
   används de publika proxyerna som sista reserv.

Statusraden visar när datan senast hämtades. Sidan kollar tyst efter nya fynd
var tionde minut och när fliken blir synlig igen. Knappen bredvid antalet fynd
uppdaterar manuellt.

## Köra lokalt

```bash
node scripts/fetch-feeds.mjs   # fyller data/
python -m http.server 8000     # eller valfri statisk server
```

Öppna sedan <http://localhost:8000/>.

## AI-ranking

Under inställningar (kugghjulet) kan en OpenAI-nyckel anges för att sortera
listan efter prisvärdhet. Nyckeln lagras aldrig, bara rankingresultatet cachas
i webbläsaren.
