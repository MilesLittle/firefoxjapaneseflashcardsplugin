function normalizeJapanese(s) {
  if (!s) return "";
  try {
    return String(s).normalize('NFKC').replace(/\u3000/g, '').replace(/\s+/g, '').trim();
  } catch (e) {
    return String(s).trim();
  }
}

function normalizeDefinitionList(glossary) {
  const flat = [];
  const pushGloss = (g) => {
    if (g == null) return;
    if (typeof g === 'string') flat.push(g);
    else if (Array.isArray(g)) g.forEach(pushGloss);
    else if (typeof g === 'object') {
      if (typeof g.glossary === 'string') flat.push(g.glossary);
      else Object.values(g).forEach(pushGloss);
    }
  };
  pushGloss(glossary);
  return flat.filter(Boolean);
}

async function importDictionaryFiles(files) {
  if (!files || files.length === 0) return { ok: false, reason: "no-files" };
  const stored = await browser.storage.local.get("dictionary");
  const dictionary = stored.dictionary || {};
  let totalImportedDefs = 0;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) return { ok: false, reason: "zip-not-handled", file: file.name };
    let text;
    try { text = await file.text(); } catch (err) { continue; }
    let entries;
    try { entries = JSON.parse(text); } catch (err) { continue; }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!Array.isArray(e) || e.length < 1) continue;
      const rawExpression = e[0] ?? "";
      const candidateReading = e[1] ?? "";
      const glossaryCandidates = [e[5], e[4], e[3], e[2]];
      let glossary = null;
      for (const g of glossaryCandidates) { if (g != null) { glossary = g; break; } }
      if (glossary == null) { for (const item of e) { if (item != null && (typeof item === "string" || Array.isArray(item) || typeof item === "object")) { glossary = item; break; } } }
      const expression = normalizeJapanese(String(rawExpression || ""));
      if (!expression) continue;
      const defs = normalizeDefinitionList(glossary);
      if (!dictionary[expression]) { dictionary[expression] = { reading: String(candidateReading || ""), defs: [] }; }
      else if (!dictionary[expression].reading && candidateReading) dictionary[expression].reading = candidateReading;
      if (defs.length > 0) { dictionary[expression].defs.push(...defs); totalImportedDefs += defs.length; }
    }
  }
  for (const k of Object.keys(dictionary)) {
    if (Array.isArray(dictionary[k].defs)) dictionary[k].defs = Array.from(new Set(dictionary[k].defs));
    else if (dictionary[k].defs) dictionary[k].defs = [dictionary[k].defs];
    else dictionary[k].defs = [];
  }
  try { await browser.storage.local.set({ dictionary }); return { ok: true, keys: Object.keys(dictionary).length, importedDefs: totalImportedDefs }; }
  catch (err) { return { ok: false, reason: "storage-save-failed", err: String(err) }; }
}

async function loadFlashcardsToUI() {
  const stored = await browser.storage.local.get(["flashcards"]);
  const flashcards = stored.flashcards || [];
  const listDiv = document.getElementById("flashcard-list");
  if (!listDiv) return;
  listDiv.innerHTML = "";
  if (flashcards.length === 0) { listDiv.innerHTML = "<p>No flashcards yet. Highlight text on a page and choose 'Add to Flashcards', or add one manually below.</p>"; return; }
  flashcards.forEach((card, idx) => {
    const wrapper = document.createElement("div");
    wrapper.className = "flashcard";
    const header = document.createElement("div");
    header.className = "fc-header";
    const termEl = document.createElement("div");
    termEl.className = "fc-term";
    termEl.textContent = card.term || "(no term)";
    const srcEl = document.createElement("div");
    srcEl.className = "fc-source";
    srcEl.textContent = card.source ? `Source: ${card.source}` : "Source: local";
    header.appendChild(termEl);
    header.appendChild(srcEl);
    const readingEl = document.createElement("div");
    readingEl.className = "fc-reading";
    if (card.reading) readingEl.textContent = `Reading: ${card.reading}`;
    const defEl = document.createElement("div");
    defEl.className = "fc-def";
    defEl.textContent = card.definition || "No definition";
    const examplesEl = document.createElement("div");
    examplesEl.className = "fc-examples";
    if (card.examples && card.examples.length) examplesEl.textContent = `Examples: ${card.examples.join(" / ")}`;
    const addExampleBtn = document.createElement("button");
    addExampleBtn.textContent = "Add Example";
    addExampleBtn.addEventListener("click", async () => { const val = prompt("Enter an example sentence containing the term:"); if (!val) return; await addExampleToCard(idx, val); await loadFlashcardsToUI(); });
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => { if (!confirm(`Delete flashcard "${card.term}"?`)) return; await deleteFlashcardAtIndex(idx); await loadFlashcardsToUI(); });
    wrapper.appendChild(header);
    if (card.reading) wrapper.appendChild(readingEl);
    wrapper.appendChild(defEl);
    if (card.examples && card.examples.length) wrapper.appendChild(examplesEl);
    wrapper.appendChild(addExampleBtn);
    wrapper.appendChild(deleteBtn);
    listDiv.appendChild(wrapper);
  });
}

