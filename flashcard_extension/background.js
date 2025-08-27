

// --- CONFIG ---
const JISHO_API_BASE = "https://jisho.org/api/v1/search/words?keyword=";
const JISHO_CACHE_KEY = "jisho_cache"; // in browser.storage.local
const JISHO_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days for cached entries

const pendingLookupPromises = new Map();

try {
  browser.contextMenus.create({
    id: "add-to-flashcards",
    title: "Add to Flashcards",
    contexts: ["selection"]
  });
} catch (e) {
  console.warn("context menu may already exist:", e);
}

function normalizeJapanese(s) {
  if (!s) return "";
  return String(s).normalize('NFKC').replace(/\u3000/g,'').replace(/\s+/g,'').trim();
}

async function getLocalDictionary() {
  const store = await browser.storage.local.get("dictionary");
  return store.dictionary || {};
}

async function getJishoCache() {
  const store = await browser.storage.local.get(JISHO_CACHE_KEY);
  return store[JISHO_CACHE_KEY] || {};
}

async function setJishoCache(cache) {
  const obj = {};
  obj[JISHO_CACHE_KEY] = cache;
  await browser.storage.local.set(obj);
}

function parseJishoData(data) {
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0];
  const japanese = Array.isArray(first.japanese) ? first.japanese[0] || {} : {};
  const senses = Array.isArray(first.senses) ? first.senses : [];

  const word = japanese.word || "";      
  const reading = japanese.reading || "";

  const defs = senses.flatMap(s => (s.english_definitions || [])).filter(Boolean);
  const defText = defs.length ? Array.from(new Set(defs)).join(" ; ") : null;

  return {
    word,
    reading,
    definition: defText,
    raw: first
  };
}


async function fetchFromJisho(term) {
  const normalized = normalizeJapanese(term);
  if (!normalized) return null;

  const cache = await getJishoCache();
  const cached = cache[normalized];
  if (cached && (Date.now() - (cached._ts || 0) < JISHO_CACHE_TTL_MS)) {

    return { fromCache: true, ...cached };
  }


  if (pendingLookupPromises.has(normalized)) {
    return pendingLookupPromises.get(normalized);
  }

  const promise = (async () => {
    try {
      const url = JISHO_API_BASE + encodeURIComponent(normalized);
      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) {
        console.warn("Jisho API returned non-ok:", resp.status, resp.statusText);
        return null;
      }
      const json = await resp.json();
      const parsed = parseJishoData(json.data);
      if (!parsed) return null;

  
      const toStore = {
        ...parsed,
        _ts: Date.now()
      };
      cache[normalized] = toStore;
      try {
        await setJishoCache(cache);
      } catch (err) {
        console.error("Failed to save Jisho cache:", err);
      }

      return { fromCache: false, ...toStore };
    } catch (err) {
      console.error("Jisho fetch error:", err);
      return null;
    } finally {
      pendingLookupPromises.delete(normalized);
    }
  })();

  pendingLookupPromises.set(normalized, promise);
  return promise;
}

async function lookupDefinition(rawTerm) {
  if (!rawTerm) return null;
  const term = normalizeJapanese(rawTerm);
  if (!term) return null;


  const dictionary = await getLocalDictionary();
  if (dictionary && dictionary[term] && Array.isArray(dictionary[term].defs) && dictionary[term].defs.length) {
    return {
      source: "local",
      foundFor: term,
      reading: dictionary[term].reading || "",
      definition: dictionary[term].defs.join(" ; ")
    };
  }


  if (term.endsWith("する")) {
    const base = term.slice(0, -2);
    if (dictionary && dictionary[base] && Array.isArray(dictionary[base].defs) && dictionary[base].defs.length) {
      return {
        source: "local",
        foundFor: base,
        reading: dictionary[base].reading || "",
        definition: dictionary[base].defs.join(" ; ")
      };
    }
  }


  const keys = Object.keys(dictionary || {});
  if (keys.length) {

    keys.sort((a,b) => b.length - a.length);
    for (const k of keys) {
      if (k.length < 2) continue;
      if (term.startsWith(k) && Array.isArray(dictionary[k].defs) && dictionary[k].defs.length) {
        return {
          source: "local",
          foundFor: k,
          reading: dictionary[k].reading || "",
          definition: dictionary[k].defs.join(" ; ")
        };
      }
    }
  }


  const jishoResult = await fetchFromJisho(term);
  if (jishoResult && jishoResult.definition) {
    return {
      source: "jisho",
      foundFor: jishoResult.word || term,
      reading: jishoResult.reading || "",
      definition: jishoResult.definition
    };
  }


  return null;
}

async function saveFlashcard(entry) {
  if (!entry || !entry.term) return;

  const match = await lookupDefinition(entry.term);
  if (match) {
    entry.definition = match.definition;
    entry.reading = entry.reading || match.reading || "";
    entry.source = match.source || "unknown";
    entry.foundFor = match.foundFor || entry.term;
  } else {
    entry.definition = entry.definition || "No definition found";
    entry.source = "none";
  }

  const stored = await browser.storage.local.get("flashcards");
  const flashcards = stored.flashcards || [];
  flashcards.push(entry);
  await browser.storage.local.set({ flashcards });


  try {
    browser.notifications.create({
      "type": "basic",
      "iconUrl": browser.runtime.getURL("icons/icon-48.png"),
      "title": "Flashcard saved",
      "message": `${entry.term} — ${entry.definition ? entry.definition.slice(0,120) : ""}`
    });
  } catch (e) {

  }

  console.log("Saved flashcard:", entry);
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "add-to-flashcards") return;
  const selection = info.selectionText;
  if (!selection) return;
  const term = String(selection).trim();
  await saveFlashcard({ term, examples: [] });
});

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || !msg.action) return;
  if (msg.action === "saveFlashcard" && msg.term) {
    await saveFlashcard({ term: msg.term, examples: msg.examples || [] });
    return { ok: true };
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "openPrintTab") {
    browser.tabs.create({ url: browser.runtime.getURL("print.html") });
  }
});

