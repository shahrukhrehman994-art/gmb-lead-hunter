// ─────────────────────────────────────────────────────────────
//  GMB Lead Hunter — content.js  (v7)
//  - Excludes permanently closed businesses
//  - Collects ALL businesses (categorized by filters in popup)
//  - Extracts: socials, review recency, unclaimed status,
//    owner reply status, photo count, description, open/closed
//  - Deduplicates across sessions via stored keys
//  - v7: Robust multi-strategy rating/review selectors
// ─────────────────────────────────────────────────────────────

if (typeof window.__gmbLeadHunterLoaded === 'undefined') {
window.__gmbLeadHunterLoaded = true;

let scraping = false;
let abortScrape = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') { sendResponse({ ok: true }); return; }
  if (msg.type === 'START_SCRAPE') {
    if (scraping) { sendResponse({ ok: true }); return; }
    abortScrape = false;
    runScrape(msg.limit || 20, msg.delayMs || 0)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'ABORT_SCRAPE') {
    abortScrape = true; scraping = false;
    sendResponse({ ok: true });
  }
});

// ── Main orchestrator ─────────────────────────────────────────
async function runScrape(limit, delayMs) {
  scraping = true;
  let closedSkipped = 0, dupesSkipped = 0, leadsFound = 0;

  try {
    await setProgress(2, 'Waiting for results panel...');

    const feed = await waitFor(
      () => document.querySelector('[role="feed"]'),
      15000,
      'No results panel found. Make sure a Maps search is active.'
    );

    await setProgress(5, 'Scrolling to load listings...');
    await scrollFeed(feed, limit);

    const items = collectItems(feed);
    await setProgress(8, `Found ${items.length} listings - loading dedup keys...`);

    // Load existing dedup keys
    const stored = await chrome.storage.local.get('dedupKeys');
    const dedupKeys = new Set(stored.dedupKeys || []);

    const total = Math.min(items.length, limit);

    for (let i = 0; i < total; i++) {
      if (abortScrape) break;

      const pct = 10 + Math.round((i / total) * 87);
      await setProgress(pct, `Reading ${i + 1}/${total}... (${leadsFound} saved, ${closedSkipped} closed, ${dupesSkipped} dupes)`);

      if (delayMs > 0) await sleep(delayMs);

      try {
        const biz = await extractBusiness(items[i]);
        if (!biz) continue;

        // 1) Exclude permanently closed
        if (biz._permanentlyClosed) {
          closedSkipped++;
          continue;
        }

        // 2) Duplicate check
        const dedupKey = (biz.name + '|' + biz.address).toLowerCase().trim();
        if (dedupKeys.has(dedupKey)) {
          dupesSkipped++;
          continue;
        }

        // Store dedup key
        dedupKeys.add(dedupKey);
        leadsFound++;
        await appendResult(biz);
      } catch (e) { /* skip */ }

      await sleep(400 + Math.random() * 200);
    }

    // Persist updated dedup keys
    await chrome.storage.local.set({ dedupKeys: Array.from(dedupKeys) });

    await chrome.storage.local.set({
      scrapeState: {
        status: 'done', pct: 100,
        label: `Done! ${leadsFound} businesses saved. ${closedSkipped} closed skipped. ${dupesSkipped} dupes skipped.`
      },
    });
  } catch (err) {
    await chrome.storage.local.set({
      scrapeState: { status: 'error', message: err.message },
    });
  } finally {
    scraping = false;
  }
}

// ── Scroll feed ───────────────────────────────────────────────
async function scrollFeed(feed, limit) {
  const passes = Math.ceil(limit / 6);
  for (let i = 0; i < passes; i++) {
    feed.scrollTop = feed.scrollHeight;
    await sleep(1400);
    if (feed.querySelector('span.HlvSq')) break;
  }
  feed.scrollTop = 0;
  await sleep(500);
}

function collectItems(feed) {
  const articles = Array.from(feed.querySelectorAll('[role="article"]'));
  if (articles.length) return articles;
  return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
}

// ── Panel review fingerprint (used to detect panel swap) ─────
function getPanelReviewLabel() {
  const main = document.querySelector('[role="main"]');
  if (!main) return '';
  // The review-count button aria-label is unique per business and loads
  // alongside the rating — e.g. "1,234 reviews"
  for (const btn of main.querySelectorAll('button[aria-label]')) {
    const l = btn.getAttribute('aria-label') || '';
    if (/reviews?/i.test(l)) return l;
  }
  // Fallback: the star-rating aria-label
  for (const el of main.querySelectorAll('[aria-label*="star" i], [aria-label*="rated" i]')) {
    const l = el.getAttribute('aria-label') || '';
    if (l) return l;
  }
  return '';
}

