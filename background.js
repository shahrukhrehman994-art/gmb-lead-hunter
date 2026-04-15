// GMB Lead Hunter — background.js (v4)

let mapsTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_MAPS_SEARCH') {
    openMapsAndScrape(msg.query, msg.limit, msg.delayMs || 0);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'ABORT') {
    if (mapsTabId) chrome.tabs.sendMessage(mapsTabId, { type: 'ABORT_SCRAPE' }).catch(() => {});
    chrome.storage.local.set({ scrapeState: { status: 'idle' } });
    sendResponse({ ok: true });
    return;
  }
});

async function openMapsAndScrape(query, limit, delayMs) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}/`;

  await chrome.storage.local.set({
    scrapeState: { status: 'opening', pct: 0, label: 'Opening Google Maps…' },
    scrapeResults: [],
  });

  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/maps/*' });
  if (tabs.length > 0) {
    mapsTabId = tabs[0].id;
    await chrome.tabs.update(mapsTabId, { url, active: true });
  } else {
    const tab = await chrome.tabs.create({ url, active: true });
    mapsTabId = tab.id;
  }

  await waitForTabLoad(mapsTabId);
  await sleep(3500);

  try {
    await chrome.scripting.executeScript({ target: { tabId: mapsTabId }, files: ['content.js'] });
  } catch (e) { /* already injected — guard handles it */ }

  await sleep(600);

  try {
    const pong = await sendTabMsg(mapsTabId, { type: 'PING' });
    if (!pong?.ok) throw new Error('no pong');
  } catch (e) {
    await chrome.storage.local.set({
      scrapeState: { status: 'error', message: 'Could not connect to Maps tab. Please try again.' },
    });
    return;
  }

  try {
    await sendTabMsg(mapsTabId, { type: 'START_SCRAPE', limit, delayMs });
  } catch (e) {
    await chrome.storage.local.set({ scrapeState: { status: 'error', message: e.message } });
  }
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (tab && tab.status === 'complete') return resolve();
      const h = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(h);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(h);
    });
  });
}

function sendTabMsg(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
