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
  let manualListening = false;
  let manualListenTimer = null;
  let lastManualUrl = '';

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
    if (msg.type === 'START_MANUAL_LISTEN') {
      startManualListen();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'STOP_MANUAL_LISTEN') {
      stopManualListen();
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

  // ── Extract one business ──────────────────────────────────────
  // Helper: read the business name from a feed list item BEFORE clicking it
  function getItemName(item) {
    // Strategy 1: visible name element inside the card (most precise)
    const nameEl = item.querySelector('.qBF1Pd, .fontHeadlineSmall, [class*="fontHeadline"]');
    if (nameEl) return nameEl.textContent.trim();

    // Strategy 2: aria-label — but it often includes rating/review/category info
    // e.g. "Business Name, 4.5 stars, 100 reviews, Tea house"
    // Take only the first segment before any comma, newline, or bullet.
    const label = (item.getAttribute('aria-label') || '').trim();
    if (label) {
      const firstPart = label.split(/[,\n·•]/)[0].trim();
      return firstPart || label;
    }
    return '';
  }

  async function extractBusiness(item) {

    // ── Step 1: Snapshot current state BEFORE clicking ───────────
    // Must be captured first so the subsequent waitFors can detect
    // when Maps has navigated to the NEW business's panel.
    const prevUrl = window.location.href;
    const prevName = (
      document.querySelector('h1.DUwDvf, h1[class*="fontHeadline"]')?.textContent || ''
    ).trim();
    const expectedName = getItemName(item);

    // ── Staleness fingerprints ────────────────────────────────────
    // Capture the first review card's ID and the photo-count button text
    // from the CURRENT panel so we can detect when Maps has replaced them
    // with the NEW business's content. Review cards and photo counts are
    // lazy-loaded and stay stale in the DOM long after the h1 updates.
    const prevReviewId = document.querySelector('[role="main"] [data-review-id]')
      ?.getAttribute('data-review-id') || '';
    const prevPhotoText = (() => {
      const main = document.querySelector('[role="main"]');
      if (!main) return '';
      for (const btn of main.querySelectorAll('button, a, [role="tab"]')) {
        const t = (btn.textContent || '').trim();
        if (/\d+\s*photos?/i.test(t) || /photos?\s*\(\d+\)/i.test(t) || /all\s*\(\d+\)/i.test(t))
          return t;
      }
      return '';
    })();

    // Click the inner <a> link — Google Maps attaches its navigation listener
    // to the anchor element, NOT to the [role="article"] wrapper. Clicking the
    // wrapper directly does nothing on most Maps versions.
    const clickTarget = item.querySelector('a[href*="/maps/place/"]') || item;
    clickTarget.click();

    // ── Step 2: Wait for the URL to change ───────────────────────
    // This is the clearest signal that Maps has begun navigating
    // the side panel to the new business.
    const urlChanged = await waitFor(
      () => window.location.href !== prevUrl,
      8000
    ).catch(() => false);

    // If URL didn't change (e.g. same place re-clicked), give the DOM a moment
    if (!urlChanged) await sleep(600);

    // ── Step 3: Wait for the h1 to show the NEW business's name ──
    // Require it to differ from the previous h1 to avoid reading stale data.
    const h1El = await waitFor(
      () => {
        const h1 = document.querySelector('h1.DUwDvf, h1[class*="fontHeadline"]');
        if (!h1) return null;
        const txt = h1.textContent.trim();
        if (!txt) return null;

        // Must have changed from the previous panel
        if (txt === prevName) return null;

        // If we know the expected name, verify the h1 matches it.
        // Use bidirectional partial matching: Maps may abbreviate long names
        // or the aria-label segment may differ slightly from the panel h1.
        if (expectedName) {
          const h1Low  = txt.toLowerCase();
          const expLow = expectedName.toLowerCase();
          if (h1Low !== expLow && !h1Low.includes(expLow) && !expLow.includes(h1Low)) return null;
        }

        // Also wait for at least one data-item-id action to be present
        const actions = document.querySelector('[role="main"] [data-item-id]');
        if (!actions) return null;

        return h1;
      },
      10000
    );
    if (!h1El) return null;

    // ── Step 4: Wait for stale review cards + photo count to be replaced ──
    // The h1 updates early, but review cards and photo-count buttons are
    // late-hydrated. We wait until the old fingerprints are gone from the DOM,
    // guaranteeing we read the new business's data — not the previous one's.
    await waitFor(
      () => {
        // Old review card must be gone or replaced with a new ID
        if (prevReviewId) {
          const firstReview = document.querySelector('[role="main"] [data-review-id]');
          if (firstReview && firstReview.getAttribute('data-review-id') === prevReviewId) {
            return null; // old review still in DOM
          }
        }
        // Old photo-count button text must be gone or changed
        if (prevPhotoText) {
          const main = document.querySelector('[role="main"]');
          if (main) {
            for (const btn of main.querySelectorAll('button, a, [role="tab"]')) {
              if ((btn.textContent || '').trim() === prevPhotoText) return null; // old count still visible
            }
          }
        }
        return true;
      },
      6000
    ).catch(() => null); // Non-fatal: new business may genuinely have no reviews or photos

    // ── Step 5: Final render buffer ───────────────────────────────
    // Allow newly-loaded review cards and photo thumbnails to fully paint.
    await sleep(1500);

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
      address: getAddress(),
      phone: getPhone(),
      website,
      rating: getRating(),
      reviewCount: getReviews(),
      socials,
      latestReviewText: reviewInfo.text,
      latestReviewDays: reviewInfo.daysAgo,
      noRecentReviews: reviewInfo.daysAgo === null || reviewInfo.daysAgo > 90,
      isUnclaimed: unclaimed,
      unansweredReviews: unanswered.unanswered,
      totalReviewsChecked: unanswered.total,
      hasUnanswered: unanswered.hasUnanswered,
      photoCount,
      hasLowPhotos: photoCount < 3,
      description,
      hasDescription: description.length > 0,
      openStatusText: openStatus.text,
      isOpen: openStatus.isOpen,
      mapsUrl: window.location.href,
      hasWebsite: !!website,
      scrapedAt: Date.now(),
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
    // Exclude feed list items — they share [role="main"] but are the left sidebar,
    // not the business detail panel we want to read.
    const feed = document.querySelector('[role="feed"]');

    // Strategy 1: Look for "All (X)" or "Photos (X)" or "X photos" in buttons/tabs
    const btns = main.querySelectorAll('button, a, [role="tab"]');
    for (const btn of btns) {
      if (feed && feed.contains(btn)) continue;
      const t = (btn.textContent || '').trim();
      let m = t.match(/(\d+)\s*photos?/i) || t.match(/photos?\s*\((\d+)\)/i) || t.match(/all\s*\((\d+)\)/i);
      if (m) return parseInt(m[1]);
    }

    // Strategy 2: aria-labels
    const ariaEls = main.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      if (feed && feed.contains(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(/(\d+)\s*photos?/i);
      if (m) return parseInt(m[1]);
    }

    // Strategy 3: Count photo thumbnail elements (excluded from feed)
    const thumbs = Array.from(
      main.querySelectorAll('button[aria-label*="photo" i], button[aria-label*="Photo"]')
    ).filter(btn => !feed || !feed.contains(btn));
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
      { key: 'facebook', pattern: /facebook\.com/i },
      { key: 'instagram', pattern: /instagram\.com/i },
      { key: 'twitter', pattern: /(?:twitter\.com|x\.com)/i },
      { key: 'linkedin', pattern: /linkedin\.com/i },
      { key: 'youtube', pattern: /youtube\.com/i },
      { key: 'tiktok', pattern: /tiktok\.com/i },
      { key: 'pinterest', pattern: /pinterest\.com/i },
    ];

    // Scope exclusively to the business detail panel — NOT the feed/list sidebar
    // This prevents picking up social links left over from the previous listing
    const feed = document.querySelector('[role="feed"]');

    const allLinks = document.querySelectorAll('[role="main"] a[href]');
    for (const link of allLinks) {
      // Skip any link that lives inside the feed list (not the detail panel)
      if (feed && feed.contains(link)) continue;

      // Unredirect FIRST — Google wraps social links as google.com/url?q=facebook.com/...
      // The old code blocked google.com hrefs before unredirecting, dropping real social links
      const href = unredirect(link.href || '');

      // After unredirecting, skip if still a Google domain (maps internal link etc.)
      if (!href) continue;
      const isGoogleDomain = /\bgoogle\.com\b|\bgoo\.gl\b|\bgoogleapis\.com\b|\bgoogleusercontent\.com\b/i.test(href);
      if (isGoogleDomain) continue;

      for (const { key, pattern } of patterns) {
        if (!socials[key] && pattern.test(href)) socials[key] = cleanSocialUrl(href);
      }
    }

    // Second pass: aria-label based detection (also scoped away from feed)
    const ariaEls = document.querySelectorAll('[role="main"] [aria-label]');
    for (const el of ariaEls) {
      if (feed && feed.contains(el)) continue;
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
    } catch (e) { }
    return href;
  }

  function isExternal(href) {
    if (!href || !href.startsWith('http')) return false;
    return !['google.com', 'goo.gl', 'maps.app', 'googleapis.com', 'googleusercontent.com'].some(d => href.includes(d));
  }

  // ── Rating Extractor (v8 — scoped, false-positive safe) ──────
  function getRating() {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;

    // Helper: skip elements inside individual review cards OR the feed sidebar.
    // Both live under [role="main"] but only the detail panel contains the
    // business-level rating we want.
    const feed = document.querySelector('[role="feed"]');
    function inReviewCard(el) {
      return !!el.closest('.jftiEf, [data-review-id], .WMbnJf, .DU9Pgb, [role="feed"]');
    }

    // ── Strategy 1: Combined aria-label on one element e.g. "4.2 stars 1,543 reviews"
    // Google sometimes puts this on a single parent div — grab rating from it
    for (const el of main.querySelectorAll('[aria-label]')) {
      if (inReviewCard(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      // Must start with a number like "4.2 stars…"
      const m = label.match(/^(\d+[.,]\d+)\s+stars?/i);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (val >= 1 && val <= 5) return val;
      }
    }

    // ── Strategy 2: Standalone "X stars" aria-label (NOT inside a review card)
    // e.g. <span aria-label="4.2 stars"> wrapping the star icons in the header
    for (const el of main.querySelectorAll('[aria-label]')) {
      if (inReviewCard(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      // Must be ONLY the rating: "4.2 stars" or "Rated 4.2 out of 5"
      const m = label.match(/^(?:rated\s+)?(\d+[.,]\d+)\s*(?:stars?|out of 5)/i);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (val >= 1 && val <= 5) return val;
      }
    }

    // ── Strategy 3: F7nice block — the dedicated Maps rating display container
    // Class name is obfuscated but "F7nice" has been stable for years
    const f7 = main.querySelector('div.F7nice, [class*="F7nice"]');
    if (f7) {
      // aria-hidden="true" span holds the visible number (e.g. "4.2")
      const hiddenSpan = f7.querySelector('span[aria-hidden="true"]');
      if (hiddenSpan) {
        const txt = hiddenSpan.textContent.trim().replace(',', '.');
        if (/^\d+\.\d$/.test(txt)) {
          const val = parseFloat(txt);
          if (val >= 1 && val <= 5) return val;
        }
      }
      // Fallback: any child span that looks like a decimal rating
      for (const sp of f7.querySelectorAll('span')) {
        const txt = (sp.textContent || '').trim().replace(',', '.');
        if (/^\d+\.\d$/.test(txt)) {
          const val = parseFloat(txt);
          if (val >= 1 && val <= 5) return val;
        }
      }
    }

    // ── Strategy 4: Known stable class names from Maps versions
    for (const sel of ['span.MW4etd', 'span.fontDisplayLarge', 'span[class*="fontDisplay"]', 'span[class*="dmRWX"]']) {
      const el = main.querySelector(sel);
      if (el && !inReviewCard(el)) {
        const txt = (el.textContent || '').trim().replace(',', '.');
        if (/^\d+\.\d$/.test(txt)) {
          const val = parseFloat(txt);
          if (val >= 1 && val <= 5) return val;
        }
      }
    }

    // ── Strategy 5: Scan all aria-hidden spans NOT in review cards
    // The visible star rating number is typically aria-hidden since the label is on the parent
    for (const sp of main.querySelectorAll('span[aria-hidden="true"]')) {
      if (inReviewCard(sp)) continue;
      const txt = (sp.textContent || '').trim().replace(',', '.');
      if (/^\d+\.\d$/.test(txt)) {
        const val = parseFloat(txt);
        if (val >= 1 && val <= 5) return val;
      }
    }

    // ── Strategy 6 (last resort): Scan ALL leaf text spans for exact rating format
    // Very broad but safe because /^\d\.\d$/ is specific enough
    for (const sp of main.querySelectorAll('span')) {
      if (sp.children.length > 0) continue; // leaf nodes only
      if (inReviewCard(sp)) continue;
      const txt = (sp.textContent || '').trim().replace(',', '.');
      if (/^\d\.\d$/.test(txt)) { // strict: single digit before decimal, e.g. 4.2
        const val = parseFloat(txt);
        if (val >= 1 && val <= 5) return val;
      }
    }

    return null;
  }

  // ── Review Count Extractor (v8 — scoped, false-positive safe) ─
  function getReviews() {
    const main = document.querySelector('[role="main"]');
    if (!main) return 0;

    // Helper: skip elements inside review cards OR the feed sidebar.
    const feed = document.querySelector('[role="feed"]');
    function inReviewCard(el) {
      return !!el.closest('.jftiEf, [data-review-id], .WMbnJf, .DU9Pgb, [role="feed"]');
    }

    // Helper: does the aria-label smell like a "write a review" / "add review" button?
    function isWriteReviewLabel(label) {
      return /write|add|leave|submit/i.test(label);
    }

    // ── Strategy 1: Combined aria-label "4.2 stars 1,543 reviews" ── most reliable
    for (const el of main.querySelectorAll('[aria-label]')) {
      if (inReviewCard(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      // Pattern: starts with "X.Y stars" then has "N reviews"
      const m = label.match(/^\d+[.,]\d+\s+stars?\s+([\d,]+)\s+reviews?/i);
      if (m) return parseInt(m[1].replace(/,/g, ''));
    }

    // ── Strategy 2: button whose aria-label is "N,NNN reviews" (Maps sort/reviews button)
    for (const btn of main.querySelectorAll('button[aria-label]')) {
      if (inReviewCard(btn)) continue;
      const label = btn.getAttribute('aria-label') || '';
      if (isWriteReviewLabel(label)) continue;
      // Label must look like "1,543 reviews" — starts with digits
      const m = label.match(/^([\d,]+)\s+reviews?$/i);
      if (m) return parseInt(m[1].replace(/,/g, ''));
    }

    // ── Strategy 3: Any non-review-card element with aria-label ending in "reviews"
    for (const el of main.querySelectorAll('[aria-label]')) {
      if (inReviewCard(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      if (isWriteReviewLabel(label)) continue;
      const m = label.match(/([\d,]+)\s+reviews?$/i);
      if (m) {
        const val = parseInt(m[1].replace(/,/g, ''));
        if (val > 0) return val;
      }
    }

    // ── Strategy 4: F7nice block — parenthesized count like "(1,543)"
    const f7 = main.querySelector('div.F7nice, [class*="F7nice"]');
    if (f7) {
      for (const sp of f7.querySelectorAll('span')) {
        const raw = (sp.textContent || '').trim();
        // Match either "(1,543)" or plain "1543"
        const m = raw.match(/^\(([\d,]+)\)$/) || raw.match(/^([\d,]{2,})$/);
        if (m) {
          const val = parseInt(m[1].replace(/,/g, ''));
          if (val > 0) return val;
        }
      }
    }

    // ── Strategy 5: span.UY7F9 legacy
    const legacy = main.querySelector('span.UY7F9');
    if (legacy) {
      const m = (legacy.getAttribute('aria-label') || legacy.textContent).match(/[\d,]+/);
      if (m) return parseInt(m[0].replace(/,/g, ''));
    }

    // ── Strategy 6: Any span containing a parenthesized integer (not in review cards)
    for (const sp of main.querySelectorAll('span')) {
      if (inReviewCard(sp)) continue;
      if (sp.children.length > 0) continue;
      const txt = (sp.textContent || '').trim();
      if (/^\([\d,]+\)$/.test(txt)) {
        const val = parseInt(txt.replace(/[(),]/g, ''));
        if (val > 0) return val;
      }
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

  // ── Manual listen helpers ────────────────────────────────────────────

  function startManualListen() {
    if (manualListening) return;
    manualListening = true;
    lastManualUrl = window.location.href;

    manualListenTimer = setInterval(async () => {
      if (!manualListening) return;
      const url = window.location.href;
      if (url === lastManualUrl) return; // no navigation

      lastManualUrl = url;

      // Only capture when the user lands on a business profile page
      if (!url.includes('/maps/place/')) return;

      try {
        // Wait for the business name h1 to load
        const h1El = await waitFor(
          () => {
            const h1 = document.querySelector('h1.DUwDvf, h1[class*="fontHeadline"]');
            return h1 && h1.textContent.trim() ? h1 : null;
          },
          10000
        );
        if (!h1El) return;

        // Allow data to hydrate fully
        await sleep(2000);

        const name = h1El.textContent.trim();
        if (!name) return;
        if (isPermanentlyClosed()) return;

        // Check dedup keys so the same profile isn't saved twice
        const stored = await chrome.storage.local.get(['dedupKeys', 'scrapeResults']);
        const dedupKeys = new Set(stored.dedupKeys || []);
        const address = getAddress();
        const dedupKey = (name + '|' + address).toLowerCase().trim();
        if (dedupKeys.has(dedupKey)) {
          showSavedToast(name, true); // already saved
          return;
        }

        const socials = getSocialMedia();
        const reviewInfo = getLatestReviewDate();
        const unanswered = getUnansweredReviewInfo();
        const photoCount = getPhotoCount();
        const description = getDescription();
        const openStatus = getOpenStatus();
        const unclaimed = isUnclaimed();
        const website = getWebsite();

        const biz = {
          name,
          address,
          phone: getPhone(),
          website,
          rating: getRating(),
          reviewCount: getReviews(),
          socials,
          latestReviewText: reviewInfo.text,
          latestReviewDays: reviewInfo.daysAgo,
          noRecentReviews: reviewInfo.daysAgo === null || reviewInfo.daysAgo > 90,
          isUnclaimed: unclaimed,
          unansweredReviews: unanswered.unanswered,
          totalReviewsChecked: unanswered.total,
          hasUnanswered: unanswered.hasUnanswered,
          photoCount,
          hasLowPhotos: photoCount < 3,
          description,
          hasDescription: description.length > 0,
          openStatusText: openStatus.text,
          isOpen: openStatus.isOpen,
          mapsUrl: window.location.href,
          hasWebsite: !!website,
          scrapedAt: Date.now(),
          _permanentlyClosed: false,
        };

        // Save dedup key
        dedupKeys.add(dedupKey);
        await chrome.storage.local.set({ dedupKeys: Array.from(dedupKeys) });

        await appendResult(biz);
        showSavedToast(name, false);

      } catch (e) { /* ignore errors silently */ }
    }, 600);
  }

  function stopManualListen() {
    manualListening = false;
    if (manualListenTimer) { clearInterval(manualListenTimer); manualListenTimer = null; }
  }

  function showSavedToast(name, duplicate) {
    const existing = document.getElementById('__gmb_toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = '__gmb_toast';
    const bg = duplicate ? '#F59E0B' : '#10B981';
    const icon = duplicate ? '⚠️' : '✓';
    const msg = duplicate ? `Already saved: ${name}` : `Lead captured: ${name}`;
    toast.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
      `background:${bg}`, 'color:#fff',
      'padding:11px 18px', 'border-radius:10px',
      'font-family:Inter,\'Segoe UI\',sans-serif', 'font-size:13px', 'font-weight:700',
      'box-shadow:0 4px 20px rgba(0,0,0,.28)', 'pointer-events:none',
      'max-width:340px', 'word-break:break-word', 'line-height:1.4',
      'transition:opacity .4s ease',
    ].join(';');
    toast.textContent = `${icon} ${msg.length > 55 ? msg.substring(0, 55) + '…' : msg}`;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 450); }, 2800);
  }

} // end guard