// ── Extract one business ──────────────────────────────────────
async function extractBusiness(item) {
  const main = document.querySelector('[role="main"]');

  // Snapshot identifiers of the CURRENT panel so we can detect a full swap.
  // We use the h1 text AND the URL (Maps updates the URL per business) AND
  // the review-count aria-label — reviews/photos are the last things to load.
  const prevName    = (document.querySelector('h1.DUwDvf, h1[class*="fontHeadline"]')?.textContent || '').trim().toLowerCase();
  const prevUrl     = window.location.href;
  const prevReviewLabel = getPanelReviewLabel();

  item.click();

  // ── Step 1: wait for h1 + URL to change (panel navigation complete) ──
  const h1El = await waitFor(
    () => {
      const h1 = document.querySelector('h1.DUwDvf, h1[class*="fontHeadline"]');
      if (!h1 || !h1.textContent.trim()) return null;
      const currentName = h1.textContent.trim().toLowerCase();
      if (prevName && currentName === prevName) return null;
      if (!document.querySelector('[role="main"] [data-item-id]')) return null;
      return h1;
    },
    9000
  );
  if (!h1El) return null;

  // ── Step 2: wait for the review/photo section to reflect the NEW business ──
  // Google lazily replaces these nodes; we wait until the review aria-label
  // or the URL-embedded place-id changes from what we snapshotted.
  await waitFor(
    () => {
      // URL must have changed (each business gets its own Maps URL)
      if (window.location.href === prevUrl) return null;
      // The review label must differ from the previous business's label
      const curLabel = getPanelReviewLabel();
      // If previous had no reviews and current also has none, that's fine —
      // just ensure the URL already changed (checked above).
      if (prevReviewLabel && curLabel === prevReviewLabel) return null;
      return true;
    },
    6000
  ).catch(() => null); // non-fatal — fall through if reviews simply don't exist

  // Extra buffer for photo thumbnails and lazy-loaded sections
  await sleep(800);

  const name = h1El.textContent.trim();
  if (!name) return null;

  const closed = isPermanentlyClosed();
  if (closed) return { _permanentlyClosed: true, name, address: getAddress() };

  const socials = getSocialMedia();
  const reviewInfo = getLatestReviewDate();
  const unanswered = getUnansweredReviewInfo();
  const photoCount = getPhotoCount();
  const description = getDescription();
  const openStatus = getOpenStatus();
  const unclaimed = isUnclaimed();
  const website = getWebsite();

  return {
    name,
    address:            getAddress(),
    phone:              getPhone(),
    website,
    rating:             getRating(),
    reviewCount:        getReviews(),
    socials,
    latestReviewText:   reviewInfo.text,
    latestReviewDays:   reviewInfo.daysAgo,
    noRecentReviews:    reviewInfo.daysAgo === null || reviewInfo.daysAgo > 90,
    isUnclaimed:        unclaimed,
    unansweredReviews:  unanswered.unanswered,
    totalReviewsChecked:unanswered.total,
    hasUnanswered:      unanswered.hasUnanswered,
    photoCount,
    hasLowPhotos:       photoCount < 3,
    description,
    hasDescription:     description.length > 0,
    openStatusText:     openStatus.text,
    isOpen:             openStatus.isOpen,
    mapsUrl:            window.location.href,
    hasWebsite:         !!website,
    scrapedAt:          Date.now(),
    _permanentlyClosed: false,
  };
}

// ── Permanently Closed Check ──────────────────────────────────
function isPermanentlyClosed() {
  const main = document.querySelector('[role="main"]');
  if (!main) return false;
  // Check for the prominent "Permanently closed" label
  const spans = main.querySelectorAll('span, div');
  for (const el of spans) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (t === 'permanently closed') return true;
  }
  // Check aria-labels
  const ariaEls = main.querySelectorAll('[aria-label]');
  for (const el of ariaEls) {
    if ((el.getAttribute('aria-label') || '').toLowerCase().includes('permanently closed')) return true;
  }
  return false;
}

