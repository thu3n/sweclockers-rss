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

Jobbet bygger dessutom upp `data/history.json` (pris per Prisjakt-ID över tid,
för "Lägsta hittills"-märket och "Tidigare tipsat för") och `data/status.json`
(butikssidor som svarar 404/410 markeras "Sidan borta").

Statusraden visar när datan senast hämtades. Sidan kollar tyst efter nya fynd
var tionde minut och när fliken blir synlig igen. Knappen bredvid antalet fynd
uppdaterar manuellt.

## Funktioner

- Rabattmärke och överstruket ordinarie pris när inlägget anger det
- "Lägsta hittills" baserat på tidigare tips i trådarna
- "Nytt" på fynd som tillkommit sedan ditt förra besök, plus statistikrad
- Spara fynd (stjärna) och dölj fynd (kryss), lagras lokalt i webbläsaren
- Filter på butik, sortering på rabatt, butikslogotyper på knapparna
- Bevakningsord med webbnotiser när ett matchande fynd dyker upp
- Dela-knapp med länk direkt till kortet (`#post-<id>`)
- Ljust och mörkt tema (följer systemet, kan växlas, `?theme=light` fungerar också)
- Installerbar som app (PWA) med offline-reserv via service worker
- Senaste listan sparas lokalt så sidan ritas direkt vid nästa besök

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
