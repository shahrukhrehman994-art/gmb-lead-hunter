// ─────────────────────────────────────────────────────────────
//  GMB Lead Hunter — popup.js  (v6)
//  - Full lead qualification: web design, unclaimed, reputation,
//    optimization, stale reviews
//  - Competitor benchmarking & audit reports
//  - Duplicate tracking, open/closed status
//  - Fixed empty tab bug
// ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
let allResults = [];
let currentFilter = 'all';
let pollTimer = null;
let lastResultCount = 0;
let settings = { showWA: true, showEmail: true, showFB: false };

const SOCIAL_PLATFORMS = {
  facebook: { label: 'Facebook' }, instagram: { label: 'Instagram' },
  twitter: { label: 'X/Twitter' }, linkedin: { label: 'LinkedIn' },
  youtube: { label: 'YouTube' }, tiktok: { label: 'TikTok' },
  pinterest: { label: 'Pinterest' },
};

const FILTERS = {
  all:          { label: 'All',               fn: () => true },
  web_design:   { label: 'Web Design',        fn: b => !b.hasWebsite },
  unclaimed:    { label: 'Unclaimed',          fn: b => b.isUnclaimed },
  reputation:   { label: 'Reputation',         fn: b => b.hasUnanswered },
  optimization: { label: 'Optimization',       fn: b => b.hasLowPhotos || !b.hasDescription },
  stale:        { label: 'Stale Reviews',      fn: b => b.noRecentReviews },
  phone:        { label: 'Has Phone',          fn: b => !!b.phone },
  social:       { label: 'Has Socials',        fn: b => hasSocials(b) },
};

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadFromStorage();
  setupTabs();
  setupChips();
  setupToggles();

  $('searchBtn').addEventListener('click', startSearchWithCountdown);
  $('abortBtn').addEventListener('click', abortSearch);
  $('exportBtn').addEventListener('click', exportCSV);
  $('copyBtn').addEventListener('click', copyCSV);
  $('clearBtn').addEventListener('click', clearAll);
  $('clearDupes').addEventListener('click', clearDupes);

  chrome.storage.onChanged.addListener(handleStorageChange);
});

// ── Tabs ──────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => goTab(t.dataset.tab))
  );
}
function goTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  // Fix: always re-render content when switching to leads/benchmark
  if (name === 'leads') renderLeads();
  if (name === 'benchmark') renderBenchmark();
}

// ── Chips ─────────────────────────────────────────────────────
function setupChips() {
  document.querySelectorAll('.chip').forEach(c =>
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      currentFilter = c.dataset.filter;
      renderLeads();
    })
  );
}

// ── Toggles ───────────────────────────────────────────────────
function setupToggles() {
  ['showWA:togWA', 'showEmail:togEmail', 'showFB:togFB'].forEach(pair => {
    const [key, id] = pair.split(':');
    const btn = $(id);
    btn.classList.toggle('on', settings[key]);
    btn.addEventListener('click', () => {
      settings[key] = !settings[key];
      btn.classList.toggle('on', settings[key]);
      chrome.storage.local.set({ settings });
    });
  });
}

// ── Storage load ──────────────────────────────────────────────
async function loadFromStorage() {
  const data = await chromeGet(['results', 'settings', 'scrapeState']);
  if (data.settings) Object.assign(settings, data.settings);
  if (data.results?.length) {
    allResults = data.results;
    updateStats();
    updateChipCounts();
    renderLeads();
  }
  if (data.scrapeState?.status === 'running') {
    startPolling();
    $('searchBtn').disabled = true;
    $('progressWrap').classList.add('show');
  }
}

// ── Storage change listener ───────────────────────────────────
function handleStorageChange(changes) {
  if (changes.scrapeState) {
    const state = changes.scrapeState.newValue;
    if (state) applyState(state);
  }
  if (changes.scrapeResults) {
    const results = changes.scrapeResults.newValue || [];
    if (results.length > lastResultCount) {
      lastResultCount = results.length;
      allResults = results;
      updateStats();
      updateChipCounts();
      renderLeads();
    }
  }
}