// ── Unclaimed Check ───────────────────────────────────────────
function isUnclaimed() {
  const main = document.querySelector('[role="main"]');
  if (!main) return false;
  const els = main.querySelectorAll('a, button, span');
  for (const el of els) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (t.includes('own this business') || t.includes('claim this business')) return true;
  }
  return false;
}

// ── Photo Count ───────────────────────────────────────────────
function getPhotoCount() {
  const main = document.querySelector('[role="main"]');
  if (!main) return 0;

  // Strategy 1: Look for "All (X)" or "Photos (X)" or "X photos" in buttons/tabs
  const btns = main.querySelectorAll('button, a, [role="tab"]');
  for (const btn of btns) {
    const t = (btn.textContent || '').trim();
    let m = t.match(/(\d+)\s*photos?/i) || t.match(/photos?\s*\((\d+)\)/i) || t.match(/all\s*\((\d+)\)/i);
    if (m) return parseInt(m[1]);
  }

  // Strategy 2: aria-labels
  const ariaEls = main.querySelectorAll('[aria-label]');
  for (const el of ariaEls) {
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(/(\d+)\s*photos?/i);
    if (m) return parseInt(m[1]);
  }

  // Strategy 3: Count photo thumbnail elements
  const thumbs = main.querySelectorAll('button[aria-label*="photo" i], button[aria-label*="Photo"]');
  if (thumbs.length > 0) return thumbs.length;

  return 0;
}

// ── Description / About ───────────────────────────────────────
function getDescription() {
  // Strategy 1: Editorial summary data attribute
  const ed = document.querySelector('[data-item-id="editorial-summary"]');
  if (ed) {
    const txt = ed.textContent.trim();
    if (txt) return txt;
  }

  // Strategy 2: Look for an About/Overview section
  const main = document.querySelector('[role="main"]');
  if (!main) return '';

  // Check for description-style text blocks
  const descEls = main.querySelectorAll('.PYvSYb, [class*="editorial"], [class*="summary"]');
  for (const el of descEls) {
    const txt = el.textContent.trim();
    if (txt.length > 20) return txt;
  }

  // Strategy 3: aria-label containing "About"
  const ariaEls = main.querySelectorAll('[aria-label]');
  for (const el of ariaEls) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('about') || label.includes('description') || label.includes('overview')) {
      const txt = el.textContent.trim();
      if (txt.length > 20) return txt;
    }
  }

  return '';
}

// ── Open / Closed Status ──────────────────────────────────────
function getOpenStatus() {
  const result = { isOpen: null, text: '' };
  const main = document.querySelector('[role="main"]');
  if (!main) return result;

  // Strategy 1: Hours data item
  const ohEl = main.querySelector('[data-item-id="oh"]');
  if (ohEl) {
    const txt = ohEl.textContent.trim();
    result.text = txt;
    if (/\bopen\b/i.test(txt) && !/\bclos/i.test(txt)) result.isOpen = true;
    else if (/\bclos/i.test(txt)) result.isOpen = false;
    return result;
  }

  // Strategy 2: aria-labels with hours
  const ariaEls = main.querySelectorAll('[aria-label]');
  for (const el of ariaEls) {
    const label = (el.getAttribute('aria-label') || '');
    if (/hour|open|close/i.test(label)) {
      result.text = label;
      if (/\bopen\b/i.test(label) && !/\bclos/i.test(label)) result.isOpen = true;
      else if (/\bclos/i.test(label)) result.isOpen = false;
      if (result.isOpen !== null) return result;
    }
  }

  // Strategy 3: Visible open/closed text
  const statusEls = main.querySelectorAll('.o0Svhf, .ZDu9vd, .OqCZI');
  for (const el of statusEls) {
    const txt = el.textContent.trim();
    if (/\bopen\b/i.test(txt)) { result.isOpen = true; result.text = txt; return result; }
    if (/\bclos/i.test(txt)) { result.isOpen = false; result.text = txt; return result; }
  }

  return result;
}

// ── Unanswered Reviews Check ──────────────────────────────────
function getUnansweredReviewInfo() {
  const result = { total: 0, unanswered: 0, hasUnanswered: false };

  // Find individual review containers visible on the business panel
  const reviewContainers = document.querySelectorAll('.jftiEf, [data-review-id]');
  if (!reviewContainers.length) return result;

  const reviews = Array.from(reviewContainers).slice(0, 10);
  result.total = reviews.length;

  for (const rev of reviews) {
    // Check for owner/business response section
    const ownerReply = rev.querySelector('.CDe7pd, [class*="owner"], .d1Xlu');
    let hasReply = !!ownerReply;

    if (!hasReply) {
      const text = rev.innerText || '';
      hasReply = /response from (the )?owner/i.test(text) || /owner.{0,5}(response|replied|reply)/i.test(text);
    }

    if (!hasReply) result.unanswered++;
  }

  result.hasUnanswered = result.unanswered > 0;
  return result;
}

