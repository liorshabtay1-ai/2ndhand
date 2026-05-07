# ⚖️ Fairness Meter — Chrome Extension

A Chrome Extension that overlays a **Market Value Comparison** card on Facebook Marketplace and Yad2 product listings, showing you the new retail price, average second-hand price, and a 0–100 Deal Score.

---

## Project Structure

```
Gem Scanner /
├── manifest.json        Manifest V3 — permissions, content scripts, icons
├── content.js           Selector engine + overlay logic (injected into product pages)
├── overlay.css          Overlay card styles (scoped, no global pollution)
├── background.js        Service worker (minimal; ready for API proxy pattern)
├── popup.html / .js     Extension toolbar popup
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate-icons.js   Script that produced the PNGs (requires `canvas`)
└── README.md
```

---

## How to Load in Chrome (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right corner)
3. Click **Load unpacked**
4. Select this folder (`Gem Scanner /`)
5. The ⚖️ icon will appear in your Chrome toolbar

> **Note:** After editing any file, click the ↺ refresh icon next to the extension on `chrome://extensions`, then hard-reload the product page.

---

## Supported Pages

| Site | URL Pattern |
|------|-------------|
| Facebook Marketplace | `facebook.com/marketplace/item/*` |
| Yad2 | `yad2.co.il/*` |

---

## How It Works

### 1. Selector Engine (`content.js`)

**Facebook Marketplace** — React SPA with unstable class names:
- Title: queries `<h1>` elements (Facebook always puts the item name there)
- Price: `TreeWalker` scans all text nodes for currency patterns (`₪`, `$`, `ש"ח`)

**Yad2** — more stable DOM:
- Title: tries `[data-testid*="title"]`, `[class*="title"]`, then `<h1>`
- Price: tries `[data-testid*="price"]`, `[class*="price"]`, falls back to ₪ leaf scan

### 2. SPA Navigation Watcher
Both sites are Single Page Applications. A `MutationObserver` watches for URL changes and re-runs the extraction + overlay logic when a new product page loads.

### 3. Mock Market Data
`fetchMarketData()` in `content.js` currently returns plausible mock values. The function signature is designed for easy API swap — see the comment block inside it.

---

## Connecting a Real API

### Option A — Direct fetch from content script
Replace the mock body of `fetchMarketData` in `content.js`:

```js
async function fetchMarketData(productName, currentPrice) {
  const res = await fetch('https://your-api.com/market', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productName, currentPrice }),
  });
  return res.json(); // must return { newPrice, avgSecondHand, dealScore, currency, source }
}
```

Add your API host to `host_permissions` in `manifest.json`.

### Option B — Proxy through the background service worker (recommended for API keys)
Use `chrome.runtime.sendMessage` from the content script and handle the fetch inside `background.js` (see the commented example there). This keeps API keys out of the page context.

---

## Content Security Policy

The extension uses a strict CSP in `manifest.json`:

```json
"content_security_policy": {
  "extension_pages": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
}
```

- No external scripts are loaded — zero supply-chain risk.
- `'unsafe-inline'` for styles is required because the overlay CSS is injected as a stylesheet file (not inline), but Chrome still flags it on extension pages without the directive.
- The overlay is fully self-contained; it does **not** affect the host page's layout (uses `position: fixed` with a very high `z-index`).

---

## Regenerating Icons

If you need different icon sizes or colours:

```bash
cd icons
npm install    # installs the `canvas` package
node generate-icons.js
```

---

## Roadmap Ideas

- [ ] Connect to a real price API (e.g., eBay Completed Listings, Yad2 search scrape, LLM valuation)
- [ ] Persist Deal Score history in `chrome.storage.local`
- [ ] Add price alerts ("notify me if this drops below X")
- [ ] Support additional marketplaces (Kijiji, OLX, etc.)
- [ ] Settings popup to toggle sites on/off