async function deleteFlashcardAtIndex(index) {
  const stored = await browser.storage.local.get("flashcards");
  const flashcards = stored.flashcards || [];
  if (index < 0 || index >= flashcards.length) return;
  flashcards.splice(index, 1);
  await browser.storage.local.set({ flashcards });
}

async function addExampleToCard(index, exampleSentence) {
  const stored = await browser.storage.local.get("flashcards");
  const flashcards = stored.flashcards || [];
  if (index < 0 || index >= flashcards.length) return;
  const card = flashcards[index];
  card.examples = card.examples || [];
  card.examples.push(exampleSentence);
  await browser.storage.local.set({ flashcards });
}

async function manualAddTerm(term) {
  if (!term || !term.trim()) { alert("Please enter a term."); return; }
  const trimmed = term.trim();
  try { await browser.runtime.sendMessage({ action: "saveFlashcard", term: trimmed, examples: [] }); setTimeout(loadFlashcardsToUI, 500); }
  catch (err) { alert("Failed to send save request to background. Check extension console."); }
}

async function inspectDictionary() {
  const d = await browser.storage.local.get("dictionary");
  const dictionary = d.dictionary || {};
  const keys = Object.keys(dictionary);
  if (keys.length > 0) alert(`Dictionary keys: ${keys.length}\nSample key: ${keys[0]}`);
  else alert("No dictionary keys present.");
}

async function printFlashcards() {
  const stored = await browser.storage.local.get("flashcards");
  const flashcards = stored.flashcards || [];
  if (flashcards.length === 0) {
    alert("No flashcards to print.");
    return;
  }

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    alert("Failed to open print window. Check popup settings.");
    return;
  }

  const style = `
    <style>
      body { font-family: sans-serif; margin: 0.25in; }
      .page { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(3, 1fr); gap: 0.25in; page-break-after: always; height: 11in; width: 8.5in; }
      .flashcard { border: 1px solid #000; padding: 10px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; font-size: 14pt; page-break-inside: avoid; }
      .flashcard .term { font-weight: bold; font-size: 18pt; margin-bottom: 8px; }
      .flashcard .reading { font-style: italic; margin-bottom: 8px; }
      .flashcard .definition { font-size: 12pt; }
    </style>
  `;

  const chunks = [];
  for (let i = 0; i < flashcards.length; i += 6) {
    chunks.push(flashcards.slice(i, i + 6));
  }

  let bodyHTML = "";
  chunks.forEach(chunk => {
    bodyHTML += `<div class="page">`;
    chunk.forEach(card => {
      bodyHTML += `<div class="flashcard">
        <div class="term">${card.term}</div>
        ${card.reading ? `<div class="reading">${card.reading}</div>` : ''}
        <div class="definition">${card.definition || ''}</div>
      </div>`;
    });
    bodyHTML += `</div>`;
  });

  printWindow.document.open();
  printWindow.document.write(`<!DOCTYPE html><html><head><title>Print Flashcards</title>${style}</head><body>${bodyHTML}</body></html>`);
  printWindow.document.close();

  printWindow.focus();
  printWindow.print();

  const deleteAll = confirm("Do you want to delete all saved flashcards?");
  if (deleteAll) {
    await browser.storage.local.remove("flashcards");
  }
}


document.addEventListener("DOMContentLoaded", async () => {
  try { await browser.storage.local.get(["dictionary","flashcards"]); } catch (err) {}
  const importInput = document.getElementById("dict-import");
  if (importInput) importInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    importInput.disabled = true;
    importInput.title = "Importing...";
    try {
      const res = await importDictionaryFiles(files);
      if (res.ok) alert(`Imported dictionary. Keys: ${res.keys}, definitions added: ${res.importedDefs}`);
      else if (res.reason === "zip-not-handled") alert("Please extract the Yomitan ZIP and import the term_bank_*.json files inside.");
      else alert("Import failed. See popup console for details.");
    } catch (err) { alert("Import failed; check console."); }
    finally { importInput.disabled = false; importInput.value = ""; importInput.title = ""; await loadFlashcardsToUI(); }
  });
  const addForm = document.getElementById("manual-add-form");
  if (addForm) addForm.addEventListener("submit", async (ev) => { ev.preventDefault(); const input = document.getElementById("manual-term"); if (!input) return; const term = input.value; input.value = ""; await manualAddTerm(term); await loadFlashcardsToUI(); });
  const inspectBtn = document.getElementById("inspect-dict");
  if (inspectBtn) inspectBtn.addEventListener("click", inspectDictionary);
  const printBtn = document.getElementById("print-flashcards");
  if (printBtn) printBtn.addEventListener("click", printFlashcards);
  await loadFlashcardsToUI();
});
