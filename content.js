// ============================================================
// Fairness Meter — Content Script
// ============================================================

(function () {
  'use strict';

  // ── Site Detection ──────────────────────────────────────────

  function detectSite() {
    const host = window.location.hostname;
    if (host.includes('facebook.com')) return 'facebook';
    if (host.includes('yad2.co.il')) return 'yad2';
    return null;
  }

  const SITE = detectSite();

  // ── Universal helpers ───────────────────────────────────────

  function getMeta(property) {
    const el =
      document.querySelector(`meta[property="${property}"]`) ||
      document.querySelector(`meta[name="${property}"]`);
    return el ? el.getAttribute('content') : null;
  }

  // Strip site name suffixes from page title
  function cleanPageTitle() {
    return document.title
      .replace(/[|\-–—·•]\s*(Yad2|יד2|Facebook|Marketplace).*$/i, '')
      .trim();
  }

  // Extract a single clean price number from a text string
  function parseSinglePrice(text) {
    // Match the first standalone number (e.g. "3,300" from "₪3,300₪3,550")
    const match = text.replace(/[^\d,]/g, ' ').trim().match(/[\d,]+/);
    if (!match) return null;
    const num = parseFloat(match[0].replace(/,/g, ''));
    return isNaN(num) ? null : num;
  }

  // DOM distance between two nodes (number of edges via lowest common ancestor)
  function domDistance(a, b) {
    if (!a || !b) return Infinity;
    const ancestors = new Map();
    let depth = 0;
    for (let n = a; n; n = n.parentElement) ancestors.set(n, depth++);
    let d = 0;
    for (let n = b; n; n = n.parentElement, d++) {
      if (ancestors.has(n)) return ancestors.get(n) + d;
    }
    return Infinity;
  }

  // Find the current price in the DOM — returns { text, raw }
  // Strategy: collect all price candidates, prefer the one closest to <h1>
  // (the listing price), with the largest font as tiebreaker.
  function findPriceInDOM() {
    const PRICE_RE = /[₪]\s*[\d,]+|[\d,]+\s*[₪]|[\d,]{3,}\s*ש[״'"]?ח/g;
    const anchor = document.querySelector('h1') || document.body;

    const candidates = [];

    // Pass 1: hinted elements (class/id/data-testid contains "price")
    const hinted = document.querySelectorAll(
      '[class*="price" i],[id*="price" i],[data-testid*="price" i]'
    );
    for (const el of hinted) {
      if (el.children.length > 2) continue;
      const text = el.textContent.trim();
      const matches = text.match(PRICE_RE);
      if (matches && matches.length === 1) {
        const raw = parseSinglePrice(matches[0]);
        if (raw && raw > 0) candidates.push({ text: matches[0], raw, el, hinted: true });
      }
    }

    // Pass 2: walk leaf text nodes for prices anywhere on the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text || text.length > 40) continue;
      const matches = text.match(PRICE_RE);
      if (matches) {
        const raw = parseSinglePrice(matches[0]);
        if (raw && raw > 0) {
          candidates.push({ text: matches[0], raw, el: node.parentElement, hinted: false });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Score: prefer hinted, then closest to <h1>, then largest font-size
    candidates.forEach(c => {
      c.distance = domDistance(c.el, anchor);
      const fs = c.el ? parseFloat(getComputedStyle(c.el).fontSize) || 0 : 0;
      c.fontSize = fs;
    });
    candidates.sort((a, b) => {
      if (a.hinted !== b.hinted) return a.hinted ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return b.fontSize - a.fontSize;
    });
    return candidates[0];
  }

  // ── JSON-LD (Schema.org Product) extraction ─────────────────
  // Yad2 Market and many other sites embed Product data as <script type="application/ld+json">
  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const txt = s.textContent.trim();
        if (!txt) continue;
        const data = JSON.parse(txt);
        const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          const found = findProductInLd(obj);
          if (found) return found;
        }
      } catch { /* ignore parse errors */ }
    }
    return null;
  }

  function findProductInLd(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    const type = obj['@type'];
    const isProduct = type === 'Product' ||
      (Array.isArray(type) && type.includes('Product')) ||
      type === 'IndividualProduct' || type === 'Offer';
    if (isProduct) {
      const name = obj.name || obj.headline || obj.title;
      const offer = obj.offers || (obj['@type'] === 'Offer' ? obj : null);
      const offerObj = Array.isArray(offer) ? offer[0] : offer;
      const priceVal = Number(offerObj?.price ?? obj.price ?? 0);
      const image = (Array.isArray(obj.image) ? obj.image[0] : obj.image) || null;
      if (name && priceVal > 0) {
        return {
          title: typeof name === 'string' ? name : null,
          price: `₪${priceVal.toLocaleString()}`,
          rawPrice: priceVal,
          imageUrl: typeof image === 'string' && image.startsWith('http') ? image : null,
        };
      }
    }
    // Recurse into @graph and other nested arrays/objects
    if (Array.isArray(obj['@graph'])) {
      for (const node of obj['@graph']) {
        const r = findProductInLd(node, depth + 1);
        if (r) return r;
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const r = findProductInLd(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // ── Image Extraction ────────────────────────────────────────

  function extractMainImageUrl() {
    // og:image is server-rendered and most reliable
    const ogImage = getMeta('og:image');
    if (ogImage && ogImage.startsWith('http')) return ogImage;

    // Fall back to the largest visible img on the page
    const imgs = [...document.querySelectorAll('img[src]')];
    const candidates = imgs.filter(img => {
      const src = img.src;
      return (
        src.startsWith('http') &&
        img.naturalWidth > 200 &&
        img.naturalHeight > 200 &&
        !src.includes('logo') &&
        !src.includes('icon') &&
        !src.includes('avatar') &&
        !src.includes('profile')
      );
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    return candidates[0].src;
  }

  // ── Selector Engine: Yad2 ──────────────────────────────────

  // Try to find a listing object inside Yad2's __NEXT_DATA__ JSON.
  // Yad2 product pages embed full listing data here — far more reliable than DOM scraping.
  function extractYad2FromNextData() {
    try {
      const raw = document.getElementById('__NEXT_DATA__')?.textContent;
      if (!raw) return null;
      const json = JSON.parse(raw);

      // Recursively look for an object that has a price field
      function find(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 7) return null;
        const priceField = obj.price ?? obj.Price ?? obj.priceValue;
        if (typeof priceField === 'number' && priceField > 0 && (obj.title || obj.name || obj.subtitle || obj.itemTitle || obj.headline)) {
          return obj;
        }
        for (const val of Object.values(obj)) {
          const found = find(val, depth + 1);
          if (found) return found;
        }
        return null;
      }

      const item = find(json?.props?.pageProps) || find(json);
      if (!item) return null;

      const priceNum = Number(item.price ?? item.Price ?? item.priceValue);
      const titleText = item.title || item.name || item.subtitle || item.itemTitle || item.headline || null;
      const imageUrl =
        item.coverImage || item.image || item.imageUrl ||
        (Array.isArray(item.images) && item.images[0]?.src) ||
        (Array.isArray(item.images) && typeof item.images[0] === 'string' ? item.images[0] : null) ||
        null;

      return {
        title: titleText,
        price: priceNum > 0 ? `₪${priceNum.toLocaleString()}` : null,
        rawPrice: priceNum > 0 ? priceNum : 0,
        imageUrl: imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
      };
    } catch (e) {
      console.warn('[FM] Yad2 __NEXT_DATA__ parse failed:', e.message);
      return null;
    }
  }

  function extractYad2Data() {
    // Primary: __NEXT_DATA__ JSON (Pages Router — older Yad2 sections)
    const nd = extractYad2FromNextData();
    if (nd && nd.rawPrice > 0) {
      const imageUrl = nd.imageUrl || extractMainImageUrl();
      console.log('[FM] Yad2 (NEXT_DATA) →', { ...nd, imageUrl });
      return { ...nd, imageUrl, site: 'Yad2' };
    }

    // Secondary: JSON-LD Product schema (App Router — Yad2 Market)
    const ld = extractFromJsonLd();
    if (ld && ld.rawPrice > 0) {
      const imageUrl = ld.imageUrl || extractMainImageUrl();
      console.log('[FM] Yad2 (JSON-LD) →', { ...ld, imageUrl });
      return { ...ld, imageUrl, site: 'Yad2' };
    }

    // Fallback: DOM/meta scraping
    const h1Text = document.querySelector('h1')?.textContent?.trim() || null;
    let title =
      getMeta('og:title') ||
      getMeta('twitter:title') ||
      h1Text ||
      cleanPageTitle() ||
      null;

    if (title) title = title.replace(/[\-–|]\s*(יד2|Yad2).*$/i, '').trim();

    const priceResult = findPriceInDOM();
    const price = priceResult ? priceResult.text : null;
    const rawPrice = priceResult ? priceResult.raw : 0;
    const imageUrl = extractMainImageUrl();

    console.log('[FM] Yad2 (DOM) →', { title, price, rawPrice, imageUrl });
    return { title, price, rawPrice, imageUrl, site: 'Yad2' };
  }

  // ── Selector Engine: Facebook Marketplace ──────────────────

  function extractFacebookData() {
    let title = getMeta('og:title') || null;

    if (!title) {
      const h1 = document.querySelector('h1');
      if (h1) title = h1.textContent.trim();
    }

    if (!title) title = cleanPageTitle();
    if (title) title = title.replace(/\s*[-|·]\s*Facebook.*$/i, '').trim();

    const priceResult = findPriceInDOM();
    const price = priceResult ? priceResult.text : null;
    const rawPrice = priceResult ? priceResult.raw : 0;
    const imageUrl = extractMainImageUrl();

    console.log('[FM] Facebook →', { title, price, rawPrice, imageUrl });
    return { title, price, rawPrice, imageUrl, site: 'Facebook Marketplace' };
  }

  // ── Mock Market Data API ─────────────────────────────────────
  // Replace this function's body to connect a real API.
  // Required return shape: { newPrice, avgSecondHand, dealScore, currency, source }

  async function fetchMarketData(productName, currentPrice, imageUrl, opts = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'FETCH_MARKET_DATA',
          payload: {
            productName,
            listedPrice: currentPrice,
            currency: '₪',
            imageUrl,
            listingUrl: window.location.href,
            forceRefresh: !!opts.forceRefresh,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  // ── Overlay UI ───────────────────────────────────────────────

  const OVERLAY_ID = 'fairness-meter-root';

  function buildOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = OVERLAY_ID;

    root.innerHTML = `
      <div class="fm-card" id="fm-card">
        <div class="fm-header">
          <div class="fm-header-left">
            <span class="fm-icon">⚖️</span>
            <span class="fm-brand">Fairness Meter</span>
          </div>
          <div class="fm-header-actions">
            <button class="fm-btn-icon" id="fm-refresh-btn" title="Refresh analysis">↻</button>
            <button class="fm-btn-icon" id="fm-toggle-btn" title="Minimize">−</button>
            <button class="fm-btn-icon" id="fm-close-btn" title="Close">✕</button>
          </div>
        </div>

        <div id="fm-body">
          <div class="fm-status" id="fm-status">
            <div class="fm-spinner-wrap"><div class="fm-spinner"></div></div>
            <span id="fm-status-text">Analyzing product…</span>
          </div>

          <div class="fm-product" id="fm-product" style="display:none">
            <div class="fm-product-name" id="fm-product-name"></div>
            <div class="fm-detected-model" id="fm-detected-model" style="display:none">
              <span class="fm-model-badge" id="fm-model-text"></span>
            </div>
            <div class="fm-product-price-row">
              <span class="fm-label">Listed at</span>
              <span class="fm-product-price" id="fm-product-price">—</span>
            </div>
          </div>

          <div class="fm-comparison" id="fm-comparison" style="display:none">
            <div class="fm-divider"></div>
            <div class="fm-row">
              <span class="fm-label">New Price</span>
              <div class="fm-value-with-source">
                <span class="fm-value" id="fm-new-price">—</span>
                <a class="fm-source-link" id="fm-source-link" target="_blank" rel="noopener noreferrer" style="display:none"></a>
              </div>
            </div>
            <div class="fm-row">
              <span class="fm-label">Avg Second Hand</span>
              <span class="fm-value" id="fm-avg-price">—</span>
            </div>
            <div class="fm-divider"></div>
            <div class="fm-score-section">
              <div class="fm-score-header">
                <span class="fm-label">Deal Score</span>
                <span class="fm-score-num" id="fm-score-num">—</span>
              </div>
              <div class="fm-bar-track">
                <div class="fm-bar-fill" id="fm-bar-fill"></div>
              </div>
              <div class="fm-score-verdict" id="fm-score-verdict"></div>
            </div>
          </div>

          <div class="fm-error" id="fm-error" style="display:none">
            <span id="fm-error-text"></span>
          </div>

          <div class="fm-reasoning" id="fm-reasoning" style="display:none">
            <div class="fm-divider"></div>
            <div class="fm-reasoning-label">Why this score?</div>
            <div class="fm-reasoning-text" id="fm-reasoning-text"></div>
          </div>

          <div class="fm-similar" id="fm-similar" style="display:none">
            <div class="fm-divider"></div>
            <div class="fm-similar-text" id="fm-similar-text"></div>
            <a class="fm-similar-link" id="fm-similar-link" target="_blank" rel="noopener noreferrer">
              Search this product →
            </a>
          </div>

          <div class="fm-footer" id="fm-footer" style="display:none">
            <span id="fm-source-text"></span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    root.querySelector('#fm-close-btn').addEventListener('click', () => root.remove());

    root.querySelector('#fm-refresh-btn').addEventListener('click', () => {
      run({ forceRefresh: true });
    });

    let collapsed = false;
    const body = root.querySelector('#fm-body');
    root.querySelector('#fm-toggle-btn').addEventListener('click', (e) => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      e.currentTarget.textContent = collapsed ? '+' : '−';
    });

    const card = root.querySelector('#fm-card');
    restoreWidgetPosition(card);
    makeDraggable(card, root.querySelector('.fm-header'));
    return root;
  }

  // ── Widget position persistence ─────────────────────────────

  const POSITION_KEY = 'fm_widget_position';

  function restoreWidgetPosition(card) {
    try {
      chrome.storage.local.get(POSITION_KEY, (obj) => {
        const pos = obj[POSITION_KEY];
        if (!pos) return;
        if (typeof pos.right === 'number') card.style.right = pos.right + 'px';
        if (typeof pos.top === 'number') card.style.top = pos.top + 'px';
        card.style.bottom = 'auto';
      });
    } catch { /* storage may be unavailable in some contexts */ }
  }

  function saveWidgetPosition(card) {
    try {
      const rect = card.getBoundingClientRect();
      const right = window.innerWidth - rect.right;
      const top = rect.top;
      chrome.storage.local.set({ [POSITION_KEY]: { right, top } });
    } catch { /* ignore */ }
  }

  function makeDraggable(card, handle) {
    let startX, startY, startRight, startTop, dragging = false;
    handle.style.cursor = 'grab';

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = card.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      card.style.right = Math.max(0, startRight - (e.clientX - startX)) + 'px';
      card.style.top = Math.max(0, startTop + (e.clientY - startY)) + 'px';
      card.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        handle.style.cursor = 'grab';
        saveWidgetPosition(card);
      }
    });
  }

  // ── DOM helpers ─────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }
  function isOverlayAlive() { return !!document.getElementById(OVERLAY_ID); }

  // ── Overlay State Updaters ───────────────────────────────────

  function renderProduct(data) {
    if (!isOverlayAlive()) return;
    const nameEl = el('fm-product-name');
    const priceEl = el('fm-product-price');
    const productEl = el('fm-product');
    const statusText = el('fm-status-text');

    if (nameEl) nameEl.textContent = data.title
      ? (data.title.length > 65 ? data.title.slice(0, 62) + '…' : data.title)
      : '(name not detected)';
    if (priceEl) priceEl.textContent = data.price || 'N/A';
    if (productEl) productEl.style.display = 'block';
    if (statusText) statusText.textContent = 'Fetching market data…';
  }

  function renderMarketData(market, listedPrice) {
    if (!isOverlayAlive()) return;
    const statusEl = el('fm-status');
    const compEl = el('fm-comparison');
    if (statusEl) statusEl.style.display = 'none';
    if (compEl) compEl.style.display = 'block';

    // Detected model
    const modelEl = el('fm-detected-model');
    const modelText = el('fm-model-text');
    if (modelEl && modelText && market.detectedModel) {
      modelEl.style.display = 'block';
      modelText.textContent = `🔍 ${market.detectedModel}`;
    }

    // New price + source link
    const np = el('fm-new-price');
    if (np) np.textContent = `${market.currency}${market.newPrice.toLocaleString()}`;

    const sourceLink = el('fm-source-link');
    if (sourceLink && market.sourceUrl) {
      sourceLink.href = market.sourceUrl;
      sourceLink.textContent = `↗ ${market.sourceLabel || 'Source'}`;
      sourceLink.style.display = 'inline';
    }

    const ap = el('fm-avg-price');
    if (ap) ap.textContent = `${market.currency}${market.avgSecondHand.toLocaleString()}`;

    const score = market.dealScore;
    const fill = el('fm-bar-fill');
    const scoreNum = el('fm-score-num');
    const verdict = el('fm-score-verdict');

    if (scoreNum) scoreNum.textContent = `${score} / 100`;

    if (fill) {
      fill.style.width = `${score}%`;
      if (score >= 70) { fill.className = 'fm-bar-fill fm-bar-great'; if (verdict) verdict.textContent = '🔥 Great deal — well below market'; }
      else if (score >= 45) { fill.className = 'fm-bar-fill fm-bar-fair'; if (verdict) verdict.textContent = '👍 Fair — close to market average'; }
      else if (score >= 20) { fill.className = 'fm-bar-fill fm-bar-weak'; if (verdict) verdict.textContent = '🤔 A bit pricey — room to negotiate'; }
      else { fill.className = 'fm-bar-fill fm-bar-poor'; if (verdict) verdict.textContent = '⚠️ Overpriced compared to market'; }
    }

    // Reasoning
    const reasoningEl = el('fm-reasoning');
    const reasoningText = el('fm-reasoning-text');
    if (reasoningEl && reasoningText && market.reasoning) {
      reasoningEl.style.display = 'block';
      reasoningText.textContent = market.reasoning;
    }

    // Similar product
    const similarEl = el('fm-similar');
    const similarText = el('fm-similar-text');
    const similarLink = el('fm-similar-link');
    if (similarEl && market.similarProduct) {
      const { name, searchUrl } = market.similarProduct;
      similarEl.style.display = 'block';
      if (similarText) {
        similarText.textContent = `אם התקציב שלך הוא ${market.currency}${listedPrice.toLocaleString()}, שווה לבדוק את ${name} — חדש במחיר דומה.`;
      }
      if (similarLink && searchUrl) {
        similarLink.href = searchUrl;
        similarLink.textContent = `🔍 ${name} →`;
      }
    }
  }

  function renderError(msg) {
    if (!isOverlayAlive()) return;
    const s = el('fm-status'); if (s) s.style.display = 'none';
    const e = el('fm-error'); if (e) e.style.display = 'block';
    const t = el('fm-error-text'); if (t) t.textContent = `⚠️ ${msg}`;
  }

  // ── Wait for DOM content ─────────────────────────────────────
  // Instead of a fixed delay, wait until og:title or h1 appears (max 8s)

  function waitForContent() {
    return new Promise((resolve) => {
      const check = () =>
        getMeta('og:title') ||
        document.querySelector('h1') ||
        cleanPageTitle().length > 3;

      if (check()) return resolve();

      const timer = setTimeout(resolve, 8000);
      const obs = new MutationObserver(() => {
        if (check()) { clearTimeout(timer); obs.disconnect(); resolve(); }
      });
      obs.observe(document.documentElement, { subtree: true, childList: true });
    });
  }

  // ── Main Flow ────────────────────────────────────────────────

  async function run(opts = {}) {
    if (!SITE) return;

    await waitForContent();

    let data;
    try {
      data = SITE === 'facebook' ? extractFacebookData() : extractYad2Data();
    } catch (err) {
      console.error('[FM]', err);
      data = { title: null, price: null, rawPrice: 0, imageUrl: null, site: SITE === 'facebook' ? 'Facebook Marketplace' : 'Yad2' };
    }

    // Always show overlay on a product page — even if extraction failed,
    // so the user gets feedback instead of a silent no-op.
    buildOverlay();

    if (!data.price) {
      renderProduct(data);
      renderError('Couldn\'t detect product price on this page. Make sure you\'re on a specific listing (not search results), then reload.');
      return;
    }

    renderProduct(data);

    try {
      const market = await fetchMarketData(data.title, data.rawPrice, data.imageUrl, { forceRefresh: opts.forceRefresh });
      if (!market.ok) {
        if (market.error === 'NO_API_KEY') {
          renderError('Set your Claude API key in the extension popup (⚖️).');
        } else {
          renderError(`API error: ${market.error}`);
        }
        return;
      }
      renderMarketData(market, data.rawPrice);
    } catch (err) {
      renderError('Market data fetch failed.');
      console.error('[FM]', err);
    }
  }

  // ── SPA Navigation Watcher ───────────────────────────────────

  function isProductPage() {
    const url = window.location.href;
    if (/facebook\.com\/marketplace\/item\//.test(url)) return true;
    // Yad2: only specific listing pages (not search, not category, not homepage)
    if (/yad2\.co\.il\/(market|item|products)\/.*\d/.test(url)) return true;
    return false;
  }

  let lastUrl = location.href;
  let runScheduled = false;

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isProductPage() && !runScheduled) {
        runScheduled = true;
        setTimeout(() => { runScheduled = false; run(); }, 600);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true });

  if (isProductPage()) run();

})();