// ── Social Media Extractor ────────────────────────────────────
function getSocialMedia() {
  const socials = {};
  const patterns = [
    { key: 'facebook',  pattern: /facebook\.com/i },
    { key: 'instagram', pattern: /instagram\.com/i },
    { key: 'twitter',   pattern: /(?:twitter\.com|x\.com)/i },
    { key: 'linkedin',  pattern: /linkedin\.com/i },
    { key: 'youtube',   pattern: /youtube\.com/i },
    { key: 'tiktok',    pattern: /tiktok\.com/i },
    { key: 'pinterest', pattern: /pinterest\.com/i },
  ];

  // Scope to the active business panel only — use the most specific
  // container available so we don't bleed links from other panels
  const main = document.querySelector('[role="main"]');
  if (!main) return socials;

  // Prefer the innermost scrollable panel (the detail pane) to avoid
  // picking up links that belong to previously-viewed businesses still
  // lingering in the DOM.
  const detailPane =
    main.querySelector('[aria-label][tabindex="-1"] [data-section-id]')?.closest('[aria-label]') ||
    main.querySelector('.m6QErb[aria-label]') ||
    main;

  const allLinks = detailPane.querySelectorAll('a[href]');
  for (const link of allLinks) {
    const href = unredirect(link.href || '');
    if (!href || href.includes('google.com') || href.includes('goo.gl')) continue;
    for (const { key, pattern } of patterns) {
      if (!socials[key] && pattern.test(href)) socials[key] = cleanSocialUrl(href);
    }
  }

  const ariaEls = detailPane.querySelectorAll('[aria-label]');
  for (const el of ariaEls) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    for (const { key, pattern } of patterns) {
      if (!socials[key] && (label.includes(key) || (key === 'twitter' && label.includes('x.com')))) {
        const a = el.tagName === 'A' ? el : el.querySelector('a[href]');
        if (a) {
          const href = unredirect(a.href || '');
          if (pattern.test(href)) socials[key] = cleanSocialUrl(href);
        }
      }
    }
  }

  return socials;
}

function cleanSocialUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/\/+$/, ''); }
  catch { return url; }
}

// ── Latest Review Date ────────────────────────────────────────
function getLatestReviewDate() {
  const result = { text: '', daysAgo: null };
  const selectors = ['.rsqaWe', '[data-review-id] .rsqaWe', '.jftiEf .rsqaWe'];
  let dateTexts = [];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt && isRelativeDate(txt)) dateTexts.push(txt);
    }
    if (dateTexts.length) break;
  }

  if (!dateTexts.length) {
    const allSpans = document.querySelectorAll('[role="main"] span');
    for (const span of allSpans) {
      const txt = (span.textContent || '').trim().toLowerCase();
      if (isRelativeDate(txt) && !txt.includes('open') && !txt.includes('close')) {
        const parent = span.closest('[data-review-id], .jftiEf, .DU9Pgb, [class*="review"]');
        if (parent) dateTexts.push(txt);
      }
    }
  }

  if (!dateTexts.length) return result;

  let minDays = Infinity, bestText = '';
  for (const txt of dateTexts) {
    const days = parseRelativeDate(txt);
    if (days !== null && days < minDays) { minDays = days; bestText = txt; }
  }
  if (minDays !== Infinity) { result.text = bestText; result.daysAgo = minDays; }
  return result;
}

function isRelativeDate(text) {
  return /\b(second|minute|hour|day|week|month|year)s?\s+ago\b/i.test(text)
      || /\b(a|an|\d+)\s+(second|minute|hour|day|week|month|year)/i.test(text);
}

function parseRelativeDate(text) {
  const t = text.toLowerCase().trim();
  if (/^(a|an)\s+/.test(t)) {
    if (t.includes('second') || t.includes('minute') || t.includes('hour')) return 0;
    if (t.includes('day')) return 1; if (t.includes('week')) return 7;
    if (t.includes('month')) return 30; if (t.includes('year')) return 365;
  }
  const m = t.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (m) {
    const n = parseInt(m[1]), u = m[2];
    if (u === 'second' || u === 'minute' || u === 'hour') return 0;
    if (u === 'day') return n; if (u === 'week') return n * 7;
    if (u === 'month') return n * 30; if (u === 'year') return n * 365;
  }
  return null;
}