function applyState(state) {
  if (state.status === 'opening' || state.status === 'running') {
    setProgress(true, state.label || '...', state.pct || 0);
    $('searchBtn').disabled = true;
  }
  if (state.status === 'done') {
    stopPolling();
    setProgress(false);
    $('searchBtn').disabled = false;
    chromeGet(['scrapeResults']).then(d => {
      if (d.scrapeResults?.length) {
        allResults = d.scrapeResults;
        chrome.storage.local.set({ results: allResults });
        updateStats();
        updateChipCounts();
        renderLeads();
        goTab('leads');
      }
    });
  }
  if (state.status === 'error') {
    stopPolling(); setProgress(false); $('searchBtn').disabled = false;
    showError(state.message || 'An error occurred.');
  }
  if (state.status === 'idle') {
    stopPolling(); setProgress(false); $('searchBtn').disabled = false;
  }
}

// ── Polling fallback ──────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const data = await chromeGet(['scrapeState', 'scrapeResults']);
    if (data.scrapeState) applyState(data.scrapeState);
    if (data.scrapeResults) {
      const results = data.scrapeResults;
      if (results.length > lastResultCount) {
        lastResultCount = results.length;
        allResults = results;
        updateStats();
        updateChipCounts();
        renderLeads();
      }
    }
  }, 800);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Countdown + Start Search ──────────────────────────────────
async function startSearchWithCountdown() {
  const loc = $('location').value.trim();
  const customCat = $('customCat').value.trim();
  const cat = customCat || $('category').value;
  const limit = parseInt($('limit').value);

  if (!loc) return showError('Enter a location.');
  if (!cat) return showError('Select or type a business category.');
  hideError();
  $('searchBtn').disabled = true;

  const countdownEl = $('countdownOverlay');
  countdownEl.classList.add('show');

  for (let sec = 3; sec >= 1; sec--) {
    $('countdownNumber').textContent = sec;
    $('countdownBar').style.width = ((3 - sec) / 3 * 100) + '%';
    $('countdownLabel').textContent = sec === 3 ? 'Preparing search...' : sec === 2 ? 'Getting ready...' : 'Launching...';
    await new Promise(r => setTimeout(r, 1000));
  }
  $('countdownBar').style.width = '100%';
  $('countdownNumber').textContent = '';
  $('countdownLabel').textContent = 'Starting scrape!';
  await new Promise(r => setTimeout(r, 300));
  countdownEl.classList.remove('show');

  lastResultCount = 0;
  startPolling();

  const delayMs = Math.max(0, parseInt($('delayInput').value) || 0) * 1000;
  chrome.runtime.sendMessage({ type: 'OPEN_MAPS_SEARCH', query: `${cat} in ${loc}`, limit, delayMs });
}

