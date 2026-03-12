import { useState, useRef } from "react";
import "./RestaurantScraper.css";

const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "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";

const PROXIES = [
  { url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json: true },
  { url: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`, json: false },
  { url: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, json: false },
  { url: (u) => `https://thingproxy.freeboard.io/fetch/${u}`, json: false },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "  ")
    .trim()
    .slice(0, 15000);
}

async function fetchWithFallback(url, addLog) {
  for (let i = 0; i < PROXIES.length; i++) {
    const proxy = PROXIES[i];
    try {
      const proxyUrl = proxy.url(url);
      addLog(`Trying proxy ${i + 1}/${PROXIES.length}…`);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let html;
      if (proxy.json) {
        const data = await res.json();
        html = data.contents || data.body || (typeof data === "string" ? data : "");
      } else {
        html = await res.text();
      }
      const text = stripHtml(html);
      if (text.length > 200) return text;
      throw new Error("Too little content returned");
    } catch (e) {
      addLog(`Proxy ${i + 1} failed: ${e.message}`, "warn");
    }
  }
  throw new Error("All proxies failed. Use Paste tab instead — copy the full page (Ctrl+A → Ctrl+C) and paste it.");
}

async function callClaude(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: `You are a powerful data extraction engine. Extract EVERY business/restaurant/hotel/company you can find in the text.
Be aggressive — extract anything that looks like a business listing. Even if contact info is partial, still include it.
Return ONLY a raw JSON array with no markdown, no explanation, no code blocks.
Each item must have these exact fields:
[{
  "name": "business name (required, never empty)",
  "email": "email address or empty string",
  "phone": "phone number or empty string",
  "website": "website URL or empty string",
  "location": "address, city, area, or country — any location info found",
  "category": "type of business e.g. Restaurant, Hotel, Cafe, Bar",
  "rating": "rating score if found e.g. 4.5 or empty string",
  "cuisine": "cuisine type if applicable or empty string",
  "source": "where this data came from"
}]
Rules:
- Include EVERY business even if email is missing
- Never return an empty array if any business names are visible
- Extract phone numbers in any format
- If multiple emails/phones found for same business, pick the most likely contact one
- Return [] only if there are absolutely zero business names in the text`,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const raw = data.content?.[0]?.text || "[]";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

function initials(name) {
  if (!name) return "?";
  return name.split(" ").slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function dedupeKey(item) {
  return item.email?.toLowerCase() || item.name?.toLowerCase() || Math.random().toString();
}

const COLS = [
  { key: "name",     label: "Name",     width: "200px" },
  { key: "email",    label: "Email",    width: "200px" },
  { key: "phone",    label: "Phone",    width: "140px" },
  { key: "location", label: "Location", width: "160px" },
  { key: "category", label: "Category", width: "110px" },
  { key: "rating",   label: "Rating",   width: "80px"  },
  { key: "cuisine",  label: "Cuisine",  width: "110px" },
  { key: "website",  label: "Website",  width: "160px" },
];

export default function OmnaScrapper() {
  const [activeTab, setActiveTab] = useState("paste");
  const [viewMode, setViewMode]   = useState("table"); // "table" | "cards"
  const [pasteText, setPasteText] = useState("");
  const [urlInput, setUrlInput]   = useState("");
  const [results, setResults]     = useState([]);
  const [logs, setLogs]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [search, setSearch]       = useState("");
  const logRef = useRef(null);

  function addLog(msg, type = "info") {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLogs((prev) => [...prev, { ts, msg, type }]);
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  }

  function mergeResults(newItems, source) {
    let added = 0;
    setResults((prev) => {
      const seen = new Set(prev.map(dedupeKey));
      const toAdd = [];
      for (const item of newItems) {
        const key = dedupeKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        toAdd.push({ ...item, source: item.source || source, id: `${Date.now()}-${Math.random()}` });
        added++;
      }
      return [...prev, ...toAdd];
    });
    return added;
  }

  async function handlePasteExtract() {
    if (!pasteText.trim()) return addLog("Nothing pasted yet.", "error");
    if (!ANTHROPIC_KEY) return addLog("VITE_ANTHROPIC_KEY missing in .env.local", "error");
    setLoading(true);
    addLog(`Processing ${pasteText.length.toLocaleString()} characters…`);
    try {
      const chunks = chunkText(pasteText, 14000);
      addLog(`Sending ${chunks.length} chunk(s) to Claude AI…`);
      let allItems = [];
      for (let i = 0; i < chunks.length; i++) {
        addLog(`Analysing chunk ${i + 1}/${chunks.length}…`);
        const items = await callClaude(chunks[i]);
        allItems = [...allItems, ...items];
      }
      const added = mergeResults(allItems, "paste");
      addLog(`✓ Extracted ${allItems.length} record(s) — ${added} new added.`, "success");
    } catch (e) {
      addLog(e.message, "error");
    }
    setLoading(false);
  }

  async function handleUrlFetch() {
    if (!urlInput.trim()) return addLog("Enter a URL first.", "error");
    if (!ANTHROPIC_KEY) return addLog("VITE_ANTHROPIC_KEY missing in .env.local", "error");
    setLoading(true);
    const normalizedUrl = urlInput.trim().match(/^https?:\/\//) ? urlInput.trim() : `https://${urlInput.trim()}`;
    addLog(`Fetching: ${normalizedUrl}`);
    try {
      const text = await fetchWithFallback(normalizedUrl, addLog);
      addLog(`Fetched ${text.length.toLocaleString()} chars. Sending to Claude AI…`);
      const items = await callClaude(text);
      const added = mergeResults(items, normalizedUrl);
      addLog(`✓ Extracted ${items.length} record(s) — ${added} new added.`, "success");
    } catch (e) {
      addLog(e.message, "error");
    }
    setLoading(false);
  }

  function chunkText(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    return chunks;
  }

  function exportCsv() {
    if (!results.length) return;
    const header = COLS.map((c) => c.label).join(",") + ",Source";
    const rows = filtered.map((r) =>
      [...COLS.map((c) => r[c.key] || ""), r.source || ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `omna-scrapper-${Date.now()}.csv`;
    a.click();
    addLog(`Exported ${rows.length} record(s) to CSV.`, "success");
  }

  const filtered = results.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return Object.values(r).some((v) => String(v).toLowerCase().includes(q));
  });

  const totalEmails  = results.filter((r) => r.email).length;
  const totalPhones  = results.filter((r) => r.phone).length;
  const totalWithBoth = results.filter((r) => r.email && r.phone).length;

  return (
    <div className="omna-app">

      {/* ── Navbar ── */}
      <nav className="omna-nav">
        <div className="omna-logo">
          <div className="omna-logo-mark">OS</div>
          <div>
            <div className="omna-logo-text">OMNA Scrapper</div>
            <div className="omna-logo-sub">AI-Powered Business Intelligence · Dubai</div>
          </div>
        </div>
        <div className="omna-nav-right">
          <div className="omna-nav-badge">
            <div className="omna-nav-dot" />
            Claude Sonnet 4 · Live
          </div>
        </div>
      </nav>

      <main className="omna-main">

        {/* ── Stats ── */}
        <div className="omna-stats">
          {[
            { icon: "🏢", num: results.length,  label: "Total Records",   cls: "blue"   },
            { icon: "✉️", num: totalEmails,      label: "Emails Found",   cls: "green"  },
            { icon: "📞", num: totalPhones,      label: "Phones Found",   cls: "purple" },
            { icon: "⚡", num: totalWithBoth,    label: "Full Contacts",  cls: "gold"   },
          ].map((s) => (
            <div className="omna-stat-card" key={s.label}>
              <div className={`omna-stat-icon ${s.cls}`}>{s.icon}</div>
              <div>
                <div className="omna-stat-num">{s.num}</div>
                <div className="omna-stat-label">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Input Panel ── */}
        <div className="omna-panel omna-input-panel">
          <div className="omna-panel-header">
            <div className="omna-panel-title"><span>⚡</span> Data Extraction</div>
          </div>
          <div className="omna-panel-body omna-input-body">
            <div className="omna-tabs">
              <button className={`omna-tab${activeTab === "paste" ? " active" : ""}`} onClick={() => setActiveTab("paste")}>
                📋 Paste Content
              </button>
              <button className={`omna-tab${activeTab === "url" ? " active" : ""}`} onClick={() => setActiveTab("url")}>
                🔗 Fetch URL
              </button>
            </div>

            {activeTab === "paste" ? (
              <div className="omna-paste-row">
                <div className="omna-paste-hint">
                  <span className="omna-hint-step">1</span> Open any page (Zomato, TripAdvisor, Google Maps)
                  <span className="omna-hint-step">2</span> Press <kbd>Ctrl+A</kbd> then <kbd>Ctrl+C</kbd>
                  <span className="omna-hint-step">3</span> Paste below and click Extract
                </div>
                <textarea
                  className="omna-textarea omna-textarea-wide"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Paste the full copied page content here — the more text, the better the results…"
                  spellCheck={false}
                />
                <div className="omna-action-row">
                  <span className="omna-char-count">{pasteText.length.toLocaleString()} chars</span>
                  <button className="omna-btn omna-btn-primary" onClick={handlePasteExtract} disabled={loading}>
                    {loading ? <><span className="omna-spinner" /> Extracting…</> : "⚡ Extract All Data"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="omna-paste-row">
                <div className="omna-paste-hint">
                  <span className="omna-hint-step">!</span> Note: Many sites (TripAdvisor, Zomato) block automated fetching. If this fails, use the Paste tab.
                </div>
                <div className="omna-input-wrap">
                  <input
                    className="omna-input"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://www.zomato.com/dubai/best-restaurants"
                    onKeyDown={(e) => e.key === "Enter" && !loading && handleUrlFetch()}
                  />
                  <button className="omna-btn omna-btn-primary" onClick={handleUrlFetch} disabled={loading}>
                    {loading ? <><span className="omna-spinner" /> Fetching…</> : "Fetch & Extract"}
                  </button>
                </div>
              </div>
            )}

            <div className="omna-log-wrap">
              <div className="omna-log-label">Activity Log</div>
              <div className="omna-log" ref={logRef}>
                {logs.length === 0
                  ? <span className="omna-log-empty">Waiting for input…</span>
                  : logs.map((l, i) => (
                    <div key={i} className="omna-log-line">
                      <span className="omna-log-ts">[{l.ts}]</span>
                      <span className={`omna-log-msg ${l.type || "info"}`}>{l.msg}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        </div>

        {/* ── Results Panel ── */}
        <div className="omna-panel">
          <div className="omna-panel-header">
            <div className="omna-panel-title"><span>📊</span> Results</div>
            <div className="omna-panel-header-right">
              <input
                className="omna-search"
                placeholder="Search results…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="omna-view-toggle">
                <button className={`omna-view-btn${viewMode === "table" ? " active" : ""}`} onClick={() => setViewMode("table")}>⊞ Table</button>
                <button className={`omna-view-btn${viewMode === "cards" ? " active" : ""}`} onClick={() => setViewMode("cards")}>▤ Cards</button>
              </div>
              {results.length > 0 && (
                <button className="omna-btn omna-btn-ghost-red omna-btn-sm" onClick={() => setResults([])}>Clear</button>
              )}
              <button className="omna-btn omna-btn-success omna-btn-sm" onClick={exportCsv} disabled={!results.length}>
                ↓ Export CSV
              </button>
            </div>
          </div>

          <div className="omna-panel-body omna-results-body">
            {results.length === 0 ? (
              <div className="omna-empty">
                <div className="omna-empty-icon">🔍</div>
                <div>No data yet</div>
                <div className="omna-empty-sub">Paste page content or fetch a URL to extract business data</div>
              </div>
            ) : viewMode === "table" ? (
              <div className="omna-table-wrap">
                <table className="omna-table">
                  <thead>
                    <tr>
                      <th style={{ width: "40px" }}>#</th>
                      {COLS.map((c) => <th key={c.key} style={{ minWidth: c.width }}>{c.label}</th>)}
                      <th style={{ width: "50px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, idx) => (
                      <tr key={r.id} className="omna-tr">
                        <td className="omna-td-num">{idx + 1}</td>
                        <td className="omna-td-name">
                          <div className="omna-td-avatar">{initials(r.name)}</div>
                          <span>{r.name || "—"}</span>
                        </td>
                        <td>
                          {r.email
                            ? <span className="omna-td-email">{r.email}</span>
                            : <span className="omna-td-empty">—</span>}
                        </td>
                        <td>{r.phone || <span className="omna-td-empty">—</span>}</td>
                        <td>{r.location || <span className="omna-td-empty">—</span>}</td>
                        <td>
                          {r.category
                            ? <span className="omna-chip">{r.category}</span>
                            : <span className="omna-td-empty">—</span>}
                        </td>
                        <td>
                          {r.rating
                            ? <span className="omna-rating">★ {r.rating}</span>
                            : <span className="omna-td-empty">—</span>}
                        </td>
                        <td>{r.cuisine || <span className="omna-td-empty">—</span>}</td>
                        <td>
                          {r.website
                            ? <a className="omna-td-link" href={r.website} target="_blank" rel="noreferrer">↗ Visit</a>
                            : <span className="omna-td-empty">—</span>}
                        </td>
                        <td>
                          <button className="omna-del-btn" onClick={() => setResults((p) => p.filter((x) => x.id !== r.id))}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="omna-cards-grid">
                {filtered.map((r) => (
                  <div key={r.id} className="omna-card">
                    <div className="omna-card-head">
                      <div className="omna-card-avatar">{initials(r.name)}</div>
                      <div className="omna-card-title-wrap">
                        <div className="omna-card-name">{r.name || "Unknown"}</div>
                        <div className="omna-card-meta">
                          {r.category && <span className="omna-chip">{r.category}</span>}
                          {r.rating && <span className="omna-rating">★ {r.rating}</span>}
                        </div>
                      </div>
                      <button className="omna-del-btn" onClick={() => setResults((p) => p.filter((x) => x.id !== r.id))}>✕</button>
                    </div>
                    <div className="omna-card-fields">
                      {r.email    && <div className="omna-card-field"><span className="omna-fi">✉</span><span className="omna-fv omna-fv-email">{r.email}</span></div>}
                      {r.phone    && <div className="omna-card-field"><span className="omna-fi">📞</span><span className="omna-fv">{r.phone}</span></div>}
                      {r.location && <div className="omna-card-field"><span className="omna-fi">📍</span><span className="omna-fv">{r.location}</span></div>}
                      {r.cuisine  && <div className="omna-card-field"><span className="omna-fi">🍽</span><span className="omna-fv">{r.cuisine}</span></div>}
                      {r.website  && <div className="omna-card-field"><span className="omna-fi">🌐</span><a className="omna-fv omna-fv-link" href={r.website} target="_blank" rel="noreferrer">{r.website}</a></div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