// ── Standard Extractors ───────────────────────────────────────
function getAddress() {
  const el = document.querySelector('[data-item-id="address"] .Io6YTe, [data-item-id="address"] .rogA2c');
  if (el) return el.textContent.trim();
  const btn = document.querySelector('button[aria-label*="Address"]');
  if (btn) return btn.getAttribute('aria-label').replace(/^Address:\s*/i, '').trim();
  return '';
}

function getPhone() {
  const tel = document.querySelector('a[href^="tel:"]');
  if (tel) return tel.href.replace('tel:', '').trim();
  const item = document.querySelector('[data-item-id^="phone:tel"] .Io6YTe, [data-item-id^="phone:tel"] .rogA2c');
  if (item) return item.textContent.trim();
  for (const b of document.querySelectorAll('button[aria-label]')) {
    const l = b.getAttribute('aria-label') || '';
    if (/^Phone:/i.test(l)) return l.replace(/^Phone:\s*/i, '').trim();
  }
  return '';
}

function getWebsite() {
  const auth = document.querySelector('[data-item-id="authority"]');
  if (auth) {
    const a = auth.tagName === 'A' ? auth : auth.querySelector('a[href]');
    if (a) { const h = unredirect(a.href); if (isExternal(h)) return h; }
    const label = auth.getAttribute('aria-label') || '';
    const m = label.match(/https?:\/\/[^\s]+/);
    if (m) return m[0];
  }
  for (const el of document.querySelectorAll('[aria-label^="Website"]')) {
    const a = el.tagName === 'A' ? el : el.closest('a') || el.querySelector('a');
    if (a) { const h = unredirect(a.href || ''); if (isExternal(h)) return h; }
    const m = (el.getAttribute('aria-label') || '').match(/https?:\/\/[^\s]+/);
    if (m && isExternal(m[0])) return m[0];
  }
  for (const a of document.querySelectorAll('[role="main"] a[href^="http"]')) {
    const text = (a.innerText || a.textContent || '').toLowerCase().trim();
    if (text === 'website' || text.startsWith('website')) {
      const h = unredirect(a.href); if (isExternal(h)) return h;
    }
  }
  return '';
}

function unredirect(href) {
  if (!href) return '';
  try {
    if (href.includes('google.com/url')) {
      const u = new URL(href);
      return u.searchParams.get('q') || u.searchParams.get('url') || href;
    }
  } catch (e) {}
  return href;
}

function isExternal(href) {
  if (!href || !href.startsWith('http')) return false;
  return !['google.com','goo.gl','maps.app','googleapis.com','googleusercontent.com'].some(d => href.includes(d));
}

// ── Rating Extractor (v7 — multi-strategy) ────────────────────
function getRating() {
  const main = document.querySelector('[role="main"]');
  if (!main) return null;

  // Strategy 1 (Most reliable): aria-label="4.2 stars" or "Rated 4.2 out of 5"
  // Google uses this on the star-rating span accessible to screen readers
  const starEls = main.querySelectorAll('[aria-label*="star" i], [aria-label*="rated" i]');
  for (const el of starEls) {
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(/(\d+(?:[.,]\d+)?)\s*(?:star|out of)/i);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (val >= 1 && val <= 5) return val;
    }
  }

  // Strategy 2: F7nice container — look for numeric text in spans
  const f7 = main.querySelector('div.F7nice');
  if (f7) {
    // The rating number is in a span that doesn't have "review" in its aria-label
    const spans = f7.querySelectorAll('span');
    for (const sp of spans) {
      const txt = (sp.textContent || '').trim();
      const val = parseFloat(txt);
      if (!isNaN(val) && val >= 1 && val <= 5 && /^\d+[.,]\d$/.test(txt)) return val;
    }
    // Fallback: aria-hidden span (original approach)
    const hidden = f7.querySelector('span[aria-hidden="true"]');
    if (hidden) {
      const val = parseFloat(hidden.textContent);
      if (!isNaN(val) && val >= 1 && val <= 5) return val;
    }
  }

  // Strategy 3: span.MW4etd or span.fontDisplayLarge
  for (const sel of ['span.MW4etd', 'span.fontDisplayLarge', 'span[class*="rating"]']) {
    const el = main.querySelector(sel);
    if (el) {
      const val = parseFloat(el.textContent);
      if (!isNaN(val) && val >= 1 && val <= 5) return val;
    }
  }

  // Strategy 4: Scan all spans for a decimal in 1–5 range near a star icon
  const allSpans = main.querySelectorAll('span');
  for (const sp of allSpans) {
    if (sp.children.length > 0) continue; // text-only spans
    const txt = (sp.textContent || '').trim();
    if (/^\d+[.,]\d$/.test(txt)) {
      const val = parseFloat(txt.replace(',', '.'));
      if (val >= 1 && val <= 5) return val;
    }
  }

  return null;
}