function abortSearch() {
  chrome.runtime.sendMessage({ type: 'ABORT' });
  stopPolling(); setProgress(false); $('searchBtn').disabled = false;
  if (allResults.length) chrome.storage.local.set({ results: allResults });
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats() {
  const t = allResults.length;
  $('statTotal').textContent = t;
  $('statWebDesign').textContent = allResults.filter(b => !b.hasWebsite).length;
  $('statUnclaimed').textContent = allResults.filter(b => b.isUnclaimed).length;
  $('statReputation').textContent = allResults.filter(b => b.hasUnanswered).length;
  $('searchStats').style.display = t > 0 ? 'block' : 'none';
  $('leadCountBadge').textContent = t > 0 ? `(${t})` : '';
}

function updateChipCounts() {
  document.querySelectorAll('.chip[data-filter]').forEach(chip => {
    const key = chip.dataset.filter;
    const f = FILTERS[key];
    if (f) {
      const count = allResults.filter(f.fn).length;
      chip.textContent = `${f.label} (${count})`;
    }
  });
}

function hasSocials(biz) {
  return biz.socials && Object.keys(biz.socials).length > 0;
}

// ── Filtered results ──────────────────────────────────────────
function filteredResults() {
  const f = FILTERS[currentFilter];
  if (!f) return allResults;
  return allResults.filter(f.fn);
}

// ── Render Leads ──────────────────────────────────────────────
function renderLeads() {
  const filtered = filteredResults();

  // No data at all — show the full empty state, hide content
  if (!allResults.length) {
    $('leadsEmpty').style.display = 'flex';
    $('leadsContent').style.display = 'none';
    return;
  }

  // Data exists — always show leadsContent (keeps chip bar visible)
  $('leadsEmpty').style.display = 'none';
  $('leadsContent').style.display = 'block';

  const list = $('bizList');
  list.innerHTML = '';

  if (!filtered.length) {
    // Render inline empty state inside the list so chips remain usable
    const label = FILTERS[currentFilter]?.label || currentFilter;
    list.innerHTML = `<div class="list-empty"><strong>No results</strong>No businesses match the "${label}" filter.<br>Try selecting a different filter above.</div>`;
    $('leadsLabel').textContent = `0 ${label} leads`;
    return;
  }

  updateLeadsLabel();
  filtered.forEach(b => list.appendChild(buildCard(b)));
}

function updateLeadsLabel() {
  const f = filteredResults();
  const label = FILTERS[currentFilter]?.label || 'All';
  $('leadsLabel').textContent = `${f.length} ${label} leads`;
}

// ── Build card ────────────────────────────────────────────────
function buildCard(biz) {
  const card = document.createElement('div');
  card.className = 'biz-card' + (!biz.hasWebsite ? ' lead' : '');
  card.setAttribute('data-testid', 'business-card');

  const waNum = toWA(biz.phone);
  const waHref = waNum ? `https://wa.me/${waNum}` : null;
  const emailQ = encodeURIComponent(`"${biz.name}" ${biz.address.split(',')[0]} email contact`);

  // Collect badges
  const badges = [];
  if (!biz.hasWebsite)     badges.push('<span class="badge badge-lead">NO SITE</span>');
  if (biz.isUnclaimed)     badges.push('<span class="badge badge-unclaimed">UNCLAIMED</span>');
  if (biz.hasUnanswered)   badges.push('<span class="badge badge-reputation">NO REPLIES</span>');
  if (biz.hasLowPhotos)    badges.push('<span class="badge badge-optim">LOW PHOTOS</span>');
  if (!biz.hasDescription) badges.push('<span class="badge badge-optim">NO DESC</span>');
  if (biz.noRecentReviews) badges.push('<span class="badge badge-stale">STALE</span>');

  // Open/closed status
  const statusHTML = biz.openStatusText
    ? `<span class="status-chip ${biz.isOpen === true ? 'status-open' : biz.isOpen === false ? 'status-closed' : 'status-unknown'}">${esc(biz.openStatusText)}</span>`
    : '';

  // Social chips
  const socialHTML = buildSocialHTML(biz.socials);

  // Review info
  let reviewHTML = '';
  if (biz.noRecentReviews) {
    reviewHTML = `<div class="review-stale-row" data-testid="stale-review-badge">${biz.latestReviewText ? `Last review: ${esc(biz.latestReviewText)}` : 'No recent reviews found'}</div>`;
  }
  if (biz.hasUnanswered) {
    reviewHTML += `<div class="review-reputation-row" data-testid="unanswered-badge">${biz.unansweredReviews} of ${biz.totalReviewsChecked} reviews unanswered by owner</div>`;
  }

  // Photo info
  const photoHTML = biz.hasLowPhotos
    ? `<span class="info-tag tag-warn">${biz.photoCount} photos</span>`
    : (biz.photoCount > 0 ? `<span class="info-tag">${biz.photoCount} photos</span>` : '');

  card.innerHTML = `
    <div class="biz-top">
      <div class="biz-name">${esc(biz.name)}</div>
      <div class="badge-row">${badges.join('')}</div>
    </div>
    ${biz.address ? `<div class="biz-addr">${esc(biz.address)}</div>` : ''}
    <div class="biz-meta">
      ${biz.rating ? `<span class="rating">⭐ ${biz.rating}<span> (${biz.reviewCount ? biz.reviewCount.toLocaleString() : '0'} reviews)</span></span>` : ''}
      ${biz.phone ? `<span class="biz-phone">${esc(biz.phone)}</span>` : '<span class="biz-phone dim">No phone listed</span>'}
      ${statusHTML}
      ${photoHTML}
    </div>
    ${reviewHTML}
    ${socialHTML}
    <div class="biz-actions">
      ${waHref && settings.showWA ? `<a href="${waHref}" class="act-btn act-wa" target="_blank" data-testid="whatsapp-btn">WhatsApp</a>` : ''}
      ${settings.showEmail ? `<a href="https://www.google.com/search?q=${emailQ}" class="act-btn act-email" target="_blank" data-testid="find-email-btn">Find Email</a>` : ''}
      <a href="${esc(biz.mapsUrl)}" class="act-btn act-maps" target="_blank" data-testid="maps-btn">Maps</a>
      ${biz.hasWebsite ? `<a href="${esc(biz.website)}" class="act-btn act-site" target="_blank" data-testid="website-btn">Website</a>` : ''}
      <button class="act-btn act-audit" data-testid="audit-btn" onclick="showAudit('${esc(biz.name).replace(/'/g, "\\'")}')">Audit</button>
    </div>
  `;
  return card;
}

function buildSocialHTML(socials) {
  if (!socials || Object.keys(socials).length === 0) {
    return '<div class="social-row empty-socials">No social profiles found</div>';
  }
  const chips = Object.entries(socials).map(([key, url]) => {
    const p = SOCIAL_PLATFORMS[key];
    return p ? `<a href="${esc(url)}" class="social-chip social-${key}" target="_blank" data-testid="social-${key}">${p.label}</a>` : '';
  }).filter(Boolean).join('');
  return `<div class="social-row">${chips}</div>`;
}

// ── Competitor Benchmarking ───────────────────────────────────
function getTop3() {
  if (!allResults.length) return { top3: [], avgRating: 0, avgReviews: 0 };
  const sorted = [...allResults]
    .filter(b => b.rating !== null && b.reviewCount > 0)
    .sort((a, b) => (b.rating * Math.log(b.reviewCount + 1)) - (a.rating * Math.log(a.reviewCount + 1)));
  const top3 = sorted.slice(0, 3);
  const avgRating = top3.length ? (top3.reduce((s, b) => s + (b.rating || 0), 0) / top3.length).toFixed(1) : 0;
  const avgReviews = top3.length ? Math.round(top3.reduce((s, b) => s + (b.reviewCount || 0), 0) / top3.length) : 0;
  return { top3, avgRating: parseFloat(avgRating), avgReviews };
}

function renderBenchmark() {
  const bench = getTop3();
  const container = $('benchContent');

  if (!allResults.length) {
    $('benchEmpty').style.display = 'flex';
    container.style.display = 'none';
    return;
  }

  $('benchEmpty').style.display = 'none';
  container.style.display = 'block';

  // Top 3 summary
  $('avgRating').textContent = bench.avgRating;
  $('avgReviews').textContent = bench.avgReviews;
  $('totalScraped').textContent = allResults.length;

  const top3List = $('top3List');
  top3List.innerHTML = '';
  bench.top3.forEach((b, i) => {
    top3List.innerHTML += `<div class="top3-card">
      <span class="top3-rank">#${i + 1}</span>
      <span class="top3-name">${esc(b.name)}</span>
      <span class="top3-stats">${b.rating} (${b.reviewCount} reviews)</span>
    </div>`;
  });

  // Comparison list
  const compList = $('comparisonList');
  compList.innerHTML = '';
  allResults.forEach(b => {
    const ratingDiff = b.rating ? (b.rating - bench.avgRating).toFixed(1) : 'N/A';
    const reviewDiff = b.reviewCount - bench.avgReviews;
    const rClass = parseFloat(ratingDiff) >= 0 ? 'comp-good' : 'comp-bad';
    const rvClass = reviewDiff >= 0 ? 'comp-good' : 'comp-bad';
    const issues = [];
    if (!b.hasWebsite) issues.push('No website');
    if (b.isUnclaimed) issues.push('Unclaimed');
    if (b.hasUnanswered) issues.push('No replies');
    if (b.hasLowPhotos) issues.push('Low photos');
    if (!b.hasDescription) issues.push('No description');
    if (b.noRecentReviews) issues.push('Stale reviews');

    compList.innerHTML += `<div class="comp-card">
      <div class="comp-name">${esc(b.name)}</div>
      <div class="comp-stats">
        Rating: <span class="${rClass}">${b.rating || 'N/A'} (${ratingDiff >= 0 ? '+' : ''}${ratingDiff} vs Top 3)</span>
        &nbsp; Reviews: <span class="${rvClass}">${b.reviewCount} (${reviewDiff >= 0 ? '+' : ''}${reviewDiff} vs ${bench.avgReviews} avg)</span>
      </div>
      ${issues.length ? `<div class="comp-issues">${issues.join(' / ')}</div>` : ''}
    </div>`;
  });
}

// ── Audit Report ──────────────────────────────────────────────
// Expose globally for inline onclick
window.showAudit = function(name) {
  const biz = allResults.find(b => b.name === name);
  if (!biz) return;
  const bench = getTop3();
  const modal = $('auditModal');
  const content = $('auditBody');

  const issues = [];
  if (!biz.hasWebsite)     issues.push({ label: 'No Website', desc: 'This business has no website. Opportunity: Web design services.' });
  if (biz.isUnclaimed)     issues.push({ label: 'Unclaimed Profile', desc: 'Google Business profile is unclaimed. Opportunity: Profile verification service.' });
  if (biz.hasLowPhotos)    issues.push({ label: `Low Photos (${biz.photoCount})`, desc: 'Less than 3 photos. Businesses with 10+ photos get 35% more clicks.' });
  if (!biz.hasDescription) issues.push({ label: 'No Description', desc: 'Missing About/Editorial description. Reduces search visibility.' });
  if (biz.noRecentReviews) issues.push({ label: 'Stale Reviews', desc: `${biz.latestReviewText ? 'Last review: ' + biz.latestReviewText : 'No recent reviews found'}. Fresh reviews boost rankings.` });
  if (biz.hasUnanswered)   issues.push({ label: 'Unanswered Reviews', desc: `${biz.unansweredReviews} of ${biz.totalReviewsChecked} reviews have no owner reply. Responding to reviews increases trust.` });

  const ratingComp = biz.rating
    ? `${biz.rating}/5 (${biz.reviewCount} reviews) vs Top 3 Avg: ${bench.avgRating}/5 (${bench.avgReviews} reviews)`
    : 'No rating data';

  const issueHTML = issues.length
    ? issues.map(i => `<div class="audit-issue"><div class="audit-issue-label">${esc(i.label)}</div><div class="audit-issue-desc">${esc(i.desc)}</div></div>`).join('')
    : '<div class="audit-ok">No major issues found.</div>';

  const socialList = biz.socials && Object.keys(biz.socials).length
    ? Object.entries(biz.socials).map(([k, v]) => `${SOCIAL_PLATFORMS[k]?.label || k}: ${v}`).join('\n')
    : 'None found';

  content.innerHTML = `
    <div class="audit-header">${esc(biz.name)}</div>
    <div class="audit-meta">${esc(biz.address)} ${biz.openStatusText ? ' | ' + esc(biz.openStatusText) : ''}</div>
    <div class="audit-section">
      <div class="audit-section-title">Performance vs Competitors</div>
      <div class="audit-comparison">${ratingComp}</div>
    </div>
    <div class="audit-section">
      <div class="audit-section-title">Issues Found (${issues.length})</div>
      ${issueHTML}
    </div>
    <div class="audit-section">
      <div class="audit-section-title">Social Profiles</div>
      <div class="audit-social">${esc(socialList).replace(/\n/g, '<br>')}</div>
    </div>
    <button class="btn btn-primary" style="margin-top:12px;" onclick="downloadAudit('${esc(biz.name).replace(/'/g, "\\'")}')">Download Audit Report</button>
  `;
  modal.classList.add('show');
};

window.closeAudit = function() {
  $('auditModal').classList.remove('show');
};

window.downloadAudit = function(name) {
  const biz = allResults.find(b => b.name === name);
  if (!biz) return;
  const bench = getTop3();
  const lines = [
    `=== AUDIT REPORT: ${biz.name} ===`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `Location: ${biz.address}`,
    `Phone: ${biz.phone || 'N/A'}`,
    `Website: ${biz.website || 'None'}`,
    `Status: ${biz.openStatusText || 'Unknown'}`,
    `Rating: ${biz.rating || 'N/A'}/5 (${biz.reviewCount} reviews)`,
    `Photos: ${biz.photoCount}`,
    ``,
    `--- COMPETITOR BENCHMARK ---`,
    `Top 3 Avg Rating: ${bench.avgRating}/5`,
    `Top 3 Avg Reviews: ${bench.avgReviews}`,
    `Your Rating Gap: ${biz.rating ? (biz.rating - bench.avgRating).toFixed(1) : 'N/A'}`,
    `Your Review Gap: ${biz.reviewCount - bench.avgReviews}`,
    ``,
    `--- ISSUES ---`,
  ];
  if (!biz.hasWebsite) lines.push(`[!] No Website - Web design opportunity`);
  if (biz.isUnclaimed) lines.push(`[!] Unclaimed Profile - Verification service opportunity`);
  if (biz.hasLowPhotos) lines.push(`[!] Low Photos (${biz.photoCount}) - Needs 10+ photos`);
  if (!biz.hasDescription) lines.push(`[!] No Description - Missing about/editorial text`);
  if (biz.noRecentReviews) lines.push(`[!] Stale Reviews - Last: ${biz.latestReviewText || 'Unknown'}`);
  if (biz.hasUnanswered) lines.push(`[!] Unanswered Reviews - ${biz.unansweredReviews}/${biz.totalReviewsChecked} unanswered`);
  if (!lines.some(l => l.startsWith('[!]'))) lines.push(`No major issues found.`);
  lines.push('', `--- SOCIAL PROFILES ---`);
  if (biz.socials && Object.keys(biz.socials).length) {
    Object.entries(biz.socials).forEach(([k, v]) => lines.push(`${SOCIAL_PLATFORMS[k]?.label || k}: ${v}`));
  } else { lines.push('None found'); }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `audit-${biz.name.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.txt`
  });
  a.click();
};