// ── Review Count Extractor (v7 — multi-strategy) ──────────────
function getReviews() {
  const main = document.querySelector('[role="main"]');
  if (!main) return 0;

  // Strategy 1 (Most reliable): button[aria-label*="review"]
  // Google wraps "1,543 reviews" in a clickable button you can sort/open
  for (const btn of main.querySelectorAll('button[aria-label]')) {
    const label = btn.getAttribute('aria-label') || '';
    const m = label.match(/([\d,]+)\s+reviews?/i);
    if (m) return parseInt(m[1].replace(/,/g, ''));
  }

  // Strategy 2: Any element with aria-label matching "X reviews"
  for (const el of main.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(/([\d,]+)\s+reviews?/i);
    if (m) return parseInt(m[1].replace(/,/g, ''));
  }

  // Strategy 3: F7nice container — the review count span (UY7F9 or similar)
  const f7 = main.querySelector('div.F7nice');
  if (f7) {
    // Look for parenthesized number like "(1,543)" or "1,543"
    const spans = f7.querySelectorAll('span');
    for (const sp of spans) {
      const txt = (sp.textContent || '').replace(/[()]/g, '').trim();
      const m = txt.match(/^([\d,]+)$/);
      if (m) {
        const val = parseInt(m[1].replace(/,/g, ''));
        if (val > 0) return val;
      }
    }
  }

  // Strategy 4: span.UY7F9 (legacy class — may still be present)
  const legacy = main.querySelector('span.UY7F9');
  if (legacy) {
    const m = (legacy.getAttribute('aria-label') || legacy.textContent).match(/[\d,]+/);
    if (m) return parseInt(m[0].replace(/,/g, ''));
  }

  // Strategy 5: Scan all spans for a bracketed number (review count pattern)
  const reviewPatternEl = [...main.querySelectorAll('span')]
    .find(sp => /^\([\d,]+\)$/.test((sp.textContent || '').trim()));
  if (reviewPatternEl) {
    const val = parseInt(reviewPatternEl.textContent.replace(/[(),]/g, ''));
    if (val > 0) return val;
  }

  return 0;
}

// ── Storage helpers ───────────────────────────────────────────
async function setProgress(pct, label) {
  await chrome.storage.local.set({ scrapeState: { status: 'running', pct, label } });
}

async function appendResult(biz) {
  const record = {
    name: biz.name, address: biz.address, phone: biz.phone, website: biz.website,
    rating: biz.rating, reviewCount: biz.reviewCount, socials: biz.socials || {},
    latestReviewText: biz.latestReviewText || '', latestReviewDays: biz.latestReviewDays,
    noRecentReviews: biz.noRecentReviews, isUnclaimed: biz.isUnclaimed,
    unansweredReviews: biz.unansweredReviews, totalReviewsChecked: biz.totalReviewsChecked,
    hasUnanswered: biz.hasUnanswered, photoCount: biz.photoCount,
    hasLowPhotos: biz.hasLowPhotos, description: biz.description || '',
    hasDescription: biz.hasDescription, openStatusText: biz.openStatusText || '',
    isOpen: biz.isOpen, mapsUrl: biz.mapsUrl, hasWebsite: biz.hasWebsite,
    scrapedAt: biz.scrapedAt,
  };
  const data = await chrome.storage.local.get('scrapeResults');
  const arr = data.scrapeResults || [];
  arr.push(record);
  await chrome.storage.local.set({ scrapeResults: arr });
}

// ── Utils ─────────────────────────────────────────────────────
function waitFor(fn, timeout = 8000, errMsg = 'Timed out') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const r = fn();
      if (r) return resolve(r);
      if (Date.now() - t0 > timeout) return reject(new Error(errMsg));
      setTimeout(tick, 350);
    };
    tick();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

} // end guard