// ── WhatsApp ──────────────────────────────────────────────────
function toWA(phone) {
  if (!phone) return null;
  let n = phone.replace(/[\s\-().+]/g, '');
  if (n.startsWith('0') && n.length === 11) n = '92' + n.slice(1);
  n = n.replace(/\D/g, '');
  return n.length >= 7 ? n : null;
}

// ── CSV ───────────────────────────────────────────────────────
function buildCSV() {
  const socialKeys = ['facebook','instagram','twitter','linkedin','youtube','tiktok','pinterest'];
  const headers = [
    'Name','Address','Phone','WhatsApp','Website','Rating','Reviews',
    'Open Status','Unclaimed','Photos','Has Description','Latest Review',
    'Stale Reviews','Unanswered Reviews','Total Checked',
    'Maps URL', ...socialKeys.map(k => SOCIAL_PLATFORMS[k]?.label || k)
  ];
  const rows = [headers];

  filteredResults().forEach(b => {
    const wa = toWA(b.phone);
    const socialValues = socialKeys.map(k => (b.socials && b.socials[k]) || '');
    rows.push([
      b.name, b.address, b.phone, wa ? `https://wa.me/${wa}` : '',
      b.website || '', b.rating || '', b.reviewCount || '',
      b.openStatusText || '', b.isUnclaimed ? 'YES' : 'NO',
      b.photoCount, b.hasDescription ? 'YES' : 'NO',
      b.latestReviewText || '', b.noRecentReviews ? 'YES' : 'NO',
      b.unansweredReviews || 0, b.totalReviewsChecked || 0,
      b.mapsUrl, ...socialValues
    ]);
  });
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
}

function exportCSV() {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([buildCSV()], { type: 'text/csv' })),
    download: `leads-${Date.now()}.csv`
  });
  a.click();
}

function copyCSV() {
  navigator.clipboard.writeText(buildCSV()).then(() => {
    $('copyBtn').textContent = 'Copied!';
    setTimeout(() => $('copyBtn').textContent = 'Copy CSV', 2000);
  });
}

function clearAll() {
  allResults = []; lastResultCount = 0;
  chrome.storage.local.remove(['results','scrapeResults','scrapeState']);
  $('bizList').innerHTML = '';
  $('leadsEmpty').style.display = 'flex';
  $('leadsContent').style.display = 'none';
  updateStats();
  updateChipCounts();
}

function clearDupes() {
  chrome.storage.local.remove(['dedupKeys']);
  $('clearDupes').textContent = 'Cleared!';
  setTimeout(() => $('clearDupes').textContent = 'Reset Dedup', 2000);
}

// ── UI helpers ────────────────────────────────────────────────
function setProgress(show, label = '', pct = 0) {
  $('progressWrap').classList.toggle('show', show);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = pct + '%';
  $('progressBar').style.width = pct + '%';
}
function showError(msg) { $('errorBox').textContent = msg; $('errorBox').classList.add('show'); }
function hideError()    { $('errorBox').classList.remove('show'); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function chromeGet(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
