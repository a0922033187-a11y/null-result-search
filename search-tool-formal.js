// ═══════════════════════════════════════════════════════════
// Negative Result Search Tool v10.0
// ── 多來源搜尋 + 閘門系統 + NLP 分類 + 匯出 ──
//
// v10.0 (2026-07-21): 🔴 V5 Reranker — 物種匹配為主，技術關鍵字為輔
//   架構變更：speciesMatch × 0.45 + technical × 0.35 + citation × 0.10 + recency × 0.10
//   效果：對的植物 + 不同用詞 → 不下沉。不再依賴 glossary 完整性。
//
// v9.5 (2026-07-21): Glossary 技術詞全應用 — 不再漏掉同義詞論文
//   - buildQueryWords() 改用 applyGlossary()（全 glossary）而非只取 PLANT_NAME_KEYS
//   - 技術詞（扦插→rooting、發根→cuttings）現在正確加入 scoreQuery
//   - Glossary 擴充：扦插/發根/生根 互補同義詞（rooting↔cuttings）
//
// v9.4 (2026-07-21): HTML 命名實體清理 — 不再出現 ^|^lsquo; 亂碼
//   - cleanApiText() 新增 &lsquo; &rsquo; &ldquo; &rdquo; &ndash; &mdash; &hellip; &nbsp; 轉換
//   - 這些實體常見於 CrossRef 書目資料（期刊名、標題中的 curly quotes）
//
// v9.3 (2026-07-21): S2 搜尋優化 — 不要再浪費 2 億篇
//   - 新增 stripNegativeIntentWords()：S2 只搜主題詞，不搜結果判斷詞
//   - 「no effect / ineffective / have no」等負面意圖詞從 S2 查詢中剝離
//   - S2 用純主題查詢 → 廣泛召回 → NLP 分類器判斷不顯著結果
//
// v9.2 (2026-07-21): Bugfix — 三項修正
//   - 修復：英文查詢中的常見功能詞（have/has/did/was 等）被誤判為學名
//   - 修復：Semantic Scholar 回傳 0 篇時被隱藏，現在一律顯示三來源計數
//   - 修復：學名偵測列加入 word-break 防止視覺截斷 + inline 來源改為「內文偵測」
//
// v9.1 (2026-07-12): NLP 分類器調優 — 減少 false positive
//   - NDR-inspired patterns 權重砍半 (2→1, 1→0): Discussion boilerplate 不該觸發
//   - 三個 moderate patterns 降權 (2→1): limited-effect, without-effect, unexpectedly
//   - 預設閾值 2→3, title-positive 閾值 4→5
//   - AI prompt 新增不顯著結果嚴格定義（主要發現無效 ≠ Discussion 有限制）
//   - 診斷面板：NLP 全數被 AI 推翻時顯示 NLP 過敏提示
//
// v9.0 (2026-07-08): 測試版V4 — 三層評分架構（物種閘門+技術訊號+自適應斷點）
//   - Layer 1: 物種等級 Lv.0(排除)/Lv.1(同屬)/Lv.2(全中+加成)
//   - Layer 2: technicalScore = Σ(TF×1.5|1.0×IDF²) / Σ(IDF²) — 0~1
//   - Layer 3: 自適應斷點 — 找最大 relative gap ≥30% 切分
//   - 公式: technicalScore×0.85 + citation×0.08 + recency×0.07 + speciesBonus
//
// v8.3 (2026-07-08): 測試版V3 — TF詞頻 + 學名加成 + 完整文獻清單
//   - TF: 關鍵字出現次數直接加權（非 binary），無 log 正規化
//   - 學名加成: 全部 plant terms 在標題→+3.0 / 標題+摘要→+1.5
//   - Top 10 權重排名 → 完整文獻清單（年份新→舊，完整標題）
//
// v8.2 (2026-07-08): 測試版V2 — 方案B 統一權重 + 植物閘門修正
//   - 拔掉類型權重（plant=5.0/tech=2.0→all=1.0），純命中計數
//   - 植物閘門改用 openalexQuery（簡單核心詞）→ 不會誤判 auxin 為植物名
//   - 權重明細固定展開（open attribute）
//
// v8.2 (2026-07-08): 測試版V1 — 權重透明化 + Bug 修復
//   - scoreRelevance → 回傳物件含 keywordHits/plantPenalty
//   - rerankPapers → 儲存 _scoreBreakdown 於每篇論文
//   - renderScoreBreakdown: 每篇論文下方顯示權重計算明細
//   - Top 10 權重排名表（接在總結後面）
//   - 修復: 中文標題顯示（title_zh）+ translateViaGoogle 支援 sl/tl 參數
//   - 修復: AI 失敗時顯示「⚠️ AI 可能未成功回應」

// ── Formal mode: hide internal diagnostics ──
var FORMAL_MODE = true;
//
// v8.1 (2026-07-08): CrossRef 搜尋修復 + 關鍵字分流
//   - CrossRef: query= → query.bibliographic= + has-abstract + from-pub-date:2010
//   - OpenAlex: 簡單核心詞（植物名 only）→ 避免召回暴跌
//   - CrossRef: AI 豐富擴展詞 → bibliographic search
//   - enrichQueryWithTranslation → 三版回傳（openalex/crossref/score）
// ═══════════════════════════════════════════════════════════
//
// Architecture:
//   Phase 1: Multi-Source Search (OpenAlex + Semantic Scholar + CrossRef)
//   Phase 2: Negative Result Classification (keyword pattern matching)
//   Phase 3: DOI Verification (CrossRef lookup + title matching)
//   Phase 4: Report Assembly + Render
//   Each phase has hard gates — fail → feedback loop or graceful degradation
//
// Zero API key required for core search.
// Optional OpenRouter API key enables AI-powered Chinese summarization.

// ── OpenRouter API (free, no credit card, browser CORS) ──
// Aggregates 30+ free models. OpenAI-compatible endpoint.
// Free tier: 20 RPM / 50 RPD. Requires HTTP-Referer + X-Title headers.
// API key format: sk-or-v1-... (get from https://openrouter.ai/settings/keys)
var OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
var OPENROUTER_MODELS = [
  'tencent/hy3:free',                    // Tencent Hy3 — native Chinese, 295B MoE
  'google/gemma-4-31b-it:free',          // Google Gemma 4 31B — 140+ languages
  'nvidia/nemotron-3-ultra-550b-a55b:free', // NVIDIA Nemotron 3 Ultra 550B
];
var _aiWorkingModel = null;  // Cache which model works
var _aiSource = null;        // 'ollama' or provider name
var _aiErrors = [];          // Collect errors for debugging
var _lastAIError = null;    // Last AI error for diagnostics panel

// ── Provider detection from API key prefix ──
function detectProviders(apiKey) {
  if (!apiKey) return [];
  if (apiKey.startsWith('sk-or-v1-')) return [{
    name:'OpenRouter',endpoint:'https://openrouter.ai/api/v1/chat/completions',
    model:'tencent/hy3:free',
    headers:{'HTTP-Referer':'https://ntu-edu-tw.seminar.search','X-Title':'Negative Result Search Tool'}
  }];
  if (apiKey.startsWith('sk-')) return [
    {name:'DeepSeek',endpoint:'https://api.deepseek.com/v1/chat/completions',model:'deepseek-chat',headers:{}},
    {name:'OpenAI',endpoint:'https://api.openai.com/v1/chat/completions',model:'gpt-4o-mini',headers:{}},
  ];
  return [{name:'Custom',endpoint:'https://api.openai.com/v1/chat/completions',model:'gpt-4o-mini',headers:{}}];
}
// ── Call AI via OpenRouter (OpenAI-compatible format) ──
// Takes a prompt STRING, returns the model's text response.
// Returns null on failure (error logged to _aiErrors).
async function callAI(promptText, timeout) {
  // Source 1: Ollama (local, no key needed)
  if (!_aiSource || _aiSource==='ollama') {
    try {
      var resp0=await fetch('http://localhost:11434/v1/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:'qwen2.5:7b',messages:[{role:'user',content:promptText}]}),
        signal:AbortSignal.timeout(timeout||60000)});
      if(resp0.ok){_aiSource='ollama';var d0=await resp0.json();return(d0.choices&&d0.choices[0]&&d0.choices[0].message&&d0.choices[0].message.content)||''}
    }catch(e){if(_aiSource==='ollama')_aiSource=null}
  }

  // Source 2: Cloud (auto-detect from key)
  var apiKey2 = getApiKey(); if (!apiKey2) return null;
  var provs = detectProviders(apiKey2);
  if (!provs.length) return null;
  for (var pi=0; pi<provs.length; pi++) {
    var prov=provs[pi];
    try {
      var hdrs=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+apiKey2},prov.headers);
      var resp=await fetch(prov.endpoint,{method:'POST',headers:hdrs,
        body:JSON.stringify({model:prov.model,messages:[{role:'user',content:promptText}]}),
        signal:AbortSignal.timeout(timeout||45000)});
      if(resp.ok){_aiSource=prov.name;var d=await resp.json();
        return(d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content)||''}
      if(resp.status===401||resp.status===403)continue;
      var ed='';try{var ej=await resp.json();if(ej.error&&ej.error.message)ed=' — '+ej.error.message}catch(e){}
      _aiErrors.push(prov.name+': HTTP '+resp.status+ed);break;
    }catch(e){if(pi===provs.length-1)_aiErrors.push(prov.name+': '+((e.name==='AbortError')?'timeout':(e.message||'error')))}
  }
  return null;
}

function _logAIError(context, msg) {
  _aiErrors.push(context + ': ' + msg);
  if (_aiErrors.length > 10) _aiErrors.shift();
  _lastAIError = { context: context, message: msg, time: new Date().toISOString() };
  console.error('[AI] ' + context + ': ' + msg);
}
var OPENALEX_API = 'https://api.openalex.org/works';

// ── Domain filter: restrict OpenAlex search to plant/agriculture sciences ──
// OpenAlex tags every paper with concepts (hierarchical subject tags).
// We filter to only include papers tagged with at least ONE of these concepts.
// This eliminates materials science, medical, and other irrelevant domains.
var DOMAIN_CONCEPT_IDS = [
  'C59822182',  // Botany
  'C144027150', // Horticulture
  'C118518473', // Agriculture
  'C37621935',  // Agricultural science
  'C97137747',  // Forestry
  'C18903297',  // Ecology
  'C161221295', // Plant physiology
  'C2993199473',// Plant biochemistry
  'C159390177', // Soil science
  'C14171219',  // Agricultural soil science
  'C147135968', // Entomology
  'C201373426', // Plant pathology
  'C86803240',  // Biology (broad safety net)
];
var DOMAIN_FILTER = 'concepts.id:' + DOMAIN_CONCEPT_IDS.join('|');

// ── Journal quality lookup (from journal_quality.js) ──
function getJournalQuality(paper) {
  // Returns {tier: 'Q1'|'Q2'|'Q3'|'Q4', h_index: number} or null
  if (typeof JOURNAL_QUALITY === 'undefined') return null;

  // Try ISSN from OpenAlex result (primary_location.source.issn)
  // Not yet extracted — we'll add it to searchOpenAlex
  var issns = paper.issn_l ? [paper.issn_l] : [];
  if (paper.issns && paper.issns.length > 0) issns = issns.concat(paper.issns);

  for (var i = 0; i < issns.length; i++) {
    var issn = issns[i];
    if (issn && JOURNAL_QUALITY[issn] !== undefined) {
      var h = JOURNAL_QUALITY[issn];
      var tier = h >= 100 ? 'Q1' : h >= 50 ? 'Q2' : h >= 20 ? 'Q3' : 'Q4';
      return { tier: tier, h_index: h };
    }
  }
  return null;
}
var SEMANTIC_SCHOLAR_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
var CROSSREF_API = 'https://api.crossref.org/works';
var CROSSREF_DOI = 'https://api.crossref.org/works/';
var DEMO_KEY = '';

// ═══════════════════════════════════════════════════════════
// SECTION 1: Utility Functions
// ═══════════════════════════════════════════════════════════

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── SINGLE canonical text cleaner for ALL API responses ──
// Every title/abstract from any source MUST pass through this function.
// It handles: HTML entities (&lt; &gt; &amp; &quot; &#39; &#x2F; etc.),
//             XML/HTML tags (<em> <jats:p> <jats:italic> etc.),
//             and normalizes whitespace.
// This is the ONE place — do NOT add per-source cleaning elsewhere.
function cleanApiText(text) {
  if (!text) return '';
  var s = String(text);
  // Step 1: Unescape ALL HTML entities (must be BEFORE tag stripping)
  // Named entities first (before &amp; → & which would break them)
  s = s.replace(/&lsquo;/g, '‘')   // ' left single quote
       .replace(/&rsquo;/g, '’')   // ' right single quote
       .replace(/&ldquo;/g, '“')   // " left double quote
       .replace(/&rdquo;/g, '”')   // " right double quote
       .replace(/&ndash;/g, '–')   // – en dash
       .replace(/&mdash;/g, '—')   // — em dash
       .replace(/&hellip;/g, '…')  // … ellipsis
       .replace(/&nbsp;/g, ' ')         // non-breaking space
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&amp;/g, '&')
       .replace(/&quot;/g, '"')
       .replace(/&#x27;/g, '\'')
       .replace(/&#39;/g, '\'')
       .replace(/&#x2F;/g, '/')
       .replace(/&#x2f;/g, '/')
       .replace(/&#(\d+);/g, function(m, d) { return String.fromCharCode(parseInt(d, 10)); });
  // Step 2: Strip XML/HTML tags
  s = s.replace(/<[^>]*>/g, '');
  // Step 3: Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function hasChinese(text) {
  return /[一-鿿]/.test(text);
}

function isValidDOI(doi) {
  if (!doi) return false;
  var clean = doi.trim().replace(/^https?:\/\/doi\.org\//, '');
  return /^10\.\d{4,}\/.+/.test(clean);
}

function cleanDOI(doi) {
  if (!doi) return '';
  return doi.trim().replace(/^https?:\/\/doi\.org\//, '');
}

function titleWordOverlap(t1, t2) {
  // Strict check: what fraction of the SHORTER title's content words
  // appear in the LONGER title? ≥70% → match. Binary: pass or fail.
  if (!t1 || !t2) return 0;
  var words1 = t1.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; });
  var words2 = t2.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; });
  if (words1.length === 0 || words2.length === 0) return 0;

  var shorter = words1.length <= words2.length ? words1 : words2;
  var longer = words1.length > words2.length ? words1 : words2;
  var longerSet = new Set(longer);

  var matches = 0;
  for (var i = 0; i < shorter.length; i++) {
    if (longerSet.has(shorter[i])) matches++;
  }
  return matches / shorter.length;
}

function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  var tokenize = function(s) {
    return new Set(s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; }));
  };
  var setA = tokenize(a);
  var setB = tokenize(b);
  var intersection = 0;
  setA.forEach(function(w) { if (setB.has(w)) intersection++; });
  var union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  try {
    var words = [];
    Object.keys(inverted).forEach(function(word) {
      var positions = inverted[word];
      if (Array.isArray(positions)) {
        positions.forEach(function(pos) { words[pos] = word; });
      }
    });
    return words.join(' ');
  } catch(e) {
    return '';
  }
}

function formatAuthors(authors) {
  if (!authors || !authors.length) return '';
  var names = authors.map(function(a) {
    if (a.name) return a.name;
    if (a.author && a.author.display_name) return a.author.display_name;
    if (a.family) return a.family + ' ' + (a.given || '').charAt(0);
    if (a.display_name) return a.display_name;
    return '';
  }).filter(Boolean);
  return names.join(', ');
}

// ═══════════════════════════════════════════════════════════
// SECTION 2: Multi-Source Search Clients
// ═══════════════════════════════════════════════════════════

// ── Plant Family Lookup ──
// Maps common plant names (Chinese + scientific) to their taxonomic families.
// Used to boost "建議觀看" suggestions: same-family papers get priority.
var PLANT_FAMILIES = {
  // Gesneriaceae (苦苣苔科)
  'episcia': 'Gesneriaceae', '喜蔭花': 'Gesneriaceae', '喜荫花': 'Gesneriaceae',
  'saintpaulia': 'Gesneriaceae', 'african violet': 'Gesneriaceae', '非洲堇': 'Gesneriaceae',
  'streptocarpus': 'Gesneriaceae', 'sinningia': 'Gesneriaceae',
  'rechsteineria': 'Gesneriaceae', 'aeschynanthus': 'Gesneriaceae',
  'columnea': 'Gesneriaceae', 'nematanthus': 'Gesneriaceae',
  // Lauraceae (樟科)
  'litsea': 'Lauraceae', '山胡椒': 'Lauraceae', '馬告': 'Lauraceae',
  'cinnamomum': 'Lauraceae', 'persea': 'Lauraceae', 'avocado': 'Lauraceae',
  'laurus': 'Lauraceae', 'sassafras': 'Lauraceae',
  // Magnoliaceae
  'liriodendron': 'Magnoliaceae', 'magnolia': 'Magnoliaceae',
  // Myrtaceae
  'eucalyptus': 'Myrtaceae', '桉樹': 'Myrtaceae', '桉': 'Myrtaceae',
  'myrtus': 'Myrtaceae', 'melaleuca': 'Myrtaceae', 'syzygium': 'Myrtaceae',
  // Rosaceae
  'rose': 'Rosaceae', 'rosa': 'Rosaceae', '玫瑰': 'Rosaceae',
  'prunus': 'Rosaceae', '梅花': 'Rosaceae', 'malus': 'Rosaceae', '蘋果': 'Rosaceae',
  'fragaria': 'Rosaceae', '草莓': 'Rosaceae', 'rubus': 'Rosaceae',
  // Ericaceae
  'rhododendron': 'Ericaceae', '杜鵑': 'Ericaceae', '杜鵑花': 'Ericaceae',
  'azalea': 'Ericaceae', 'vaccinium': 'Ericaceae', 'blueberry': 'Ericaceae',
  // Orchidaceae
  'phalaenopsis': 'Orchidaceae', '蝴蝶蘭': 'Orchidaceae',
  'orchid': 'Orchidaceae', 'dendrobium': 'Orchidaceae', 'cymbidium': 'Orchidaceae',
  // Asteraceae
  'chrysanthemum': 'Asteraceae', '菊花': 'Asteraceae',
  'sunflower': 'Asteraceae', 'helianthus': 'Asteraceae', 'dahlia': 'Asteraceae',
  // Solanaceae
  'tomato': 'Solanaceae', '番茄': 'Solanaceae',
  'capsicum': 'Solanaceae', 'pepper': 'Solanaceae', 'petunia': 'Solanaceae',
  // Lamiaceae
  'salvia': 'Lamiaceae', 'lavandula': 'Lamiaceae', 'lavender': 'Lamiaceae',
  'rosmarinus': 'Lamiaceae', 'rosemary': 'Lamiaceae', 'mentha': 'Lamiaceae',
  // Euphorbiaceae
  'euphorbia': 'Euphorbiaceae', 'poinsettia': 'Euphorbiaceae',
  // Apocynaceae
  'nerium': 'Apocynaceae', 'adenium': 'Apocynaceae', 'plumeria': 'Apocynaceae',
  // Araceae
  'anthurium': 'Araceae', 'philodendron': 'Araceae', 'spathiphyllum': 'Araceae',
  // Rutaceae
  'citrus': 'Rutaceae', '柑橘': 'Rutaceae', 'murraya': 'Rutaceae',
  // Arecaceae
  'palm': 'Arecaceae', 'phoenix': 'Arecaceae', 'cocos': 'Arecaceae',
  // Poaceae (major cereal/grass — only matched if specifically queried)
  'bamboo': 'Poaceae', '竹子': 'Poaceae', 'turfgrass': 'Poaceae', 'lawn': 'Poaceae',
  // Fabaceae
  'acacia': 'Fabaceae', 'wisteria': 'Fabaceae', '紫藤': 'Fabaceae',
  // Other ornamentals
  'hibiscus': 'Malvaceae', '木槿': 'Malvaceae',
  'gardena': 'Rubiaceae', '栀子': 'Rubiaceae',
  'camella': 'Theaceae', '茶花': 'Theaceae', '山茶': 'Theaceae',
  'hydrangea': 'Hydrangeaceae', '繡球': 'Hydrangeaceae',
  'peony': 'Paeoniaceae', '牡丹': 'Paeoniaceae', '芍藥': 'Paeoniaceae',
};

function lookupFamily(query) {
  // Look up the plant family from the query
  var lower = query.toLowerCase();
  var families = {};
  var plantKeys = Object.keys(PLANT_FAMILIES);
  for (var i = 0; i < plantKeys.length; i++) {
    var key = plantKeys[i];
    if (lower.indexOf(key) !== -1) {
      var family = PLANT_FAMILIES[key];
      families[family] = (families[family] || 0) + 1;
    }
  }
  return Object.keys(families).length > 0 ? Object.keys(families) : [];
}

function filterQualitySuggestions(suggested, query) {
  // Filter and rank suggested papers by:
  // 1. Same taxonomic family (同科) — highest priority
  // 2. Same purpose/use (同目的) — inferred from query, not hardcoded
  // 3. Same technique (同技術) — from query keywords
  // 4. Recency (年代新)
  // 5. Research quality (排除書評、編輯部文章)

  var families = lookupFamily(query);
  var queryLower = query.toLowerCase();

  // Exclude non-research content
  var LOW_QUALITY_PATTERNS = [
    /\bbook review\b/i, /\beditorial\b/i, /\bnews\b/i,
    /\bproceedings\b/i, /\bconference report\b/i,
  ];

  var scored = [];
  for (var i = 0; i < suggested.length; i++) {
    var p = suggested[i];
    var title = (p.title || '').toLowerCase();
    var journal = (p.journal || '').toLowerCase();

    // Skip low-quality content types
    var isLowQuality = false;
    for (var j = 0; j < LOW_QUALITY_PATTERNS.length; j++) {
      if (LOW_QUALITY_PATTERNS[j].test(title) || LOW_QUALITY_PATTERNS[j].test(journal)) {
        isLowQuality = true;
        break;
      }
    }
    if (isLowQuality) continue;

    // Score: family match (同科) = 30 points
    var score = 0;
    var reasons = [];
    for (var f = 0; f < families.length; f++) {
      if (title.indexOf(families[f].toLowerCase()) !== -1 ||
          (p.abstract || '').toLowerCase().indexOf(families[f].toLowerCase()) !== -1) {
        score += 30;
        reasons.push('同科：' + families[f]);
        break;  // One family match is enough
      }
    }

    // Purpose inference: extract non-technique content words from query
    // E.g., "喜蔭花的組織培養" → technique is "組織培養", purpose inferred from "喜蔭花"
    // If query mentions "觀賞" or plant is known ornamental, boost ornamental papers
    // But DON'T hardcode — use query signals
    var isOrnamentalQuery = /(觀賞|ornamental|flower|室內|indoor|盆栽|pot|garden|園藝|horticultur)/i.test(queryLower);
    var isMedicinalQuery = /(藥|medicin|pharmac|藥用)/i.test(queryLower);
    var isTimberQuery = /(造林|forestry|timber|木材|tree)/i.test(queryLower);
    var isEssentialOilQuery = /(精油|essential oil|芳香|aroma)/i.test(queryLower);

    // Same purpose boost — based on QUERY signals, not hardcoded categories
    if (isOrnamentalQuery &&
        /(ornamental|flower|foliage|pot|indoor|garden|bedding|landscape)/i.test(title)) {
      score += 15; reasons.push('同目的：觀賞');
    }
    if (isMedicinalQuery &&
        /(medicin|pharmac|drug|therap|藥)/i.test(title)) {
      score += 15; reasons.push('同目的：藥用');
    }
    if (isTimberQuery &&
        /(forestry|timber|wood|tree|造林)/i.test(title)) {
      score += 15; reasons.push('同目的：林木');
    }
    if (isEssentialOilQuery &&
        /(essential oil|aroma|精油|芳香|volatile)/i.test(title)) {
      score += 15; reasons.push('同目的：精油');
    }
    // If no specific purpose inferred, skip purpose boost (don't guess)

    // Recency: +0 to +10 (newer = higher)
    var year = p.year || 0;
    if (year >= 2020) score += 10;
    else if (year >= 2010) score += 7;
    else if (year >= 2000) score += 4;
    else if (year >= 1990) score += 1;

    // Relevance from earlier scoring
    score += (p._relevance || 0) * 10;

    p._suggestionScore = score;
    scored.push(p);
  }

  // Sort by score descending, cap at 3.
  // MINIMUM THRESHOLD: at least 5 points (requires either family match, purpose match, or recent + relevant).
  // Papers with 0-4 points (no taxonomic/purpose connection, old, low relevance) are NOT shown.
  scored.sort(function(a, b) { return (b._suggestionScore || 0) - (a._suggestionScore || 0); });
  return scored.filter(function(p) { return (p._suggestionScore || 0) >= 5; }).slice(0, 3);
}

// ── Chinese→English Glossary for Horticulture/Plant Sciences ──
// Maps Chinese academic terms to their English equivalents.
// When a user types a mixed Chinese-English query, the Chinese parts
// are translated and appended — NOT dropped.
var ZH_EN_GLOSSARY = {
  // Propagation & horticulture
  '扦插': 'cuttings cutting propagation rooting adventitious root',
  '扦插繁殖': 'cutting propagation vegetative propagation rooting',
  '插穗': 'cuttings stem cuttings rooting',
  '發根': 'rooting adventitious root root formation cuttings',
  '不定根': 'adventitious root rooting',
  '生根': 'rooting root formation cuttings propagation',
  '繁殖': 'propagation',
  '無性繁殖': 'vegetative propagation clonal propagation',
  '組織培養': 'tissue culture micropropagation',
  '嫁接': 'grafting',
  '壓條': 'layering',
  '播種': 'seed germination seedling',
  '發芽': 'germination',
  '育苗': 'nursery seedling production',
  // Treatments
  '生長素': 'auxin IAA IBA NAA',
  '腐植酸': 'humic acid',
  '菌根': 'mycorrhiza mycorrhizal',
  '真菌': 'fungus fungal fungi',
  '萃取物': 'extract',
  '精油': 'essential oil',
  '濃度': 'concentration',
  '處理': 'treatment',
  // Species (common Chinese names)
  '馬告': 'Litsea cubeba',
  '山胡椒': 'Litsea cubeba',
  '喜蔭花': 'Episcia',
  '喜荫花': 'Episcia',
  '大岩桐': 'Gloxinia Sinningia',
  '非洲菫': 'Saintpaulia African violet',
  '鵝掌楸': 'Liriodendron tulipifera',
  '桉樹': 'Eucalyptus',
  '杜鵑': 'Rhododendron',
  '杜鵑花': 'Rhododendron azalea',
  '木薯': 'cassava Manihot esculenta',
  '楊樹': 'poplar Populus',
  '板栗': 'chestnut Castanea',
  '蘋果': 'apple Malus',
  '梅花': 'Prunus mume',
  '山藥': 'yam Dioscorea',
  '火龍果': 'pitaya dragon fruit Hylocereus',
  '蝴蝶蘭': 'Phalaenopsis orchid',
  '玫瑰': 'rose Rosa',
  '菊花': 'chrysanthemum',
  '百合': 'lily Lilium',
  '康乃馨': 'carnation Dianthus',
  '番茄': 'tomato Solanum lycopersicum',
  '水稻': 'rice Oryza sativa',
  '小麥': 'wheat Triticum',
  '大豆': 'soybean Glycine max',
  '黃豆': 'soybean Glycine max',
  '毛豆': 'edamame soybean Glycine max',
  '玉米': 'corn maize Zea mays',
  '棉花': 'cotton Gossypium',
  '花生': 'peanut Arachis hypogaea',
  '油菜': 'rapeseed canola Brassica napus',
  '甘蔗': 'sugarcane Saccharum',
  '高粱': 'sorghum Sorghum bicolor',
  '小米': 'millet Setaria',
  '燕麥': 'oat Avena sativa',
  '大麥': 'barley Hordeum vulgare',
  '馬鈴薯': 'potato Solanum tuberosum',
  '甘藷': 'sweet potato Ipomoea batatas',
  '甘薯': 'sweet potato Ipomoea batatas',
  '茶': 'tea Camellia sinensis',
  '咖啡': 'coffee Coffea',
  '可可': 'cocoa Theobroma cacao',
  // Results & problems
  '負面': 'negative null',
  '無效': 'ineffective no effect',
  '失敗': 'failure failed',
  '毒性': 'toxicity phytotoxic',
  '死亡率': 'mortality death',
  '植物毒性': 'phytotoxicity phytotoxic',
  '抑制': 'inhibition inhibit',
  '病害': 'disease pathogen',
  // Methods
  '統合分析': 'meta-analysis',
  '回顧': 'review',
  '試驗': 'trial experiment',
  '田間': 'field experiment',
  '溫室': 'greenhouse',
  // Academic concepts
  '公開偏誤': 'publication bias',
  '再現性': 'reproducibility replication',
  '檔案抽屜': 'file drawer',
  '註冊報告': 'registered reports',
  '選擇性報告': 'selective reporting',
  '複製危機': 'replication crisis',
};

// Plant-name-only glossary keys (not technical terms)
var PLANT_NAME_KEYS = new Set([
  '馬告','山胡椒','喜蔭花','喜荫花','大岩桐','非洲菫','鵝掌楸',
  '桉樹','杜鵑','杜鵑花','木薯','楊樹','板栗','蘋果','梅花',
  '山藥','火龍果','蝴蝶蘭','玫瑰','菊花','百合','康乃馨','番茄','水稻','小麥',
  '大豆','玉米','棉花','花生','油菜','甘蔗','高粱','小米','燕麥','大麥',
  '黃豆','毛豆','馬鈴薯','甘藷','甘薯','茶','咖啡','可可',
]);

// ── Hybrid Chinese→English Translation ──
// Architecture:
//   Step 1: Glossary for known domain terms (instant, precise, offline)
//   Step 2: Google Translate free endpoint for unknown Chinese (covers everything else)
//   Step 3: Fallback: if Google fails → MyMemory → glossary-only
//   Each step degrades gracefully — translation failure never blocks search.

function extractChineseText(query) {
  // Return only the Chinese-character portions of the query
  var matches = query.match(/[一-鿿㐀-䶿]+/g);
  return matches ? matches.join(' ') : '';
}

function extractEnglishText(query) {
  // Return only English/latin portions — match individual words (no spaces in match)
  var matches = query.match(/[a-zA-Z]{2,}/g);
  return matches ? matches.filter(function(s) { return s.length >= 2; }) : [];
}

function applyGlossary(chineseText) {
  // Apply domain glossary to Chinese text, return English terms
  var result = [];
  var remaining = chineseText;
  var glossaryKeys = Object.keys(ZH_EN_GLOSSARY).sort(function(a, b) { return b.length - a.length; });
  var usedKeys = new Set();

  for (var i = 0; i < glossaryKeys.length; i++) {
    var zh = glossaryKeys[i];
    if (remaining.indexOf(zh) !== -1 && !usedKeys.has(zh)) {
      result.push(ZH_EN_GLOSSARY[zh]);
      usedKeys.add(zh);
    }
  }
  return result;
}

// ── Google Translate fallback (free, no key) ──
// Used ONLY when user has no Gemini key.
// Glossary-matched Chinese terms are STRIPPED before sending to Google,
// preventing literal translations like "喜蔭花" → "shade-loving flowers".

var GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

async function translateViaGoogle(text, sl, tl) {
  try {
    sl = sl || 'zh-CN'; tl = tl || 'en';  // Default: Chinese→English (query translation)
    var url = GOOGLE_TRANSLATE_URL + '?client=gtx&sl=' + sl + '&tl=' + tl + '&dt=t&q=' + encodeURIComponent(text);
    var resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    var data = await resp.json();
    if (!data || !data[0] || !data[0][0]) return null;
    // Google splits input by \n into separate segments. Join them back with \n
    // to preserve line boundaries (critical for multi-title translation).
    var segments = [];
    for (var i = 0; i < data[0].length; i++) {
      if (data[0][i] && data[0][i][0]) segments.push(data[0][i][0]);
    }
    // If input had newlines, preserve them in output
    var hasNewlines = text.indexOf('\n') !== -1;
    return (hasNewlines ? segments.join('\n') : segments.join('')).trim();
  } catch(e) {
    return null;
  }
}

// ── Main translation pipeline ──

function buildEnglishQuery(query) {
  // If no Chinese at all, return as-is
  if (!hasChinese(query)) return query;

  // Step 1: Extract English parts (scientific names, English keywords already present)
  var englishParts = extractEnglishText(query);

  // Step 2: Extract Chinese parts
  var chineseText = extractChineseText(query);

  // Step 3: Apply glossary to Chinese parts (instant, always works)
  var glossaryResults = [];
  if (chineseText) {
    glossaryResults = applyGlossary(chineseText);
  }

  // Combine immediately: English + glossary (sync — always available)
  var allWords = englishParts.slice();  // copy
  for (var g = 0; g < glossaryResults.length; g++) {
    allWords = allWords.concat(glossaryResults[g].split(/\s+/));
  }

  // Deduplicate
  var seen = new Set();
  var result = [];
  for (var j = 0; j < allWords.length; j++) {
    var w = allWords[j].toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    result.push(w);
  }

  // If we got enough from glossary, that's fine. Return sync result immediately.
  // The async translation will be used as a supplement if available.
  var syncResult = result.length > 0 ? result.join(' ') : query;

  return syncResult;
}

// ── Async: enrich query with Google Translate ──
// Called separately by the search orchestrator.
// Returns enriched query string, or the original if translation fails.

// ── Gemini-powered query enrichment (combined call) ──
// ONE API call does BOTH query translation AND suggestion keywords.
// Reduces API usage from 3 calls/search to 2 calls/search.

async function geminiEnrichQuery(query) {
  var apiKey = getApiKey();
  if (!apiKey) return null;

  var chineseText = extractChineseText(query);
  if (!chineseText) return null;

  var prompt = 'Translate this Chinese academic search query into 3-7 English keywords for searching OpenAlex/CrossRef.\n\n' +
    'RULES:\n' +
    '1. Plant names → scientific names (喜蔭花→Episcia, 馬告→Litsea cubeba)\n' +
    '2. Technical terms → academic English (扦插→cutting propagation, 組織培養→tissue culture)\n' +
    '3. Return ONLY space-separated keywords. No sentences.\n\n' +
    'Query: ' + chineseText + '\n\nKeywords:';

  try {
    var keywords = await callAI(prompt, 10000);

    if (!keywords) return null;
    keywords = keywords.trim().toLowerCase();
    if (!keywords) {
      _logAIError('gemini-translate', 'empty response');
      return null;
    }
    return keywords;
  } catch(e) {
    _logAIError('gemini-enrich', e.message || 'error');
    return null;
  }
}

// ── Common English plant-science terms that are NOT scientific names ──
// Used to filter false positives when detecting Latin binomials in English queries.
// These are technical terms that could appear as two-word phrases (e.g. "cutting propagation",
// "adventitious root") and should never be treated as Genus species.
function isCommonEnglishPlantTerm(word) {
  var COMMON_ENGLISH_PLANT_TERMS = new Set([
    // Plant science technical terms (multi-syllable, unmistakably English)
    'cutting', 'cuttings', 'adventitious', 'vegetative', 'propagation',
    'formation', 'development', 'temperature', 'greenhouse', 'nursery',
    'treatment', 'treatments', 'induction', 'photosynthesis', 'chlorophyll',
    'germplasm', 'resistance', 'tolerance', 'fertilizer', 'irrigation',
    'conventional', 'sustainable', 'regeneration', 'management', 'production',
    'application', 'associated', 'significant', 'potential', 'important',
    'increased', 'decreased', 'improved', 'reduced', 'enhanced', 'compared',
    'negative', 'ineffective', 'unsuccessful', 'failure', 'failed',
    'results', 'result', 'effect', 'effects', 'study', 'studies', 'research',
    'method', 'methods', 'analysis', 'review', 'system', 'model',
    'factor', 'factors', 'condition', 'conditions', 'quality',
    'test', 'tests', 'trial', 'trials',
    // Common English plant morphology terms
    'stem', 'stems', 'leaf', 'leaves', 'root', 'roots', 'shoot', 'shoots',
    'plant', 'plants', 'fruit', 'fruits', 'seed', 'seeds', 'flower', 'flowers',
    'tissue', 'water', 'soil', 'growth', 'light', 'stress', 'hormone',
    'auxin', 'medium', 'field', 'control', 'response', 'culture',
    'lateral', 'primary', 'secondary', 'terminal', 'axillary',
    'apical', 'basal', 'nodal', 'first', 'second', 'third', 'report',
    'species', 'genus', 'family', 'cultivar', 'variety', 'hybrid',
    'different', 'during', 'after', 'before', 'between', 'under',
    'through', 'above', 'below', 'more', 'less', 'higher', 'lower',
    // ── Common English words that are NEVER scientific names ──
    // (false-positive guard for binomial regex in enrichQueryWithTranslation)
    'have', 'has', 'had', 'does', 'did', 'done', 'not', 'nor',
    'was', 'were', 'are', 'can', 'may', 'any', 'some', 'much',
    'also', 'very', 'just', 'only', 'even', 'then', 'than',
    'over', 'into', 'onto', 'upon', 'most', 'many', 'each',
    'both', 'such', 'same', 'well', 'with', 'that', 'this',
    'will', 'would', 'could', 'shall', 'should', 'been', 'being',
  ]);
  return COMMON_ENGLISH_PLANT_TERMS.has(word);
}

async function enrichQueryWithTranslation(query) {
  if (!hasChinese(query)) {
    // English query: try to detect scientific name directly from input
    // Iterate all "Word1 word2" pairs to find a Latin binomial (case-insensitive genus)
    // Skip common English plant-science terms that are not scientific names
    var sciName = null;
    var binomialRe = /\b([A-Za-z][a-z]{2,})\s+([a-z]{2,})\b/g;
    var bm;
    while ((bm = binomialRe.exec(query)) !== null) {
      var candGenus = bm[1].toLowerCase();
      var candSpecies = bm[2].toLowerCase();
      // Skip pairs where either word is a common English technical term
      if (!isCommonEnglishPlantTerm(candGenus) && !isCommonEnglishPlantTerm(candSpecies)) {
        sciName = { genus: candGenus, species: candSpecies, source: 'inline' };
        break;
      }
    }
    return {openalex: query, crossref: query, score: query, scientificName: sciName || null, scientificNameSource: sciName ? sciName.source : 'none'};
  }

  var chineseText = extractChineseText(query);
  var englishParts = extractEnglishText(query);

  // Step 1: Strip ONLY plant-name glossary matches. Technical terms stay.
  var unknownChinese = chineseText;
  var plantKeys = Array.from(PLANT_NAME_KEYS).sort(function(a, b) { return b.length - a.length; });
  for (var pk = 0; pk < plantKeys.length; pk++) {
    unknownChinese = unknownChinese.replace(new RegExp(plantKeys[pk], 'g'), '');
  }
  unknownChinese = unknownChinese.replace(/\s+/g, ' ').trim();

  // Step 2: Google (search) + AI (scoring + scientific name)
  var googleTranslation = null, aiTranslation = null, aiRawResponse = null;
  // Try glossary first for scientific name (always available, no API needed)
  var scientificName = getGlossaryScientificName(chineseText);
  var sciNameExplicitNone = false;  // AI explicitly said "no plant specified"
  if (unknownChinese.length > 0) {
    googleTranslation = await translateViaGoogle(unknownChinese);
    if (getApiKey()) {
      var aiPrompt = '將以下中文學術查詢翻譯成英文關鍵字（5-7 個），用於搜尋植物科學資料庫。\n' +
        '根據查詢中的植物與主題，優先使用與該植物/該領域最相關的學術用語。\n' +
        '最後，在括號中提供該植物的拉丁學名（屬名+種小名，Genus species）。\n' +
        '⚠️ 重要：如果查詢中沒有指定任何植物（例如純技術查詢如「節水灌溉」），學名請填 none，不要猜測任何植物。\n' +
        '格式範例：keyword1 keyword2 keyword3 (Genus species)\n' +
        '無植物範例：keyword1 keyword2 keyword3 (none)\n' +
        '僅回傳英文關鍵字與學名，不要句子。\n查詢：' + query;
      aiRawResponse = await callAI(aiPrompt, 8000);
      if (aiRawResponse) {
        // Parse scientific name from AI response
        var aiSciName = parseScientificNameFromAI(aiRawResponse);
        if (aiSciName) {
          if (aiSciName.source === 'ai-none') {
            // AI explicitly said "no plant specified" — clear any glossary name too
            scientificName = null;
            sciNameExplicitNone = true;
          } else {
            scientificName = aiSciName;  // AI overrides glossary
          }
        }
        // Strip annotation for keyword extraction
        aiTranslation = stripScientificNameAnnotation(aiRawResponse);
      }
    }
  }

  function buildQueryWords(translation) {
    var words = englishParts.slice();
    if (chineseText) {
      // Apply FULL glossary (plant names + technical terms like 扦插→rooting)
      // Previously only PLANT_NAME_KEYS were added — technical terms were skipped,
      // causing papers using synonyms (e.g. "rooting" vs "cuttings") to score zero.
      var glossaryTerms = applyGlossary(chineseText);
      for (var g = 0; g < glossaryTerms.length; g++) {
        words = words.concat(glossaryTerms[g].toLowerCase().split(/\s+/));
      }
    }
    if (translation) words = words.concat(translation.toLowerCase().split(/\s+/));
    return words;
  }

  function dedupWords(words) {
    var seen = new Set(), result = [];
    var STOP_WORDS = new Set(['the','a','an','is','are','was','were','of','in','on','to','for','and','or','it','that','this','be','has','have','with','by','from']);
    for (var j = 0; j < words.length; j++) {
      var w = words[j].replace(/[^a-zA-Z0-9-]/g, '');
      if (w.length < 2) continue;
      var wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower)) continue;
      if (seen.has(wLower)) continue;
      seen.add(wLower); result.push(w);
    }
    return result;
  }

  var searchWords = buildQueryWords(googleTranslation);
  var scoreWords = buildQueryWords(aiTranslation || googleTranslation);

  // Build simple OpenAlex query: plant names only (tested: too many keywords → recall collapse)
  var openalexWords = englishParts.slice();
  if (chineseText) {
    var pks3 = Array.from(PLANT_NAME_KEYS).sort(function(a, b) { return b.length - a.length; });
    for (var pk3 = 0; pk3 < pks3.length; pk3++) {
      var zh3 = pks3[pk3];
      if (chineseText.indexOf(zh3) !== -1) {
        openalexWords = openalexWords.concat((ZH_EN_GLOSSARY[zh3] || '').toLowerCase().split(/\s+/));
      }
    }
  }

  return {
    openalex: dedupWords(openalexWords).join(' ') || query,     // SIMPLE: plant names only → OpenAlex
    crossref: dedupWords(scoreWords).join(' ') || query,        // RICH: AI keywords → CrossRef bibliographic
    score: dedupWords(scoreWords).join(' ') || query,           // RICH: for relevance scoring
    scientificName: scientificName || null,                      // {genus, species, source} or null
    scientificNameSource: sciNameExplicitNone ? 'ai-none' : (scientificName ? scientificName.source : 'none'),
    scientificNameExplicitNone: sciNameExplicitNone
  };
}

// Debug helper
function debugQueryTranslation(query) {
  return {
    original: query,
    hasChinese: hasChinese(query),
    chineseText: extractChineseText(query),
    englishParts: extractEnglishText(query),
    syncQuery: buildEnglishQuery(query),
  };
}

function truncateQuery(query, maxLen) {
  // OpenAlex and S2 have query length limits
  if (query.length <= maxLen) return query;
  // Keep the most distinctive words (longer words are more specific)
  var words = query.split(/\s+/);
  var result = [];
  var len = 0;
  // Sort by length descending to keep most specific terms
  var sorted = words.slice().sort(function(a, b) { return b.length - a.length; });
  var keepSet = new Set();
  for (var i = 0; i < sorted.length; i++) {
    if (len + sorted[i].length + 1 <= maxLen) {
      keepSet.add(sorted[i]);
      len += sorted[i].length + 1;
    }
  }
  // Preserve original order
  for (var j = 0; j < words.length; j++) {
    if (keepSet.has(words[j])) result.push(words[j]);
  }
  return result.join(' ') || words.slice(0, 3).join(' ');
}

// ── OpenAlex Search ──
// Free, no key, 250M+ works, CORS-enabled
async function searchOpenAlex(query, limit) {
  limit = limit || getSearchLimit('openalex');
  var eq = buildEnglishQuery(query);
  var allResults = [];
  var seenDOIs = new Set();
  allResults._debug = { source: 'openalex', query: eq, url: '', error: '', count: 0 };

  try {
    var q = truncateQuery(eq, 300);
    var url = OPENALEX_API + '?search=' + encodeURIComponent(q) +
              '&per_page=' + limit +
              '&sort=relevance_score:desc' +
              '&filter=type:article,has_doi:true,' + DOMAIN_FILTER;
    allResults._debug.url = url;
    var resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      allResults._debug.error = 'HTTP ' + resp.status;
      return allResults;
    }
    var data = await resp.json();
    var results = data.results || [];
    allResults._debug.count = results.length;
    if (results.length === 0) return allResults;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var doi = cleanDOI(r.doi);
      if (!doi || seenDOIs.has(doi)) continue;
      seenDOIs.add(doi);

      var authors = (r.authorships || []).map(function(a) {
        return { name: a.author ? a.author.display_name : '' };
      });
      // Extract ISSN for journal quality lookup
      var source = (r.primary_location && r.primary_location.source) || {};
      var issn_l = source.issn_l || '';
      var issns = source.issn || [];

      allResults.push({
        title: cleanApiText(r.title),
        doi: doi,
        authors: authors,
        journal: source.display_name || '',
        issn_l: issn_l,
        issns: issns,
        year: r.publication_date ? parseInt(r.publication_date.substring(0, 4)) : null,
        abstract: reconstructAbstract(r.abstract_inverted_index),
        citationCount: r.cited_by_count || 0,
        source: 'openalex',
        type: 'paper',
      });
    }
  } catch(e) {
    allResults._debug.error = e.message || 'fetch error';
  }
  return allResults;
}

// ── Semantic Scholar Search ──
// Free, no key, 200M+ papers, generous rate limits from browser
async function searchSemanticScholar(query, limit) {
  limit = limit || getSearchLimit('semantic_scholar');
  var eq = buildEnglishQuery(query);
  var allResults = [];
  var seenIDs = new Set();

  try {
    var q = truncateQuery(eq, 300);
    var fields = 'title,authors,year,externalIds,abstract,citationCount,journal';
    var url = SEMANTIC_SCHOLAR_API + '?query=' + encodeURIComponent(q) +
              '&limit=' + limit + '&fields=' + fields;
    var resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return allResults;
    var data = await resp.json();
    if (!data.data) return allResults;
    for (var i = 0; i < data.data.length; i++) {
      var r = data.data[i];
      var doi = '';
      if (r.externalIds && r.externalIds.DOI) {
        doi = cleanDOI(r.externalIds.DOI);
      }
      var dedupKey = doi || r.paperId || '';
      if (dedupKey && seenIDs.has(dedupKey)) continue;
      if (dedupKey) seenIDs.add(dedupKey);
      var authors = (r.authors || []).map(function(a) {
        return { name: a.name || '' };
      });
      allResults.push({
        title: cleanApiText(r.title),
        doi: doi,
        authors: authors,
        journal: r.journal ? r.journal.name || '' : '',
        year: r.year || null,
        abstract: cleanApiText(r.abstract),
        citationCount: r.citationCount || 0,
        source: 'semantic_scholar',
        type: 'paper'
      });
    }
  } catch(e) {
    // Source unavailable
  }
  return allResults;
}

// ── CrossRef Search ──
// Free, no key, comprehensive DOI registry
async function searchCrossRef(query, limit) {
  limit = limit || getSearchLimit('crossref');
  var eq = buildEnglishQuery(query);
  var allResults = [];
  var seenDOIs = new Set();

  try {
    var q = truncateQuery(eq, 300);
    var url = CROSSREF_API + '?query.bibliographic=' + encodeURIComponent(q) +
              '&rows=' + limit + '&sort=score' +
              '&filter=type:journal-article,has-abstract:true,from-pub-date:2010';
    var resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return allResults;
    var data = await resp.json();
    if (!data.message || !data.message.items) return allResults;
    for (var i = 0; i < data.message.items.length; i++) {
      var r = data.message.items[i];
      var doi = r.DOI || '';
      if (!doi || seenDOIs.has(doi)) continue;
      seenDOIs.add(doi);
      var authors = (r.author || []).map(function(a) {
        return { name: (a.given || '') + ' ' + (a.family || '') };
      });
      var year = null;
      if (r['published-print'] && r['published-print']['date-parts'] && r['published-print']['date-parts'][0]) {
        year = r['published-print']['date-parts'][0][0];
      } else if (r.created && r.created['date-parts'] && r.created['date-parts'][0]) {
        year = r.created['date-parts'][0][0];
      }
      allResults.push({
        title: cleanApiText((r.title && r.title[0]) || ''),
        doi: doi,
        authors: authors,
        journal: (r['container-title'] && r['container-title'][0]) || '',
        issn_l: (r['issn-type'] && r['issn-type'][0] && r['issn-type'][0].value) || r.ISSN || '',
        issns: (r['issn-type'] || []).map(function(x) { return x.value || ''; }).filter(Boolean),
        year: year,
        abstract: cleanApiText(r.abstract),
        citationCount: r['is-referenced-by-count'] || 0,
        source: 'crossref',
        type: 'paper'
      });
    }
  } catch(e) {
    // Source unavailable
  }
  return allResults;
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// SECTION 3: Relevance Filter + Deduplication Engine
// ═══════════════════════════════════════════════════════════

// ── Search Config ──
var SEARCH_CONFIG = {
  mode: 'showcase',  // 'showcase' = 5+5 quick demo, 'deep' = unlimited full search
  maxRegular: 5,
  maxNegative: 5,
  // Year filter — hard rule: prefer recent papers. Old papers without abstracts are noise.
  minYear: 2000,       // showcase: only papers from 2000+
  deepMinYear: 1950,   // deep: include older papers too (classic negative results exist)
  sortNewestFirst: false, // 依 _rankScore 加權分數排序（非年份）
  requireContent: true,  // hard rule: exclude papers with no abstract AND no classifiable title
  // Deep mode overrides
  get deepMaxRegular() { return 12; },
  get deepMaxNegative() { return 12; },
};

function getSearchLimit(source) {
  // Fetch 50 per source — large pool for better top-5 selection.
  // Showcase/deep only differ in DISPLAY count, not search depth.
  return 50;
}

function getMaxRegular() {
  return SEARCH_CONFIG.mode === 'showcase' ? SEARCH_CONFIG.maxRegular : SEARCH_CONFIG.deepMaxRegular;
}

function getMaxNegative() {
  return SEARCH_CONFIG.mode === 'showcase' ? SEARCH_CONFIG.maxNegative : SEARCH_CONFIG.deepMaxNegative;
}

// ── Relevance Scoring ──
// Filter out papers that don't match the user's query.
// This is critical because OpenAlex search matches on individual words,
// which can return papers about "lung inflammation" when searching "humic acid plant cuttings".

var RELEVANCE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'about',
  'and', 'but', 'or', 'if', 'while', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'them', 'their', 'our', 'my', 'your',
  // Search-intent words (should NOT be used as content keywords)
  'negative', 'null', 'ineffective', 'failure', 'failed', 'unsuccessful',
  'results', 'result', 'effect', 'effects', 'study', 'studies', 'research',
  'using', 'use', 'used', 'based', 'including', 'include', 'associated',
]);

// ── S2 Query Cleaner: strip negative-result intent words ──
// Semantic Scholar's search engine is topic-based — it chokes on
// "no effect", "ineffective", "have no" etc. because academic titles
// don't contain those phrases. We strip result-direction words and let
// our own NLP classifier identify negative results from the returned papers.
// This way S2 casts a WIDE net on the TOPIC, and our classifier filters.
var NEGATIVE_INTENT_PATTERNS = [
  /\bno effect\b/i, /\bno significant\b/i, /\bnot effective\b/i,
  /\bnot significant\b/i, /\bdid not\b/i, /\bdoes not\b/i,
  /\bwithout effect\b/i, /\bno benefit\b/i, /\bno difference\b/i,
  /\bfailed to\b/i, /\bwas not\b/i, /\bwere not\b/i,
  /\bhave no\b/i, /\bhas no\b/i, /\bshowed no\b/i, /\bshown no\b/i,
  /\bfound no\b/i, /\brevealed no\b/i,
];
var NEGATIVE_INTENT_WORDS = new Set([
  'negative', 'null', 'ineffective', 'unsuccessful', 'failure', 'failed',
  'ineffective', 'inefficacy', 'ineffectiveness',
]);

function stripNegativeIntentWords(query) {
  // Remove negative-result phrases and words from query,
  // keeping only subject-matter terms (species, technique, treatment).
  // Used for Semantic Scholar which needs clean topic queries.
  var cleaned = query;
  for (var i = 0; i < NEGATIVE_INTENT_PATTERNS.length; i++) {
    cleaned = cleaned.replace(NEGATIVE_INTENT_PATTERNS[i], ' ');
  }
  // Also remove standalone negative-intent words
  var words = cleaned.split(/\s+/);
  var kept = [];
  for (var j = 0; j < words.length; j++) {
    var w = words[j].toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (w.length < 2) continue;
    if (NEGATIVE_INTENT_WORDS.has(w)) continue;
    if (RELEVANCE_STOP_WORDS.has(w)) continue;
    kept.push(words[j]);
  }
  var result = kept.join(' ').replace(/\s+/g, ' ').trim();
  // If we stripped everything (extreme edge case), return original
  return result.length > 0 ? result : query;
}

function extractQueryKeywords(query) {
  // Extract meaningful content keywords from the query
  var words = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  var keywords = [];
  var seen = new Set();
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length < 3) continue;  // Skip short words
    if (RELEVANCE_STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    keywords.push(w);
  }
  // Also add 2-word phrases (bigrams)
  var bigrams = [];
  for (var j = 0; j < words.length - 1; j++) {
    var bg = words[j] + ' ' + words[j + 1];
    if (words[j].length >= 3 && words[j + 1].length >= 3 &&
        !RELEVANCE_STOP_WORDS.has(words[j]) && !RELEVANCE_STOP_WORDS.has(words[j + 1])) {
      if (!seen.has(bg)) {
        seen.add(bg);
        bigrams.push(bg);
      }
    }
  }
  // Detect genus/species names (capitalized words in original query)
  var genusHints = [];
  var origWords = query.replace(/[^a-zA-Z0-9\s-]/g, ' ').split(/\s+/);
  for (var gi = 0; gi < origWords.length; gi++) {
    var ow = origWords[gi];
    if (ow.length >= 5 && /^[A-Z]/.test(ow)) {
      genusHints.push(ow.toLowerCase());
    }
  }

  return { unigrams: keywords, bigrams: bigrams, _originalQuery: query, _genusHints: genusHints };
}

// ── Count keyword occurrences (title ×1.5, abstract ×1.0) ──
function countOccurrences(word, title, abstract) {
  var t = (title || '').toLowerCase();
  var a = (abstract || '').toLowerCase();
  var tc = 0, ac = 0;
  var idx = 0;
  while ((idx = t.indexOf(word, idx)) !== -1) { tc++; idx += word.length; }
  idx = 0;
  while ((idx = a.indexOf(word, idx)) !== -1) { ac++; idx += word.length; }
  return tc * 1.5 + ac * 1.0;
}

// ── V4: Three-Layer Scoring ──
// Layer 1: Species gate (Lv.0 excluded, Lv.1 partial, Lv.2 full)
// Layer 2: Technical signal strength (IDF-weighted, 0~1)
// Layer 3: Adaptive gap cut (runtime, post-scoring)
function countWord(str, word) {
  var count = 0, pos = -1;
  while ((pos = str.indexOf(word, pos + 1)) !== -1) count++;
  return count;
}

function scoreRelevance(paper, queryKeywords) {
  var text = ((paper.title || '') + ' ' + (paper.abstract || '')).toLowerCase();
  var title = (paper.title || '').toLowerCase();
  var abstract = (paper.abstract || '').toLowerCase();
  var unigrams = queryKeywords.unigrams;
  var bigrams = queryKeywords.bigrams;
  var gatePlantTerms = queryKeywords._gatePlantTerms || [];
  var idfWeights = queryKeywords._idfWeights || {};
  if (unigrams.length === 0 && bigrams.length === 0) return {score:1, keywordHits:{titleHits:[],abstractHits:[]}, technicalScore:1, speciesLevel:2, speciesBonus:0, plantPenalty:false};

  // ── Split: plant vs technical keywords ──
  var plantUnigrams = gatePlantTerms;
  var techUnigrams = unigrams.filter(function(w) { return plantUnigrams.indexOf(w) === -1; });
  var techBigrams = bigrams.filter(function(bw) {
    return !plantUnigrams.some(function(pw) { return bw.indexOf(pw) !== -1; });
  });

  // ── Layer 1: Species gate ──
  // Two-layer logic:
  //   1. Scientific name available → strict genus/species gate
  //   2. No scientific name → discriminating terms from glossary/capitals (Tier 1+2)
  //   3. Neither → no gate (neutral: speciesLevel=2, bonus=0)
  //   AI explicitly said "none" → no gate (correct: tech query without plant)
  var sciName = queryKeywords._scientificName;
  var sciNameExplicitNone = queryKeywords._scientificNameExplicitNone;
  var foundPlant = true;
  var plantHits = [];
  var allInTitle = true;
  var allFound = true;
  var speciesLevel = 2;
  var speciesBonus = 0;
  var plantPenalty = false;
  var hasPlantQuery = false;
  var gateMethod = 'none';  // 'scientific-name' | 'discriminating-terms' | 'ai-none' | 'none'

  if (sciNameExplicitNone) {
    // AI explicitly said "no plant in query" → no gate (correct behavior for tech queries)
    gateMethod = 'ai-none';
    hasPlantQuery = false;
  } else if (sciName && sciName.genus) {
    // ── Scientific name gate (preferred: structural, not corpus-dependent) ──
    gateMethod = 'scientific-name';
    hasPlantQuery = true;
    var genusInTitle = title.indexOf(sciName.genus) !== -1;
    var genusInAbstract = abstract.indexOf(sciName.genus) !== -1;
    var genusHit = genusInTitle || genusInAbstract;
    var speciesHit = sciName.species ? (title.indexOf(sciName.species) !== -1 || abstract.indexOf(sciName.species) !== -1) : true;

    if (genusHit) {
      plantHits.push(sciName.genus);
      if (sciName.species && speciesHit) plantHits.push(sciName.species);
      if (!genusInTitle && sciName.species && title.indexOf(sciName.species) === -1) allInTitle = false;

      if (sciName.species && !speciesHit) {
        speciesLevel = 1;  // Genus found, species not → Lv.1 (同屬不同種)
        speciesBonus = 0;
      } else {
        speciesLevel = 2;  // Both found → Lv.2
        speciesBonus = allInTitle ? 3.0 : 1.5;
      }
    } else {
      speciesLevel = 0;    // Neither found → Lv.0 ×0.3
      speciesBonus = 0;
      plantPenalty = true;
      foundPlant = false;
      allFound = false;
      allInTitle = false;
    }
  } else if (gatePlantTerms.length > 0) {
    // ── Fallback: discriminating terms from Tier 1+2 (glossary or capitalized words) ──
    gateMethod = 'discriminating-terms';
    hasPlantQuery = true;
    foundPlant = false;
    for (var pi = 0; pi < gatePlantTerms.length; pi++) {
      var pt = gatePlantTerms[pi];
      if (title.indexOf(pt) !== -1) {
        foundPlant = true; plantHits.push(pt);
      } else if (abstract.indexOf(pt) !== -1) {
        foundPlant = true; plantHits.push(pt);
        allInTitle = false;
      } else {
        allFound = false; allInTitle = false;
      }
    }
    speciesLevel = !foundPlant ? 0 : (allFound ? 2 : 1);
    speciesBonus = (speciesLevel === 2) ? (allInTitle ? 3.0 : 1.5) : 0;
    plantPenalty = speciesLevel === 0;
  }
  // else: no scientific name, no Tier 1+2 terms → gate not activated (speciesLevel=2, bonus=0, gateMethod='none')

  // ── Layer 2: Technical signal strength (IDF-weighted) ──
  // 分子 = Σ[hit tech keywords: (titleTF×1.5 + abstractTF×1.0) × weight(w)]
  // 分母 = Σ[all tech keywords: weight(w)]
  var techNumerator = 0;
  var techDenominator = 0;
  var uniTitleHits = [], uniAbstractHits = [];

  for (var i = 0; i < techUnigrams.length; i++) {
    var w = techUnigrams[i];
    var weight = idfWeights[w] || 1.0;
    techDenominator += weight;
    var tc = countWord(title, w);
    var ac = countWord(abstract, w);
    if (tc + ac > 0) {
      techNumerator += (tc * 1.5 + ac * 1.0) * weight;
      if (tc > 0) uniTitleHits.push(w + (tc > 1 ? '(×'+tc+')' : ''));
      if (ac > 0) uniAbstractHits.push(w + (ac > 1 ? '(×'+ac+')' : ''));
    }
  }
  for (var j = 0; j < techBigrams.length; j++) {
    var bw = techBigrams[j];
    var bweight = (idfWeights[bw] || 0.5) * 0.5;
    techDenominator += bweight;
    var bc = countWord(title, bw);
    var bca = countWord(abstract, bw);
    if (bc + bca > 0) {
      techNumerator += (bc * 1.5 + bca * 1.0) * bweight;
    }
  }
  var technicalScore = techDenominator > 0 ? techNumerator / techDenominator : 0;

  // ── Combined score for sorting (pre-Layer-3) ──
  // Plant penalty (Lv.0) applied to score
  var baseScore = technicalScore;
  if (plantPenalty) baseScore *= 0.3;

  return {
    score: baseScore,
    technicalScore: technicalScore,
    keywordHits: {titleHits: uniTitleHits, abstractHits: uniAbstractHits},
    unigramScore: techNumerator,
    bigramScore: 0,
    baseScore: technicalScore,
    plantPenalty: plantPenalty,
    plantHits: plantHits,
    plantTerms: gatePlantTerms,
    speciesLevel: speciesLevel,
    speciesBonus: speciesBonus,
    gateMethod: gateMethod,
    scientificName: sciName,
    techDenominator: techDenominator,
    techNumerator: techNumerator,
    idfWeights: idfWeights
  };
}

// ── Shared: identify plant-specific terms (genus/species names) ──
var GENERIC_ACADEMIC_TERMS = new Set([
  'tissue', 'culture', 'micropropagation', 'propagation',
  // NOTE: 'cutting'/'cuttings' intentionally NOT generic — core horticulture terms
  'rooting', 'auxin', 'treatment', 'effect', 'effects', 'results', 'result',
  'study', 'studies', 'research', 'method', 'methods', 'analysis',
  'plant', 'plants', 'cell', 'cells', 'growth', 'development',
  'concentration', 'response', 'compared', 'different', 'during',
  'using', 'based', 'production', 'regeneration', 'vitro', 'review',
  'advances', 'recent', 'through', 'culture', 'tissue',
  // Environmental/abiotic stress terms (too generic to be plant-specific)
  'stress', 'temperature', 'salinity', 'drought', 'heat', 'cold',
  'freezing', 'chilling', 'tolerance', 'resistance', 'sensitive',
  'abiotic', 'biotic', 'environmental', 'climate', 'change',
  // Common modifiers and measurements
  'high', 'low', 'increased', 'decreased', 'reduced', 'enhanced',
  'content', 'level', 'activity', 'capacity', 'accumulation',
  'antioxidant', 'oxidative', 'enzyme', 'protein', 'gene',
  // Agricultural generalities
  'crop', 'crops', 'species', 'cultivar', 'genotype', 'yield',
  'mitigation', 'alleviation', 'amelioration', 'improvement',
  'quality', 'parameter', 'condition', 'factor',
  // NOTE: Chemical/treatment names intentionally NOT here.
  // They ARE query-specific keywords that should be weighted heavily.
  // E.g., "salicylic" in "水楊酸對插穗抗高溫逆境的影響" is a core search term.
]);

// ── Known plant name set (built from glossary + plant families) ──
var KNOWN_PLANT_NAMES = (function() {
  var s = new Set();
  Object.keys(PLANT_FAMILIES).forEach(function(k) { s.add(k.toLowerCase()); });
  PLANT_NAME_KEYS.forEach(function(k) {
    var v = (ZH_EN_GLOSSARY[k] || '').toLowerCase().split(/\s+/);
    v.forEach(function(w) { if (w.length >= 4) s.add(w); });
  });
  Object.keys(ZH_EN_GLOSSARY).forEach(function(k) {
    var v = ZH_EN_GLOSSARY[k];
    if (/[A-Z]/.test(v)) {
      v.toLowerCase().split(/\s+/).forEach(function(w) { if (w.length >= 4) s.add(w); });
    }
  });
  return s;
})();

function extractPlantTerms(keywords) {
  var plantTerms = [];
  for (var i = 0; i < keywords.length; i++) {
    var w = keywords[i];
    if (w.length >= 4 && KNOWN_PLANT_NAMES.has(w)) plantTerms.push(w);
  }
  return plantTerms;
}

function isDirectlyRelevant(paper, queryKeywords) {
  // AI explicitly said "no plant" → all papers are relevant (tech query)
  if (queryKeywords._scientificNameExplicitNone) return true;

  // Scientific name check (genus+species) — strict
  var sciName = queryKeywords._scientificName;
  if (sciName && sciName.genus) {
    var text = ((paper.title || '') + ' ' + (paper.abstract || '')).toLowerCase();
    if (text.indexOf(sciName.genus) !== -1) return true;
    if (sciName.species && text.indexOf(sciName.species) !== -1) return true;
    return false;
  }
  // Fallback: discriminating terms (Tier 1+2 from glossary/capitals)
  var plantTerms = queryKeywords._plantTerms;
  if (plantTerms && plantTerms.length > 0) {
    var text2 = ((paper.title || '') + ' ' + (paper.abstract || '')).toLowerCase();
    for (var i = 0; i < plantTerms.length; i++) {
      if (text2.indexOf(plantTerms[i]) !== -1) return true;
    }
    return false;
  }
  // No plant terms and no scientific name → all papers pass (neutral)
  return true;
}

// ── Plant term extraction for species gate (Tier 1+2 only, no whitelist dependency) ──
// Tier 1: KNOWN_PLANT_NAMES (glossary + scientific names from ZH_EN_GLOSSARY)
// Tier 2: Capital-letter heuristic (unlisted scientific names e.g. Quinoa, Episcia)
// Tier 3 is intentionally NOT used for gate decisions — it catches lowercase common names
//   (soybean, rice) but also catches non-plant terms (deficit, drought), making it
//   unsuitable for binary gate decisions. Use the neutral fallback instead.
// Returns empty array when no plant terms detected → gate should not activate.
function extractDiscriminatingTerms(primaryQuery, fallbackQuery) {
  var sourceForTerms = (primaryQuery && !hasChinese(primaryQuery)) ? primaryQuery : (fallbackQuery || primaryQuery || '');
  var rawWords = sourceForTerms.split(/\s+/).filter(function(w) { return w.length >= 4; });
  var lowerWords = rawWords.map(function(w) { return w.toLowerCase(); });

  // Tier 1: glossary / known plant names
  var terms = lowerWords.filter(function(w) { return KNOWN_PLANT_NAMES.has(w); });

  // Tier 2: capitalized words → likely scientific names
  if (terms.length === 0) {
    terms = rawWords.filter(function(w) { return /[A-Z]/.test(w); }).map(function(w) { return w.toLowerCase(); });
  }

  // No Tier 3 — when both Tier 1 and Tier 2 are empty, return empty.
  // The gate treats empty plantTerms as "no plant detected" → gate not activated.
  return terms;
}

// ── Scientific name extraction (Latin binomial: Genus species) ──
// Extracts "Genus species" from glossary values (e.g. 'soybean Glycine max' → {genus:'Glycine', species:'max'})
function getGlossaryScientificName(chineseText) {
  if (!chineseText) return null;
  var pks = Array.from(PLANT_NAME_KEYS).sort(function(a, b) { return b.length - a.length; });
  for (var i = 0; i < pks.length; i++) {
    if (chineseText.indexOf(pks[i]) !== -1) {
      var val = ZH_EN_GLOSSARY[pks[i]] || '';
      var m = val.match(/([A-Z][a-z]{2,})\s+([a-z]{2,})/);
      if (m) return { genus: m[1].toLowerCase(), species: m[2].toLowerCase(), source: 'glossary' };
      // Try single capitalized word (genus only, e.g. 'Episcia', 'Rhododendron')
      var m2 = val.match(/([A-Z][a-z]{2,})/);
      if (m2) return { genus: m2[1].toLowerCase(), species: null, source: 'glossary-genus-only' };
    }
  }
  return null;
}

// Parse "(Genus species)" from AI response text
function parseScientificNameFromAI(text) {
  if (!text) return null;
  // Check for explicit "(none)" — AI says no plant specified
  if (/\(none\)/i.test(text)) return { genus: null, species: null, source: 'ai-none' };
  // Match parenthesized Latin binomial: (Glycine max), (Litsea cubeba), etc.
  // Accept both uppercase and lowercase genus (AI may return lowercase)
  var m = text.match(/\(([A-Za-z][a-z]{2,})\s+([a-z]{2,})\)/);
  if (m) return { genus: m[1].toLowerCase(), species: m[2].toLowerCase(), source: 'ai' };
  // Try genus-only: (Episcia) — also case-insensitive
  var m2 = text.match(/\(([A-Za-z][a-z]{2,})\)/);
  if (m2) return { genus: m2[1].toLowerCase(), species: null, source: 'ai-genus-only' };
  return null;
}

// Strip scientific name annotation from AI keywords (keep only the keywords)
function stripScientificNameAnnotation(text) {
  if (!text) return text;
  return text.replace(/\s*\(none\)\s*/gi, ' ').replace(/\s*\([A-Za-z][a-z]+\s+[a-z]{2,}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function filterRelevant(papers, scoreQuery, openalexQuery, scientificName, scientificNameExplicitNone) {
  var keywords = extractQueryKeywords(scoreQuery);
  keywords._scientificName = scientificName || null;
  keywords._scientificNameExplicitNone = scientificNameExplicitNone || false;
  if (keywords.unigrams.length === 0 && keywords.bigrams.length === 0) return papers;

  // Compute IDF weights: keywords appearing in FEWER papers get HIGHER weight.
  // (Used for display only — actual scoring uses uniform weight 1.0 per 方案B)
  var N = papers.length;
  var keywordFreq = {};
  var allTerms = keywords.unigrams.concat(keywords.bigrams);
  for (var ti = 0; ti < allTerms.length; ti++) {
    keywordFreq[allTerms[ti]] = 0;
  }
  for (var pi = 0; pi < papers.length; pi++) {
    var text = ((papers[pi].title || '') + ' ' + (papers[pi].abstract || '')).toLowerCase();
    for (var ki = 0; ki < allTerms.length; ki++) {
      if (text.indexOf(allTerms[ki]) !== -1) {
        keywordFreq[allTerms[ki]]++;
      }
    }
  }
  var idfWeights = {};
  for (var kw in keywordFreq) {
    var freq = Math.max(keywordFreq[kw], 1);
    var idf = Math.log(N / freq);
    idfWeights[kw] = idf * idf + 0.3;  // Square IDF → rare words dominate, +0.3 floor
  }
  keywords._idfWeights = idfWeights;
  // Three-tier discriminating term extraction (no whitelist dependency)
  // scoreQuery always has English keywords; openalexQuery may fall back to Chinese
  keywords._gatePlantTerms = extractDiscriminatingTerms(openalexQuery, scoreQuery);
  keywords._plantTerms = keywords._gatePlantTerms;
  keywords._techTerms = keywords.unigrams.filter(function(w) { return keywords._gatePlantTerms.indexOf(w) === -1; });

  var scored = papers.map(function(p) {
    var sr = scoreRelevance(p, keywords);
    p._relevance = sr.technicalScore;  // V4: technicalScore is the primary relevance signal
    p._technicalScore = sr.technicalScore;
    p._keywordHits = sr.keywordHits;
    p._plantPenalty = sr.plantPenalty;
    p._plantHits = sr.plantHits;
    p._speciesLevel = sr.speciesLevel;
    p._speciesBonus = sr.speciesBonus;
    p._gateMethod = sr.gateMethod;
    p._scientificName = sr.scientificName;
    p._unigramScore = sr.unigramScore;
    p._bigramScore = sr.bigramScore;
    p._baseScore = sr.technicalScore;
    p._techNumerator = sr.techNumerator;
    p._techDenominator = sr.techDenominator;
    p._idfWeights = idfWeights;
    return p;
  });

  // Sort by relevance (highest first)
  scored.sort(function(a, b) { return b._relevance - a._relevance; });

  // No hard threshold — Reranker sorts by composite score.
  // Plant gate (isDirectlyRelevant) blocks unrelated species.
  return scored;
}

// ── Content Quality Filter ──
// Soft rules (not hard exclusions). Old but relevant papers are kept with warnings.
// Rule 1: Papers SHOULD have either an abstract or a classifiable title (soft preference).
// Rule 2: Papers are sorted by composite rank score (relevance × 0.85 + citation × 0.08 + recency × 0.07).
// Rule 3: Pre-2000 papers are kept but flagged — niche topics often have core literature from 1970s-1990s.

function hasClassifiableContent(paper) {
  // A paper passes if it has ANY usable text we can classify or show.
  // Abstracts are already cleaned via cleanApiText() at ingestion.
  var abstract = paper.abstract || '';
  if (abstract.length > 30) return true;

  var title = paper.title || '';
  // Normal academic title (most are 40+ chars) — always keep
  if (title.length >= 25) return true;

  // Short title but with negative-result signal
  var TITLE_SIGNALS = /\b(negative|null|ineffective|unsuccessful|failure|failed|no effect|does not|did not|not effective|without effect|no benefit|no significant|phytotoxic|low rooting|poor rooting|recalcitrant)\b/i;
  return TITLE_SIGNALS.test(title);
}

function getPaperAgeWarning(year) {
  // Return a warning label for old papers, or null if recent
  if (!year) return null;
  if (year < 1980) return '經典文獻（' + year + '年）';
  if (year < 2000) return '較舊文獻（' + year + '年）';
  return null;
}

function filterByYearAndContent(papers) {
  var filtered = [];
  var excludedNoContent = 0;
  var oldPaperYears = [];  // Track old papers for reporting

  for (var i = 0; i < papers.length; i++) {
    var p = papers[i];

    // Soft rule: exclude papers with truly no classifiable content
    // (no abstract AND no recognizable title signal)
    if (SEARCH_CONFIG.requireContent && !hasClassifiableContent(p)) {
      excludedNoContent++;
      continue;
    }

    // Flag old papers but KEEP them
    if (p.year && p.year < 2000) {
      p._isOld = true;
      p._ageWarning = getPaperAgeWarning(p.year);
      oldPaperYears.push(p.year);
    }

    filtered.push(p);
  }

  var hasOldPapers = oldPaperYears.length > 0;
  var oldestYear = hasOldPapers ? Math.min.apply(null, oldPaperYears) : null;

  // Sort by composite rank score (relevance × 0.85 + citation × 0.08 + recency × 0.07)
  // Falls back to _relevance, then year if rank score not yet computed
  filtered.sort(function(a, b) {
    var sa = a._rankScore;
    var sb = b._rankScore;
    if (sa !== undefined && sb !== undefined) return sb - sa;
    // Fallback: if reranker hasn't run yet
    var ra = a._relevance || 0;
    var rb = b._relevance || 0;
    if (ra !== rb) return rb - ra;
    var ya = a.year || 0;
    var yb = b.year || 0;
    return yb - ya;
  });

  return {
    papers: filtered,
    excludedNoContent: excludedNoContent,
    hasOldPapers: hasOldPapers,
    oldestYear: oldestYear,
    oldPaperCount: oldPaperYears.length,
  };
}

// ── Query Expansion (inspired by SPAR tree search) ──
// Generate 2-3 variant queries and search in parallel.
// Without Gemini: use synonym substitution from glossary + broader query.
// With Gemini: AI generates smart variant queries.

function generateQueryVariants(query, searchQuery) {
  var variants = [searchQuery];
  var words = searchQuery.split(/\s+/);
  if (words.length <= 3) return variants;

  // Variant: take first word + last 2 words.
  // "Gloxinia Sinningia trait inheritance" → "Gloxinia trait inheritance"
  // The middle words are often the most specific/restrictive synonyms.
  var broader = [words[0], words[words.length-2], words[words.length-1]].join(' ');
  if (broader !== searchQuery && variants.indexOf(broader) === -1) {
    variants.push(broader);
  }

  return variants;
}

async function searchWithVariants(openalexQuery, crossrefQuery, limit) {
  var oaVariants = generateQueryVariants('', openalexQuery);
  var crVariants = generateQueryVariants('', crossrefQuery);

  var allResults = [];
  // OpenAlex variants — simple core keywords (skip first = main search already done)
  for (var v = 1; v < Math.min(oaVariants.length, 3); v++) {
    try {
      var oaR = await searchOpenAlex(oaVariants[v], Math.ceil(limit / 2));
      if (oaR && oaR.length > 0) allResults = allResults.concat(oaR);
    } catch(e) { /* optional */ }
  }
  // CrossRef variants — rich AI keywords
  for (var v = 1; v < Math.min(crVariants.length, 3); v++) {
    try {
      var crR = await searchCrossRef(crVariants[v], Math.ceil(limit / 2));
      if (crR && crR.length > 0) allResults = allResults.concat(crR);
    } catch(e) { /* optional */ }
  }
  return allResults;
}

// ── Simple keyword search (keywords pre-generated by combined Gemini call) ──

async function searchWithKeywords(keywords) {
  if (!keywords) return [];
  // Split: first 4 words → OpenAlex (simple core), all words → CrossRef (rich bibliographic)
  var words = keywords.split(/\s+/);
  var simpleKeywords = words.slice(0, Math.min(4, words.length)).join(' ');
  var results = [];
  try {
    var [oaR, crR] = await Promise.allSettled([
      searchOpenAlex(simpleKeywords, 8),
      searchCrossRef(keywords, 8),
    ]);
    [oaR, crR].forEach(function(r) {
      if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
        results = results.concat(r.value);
      }
    });
  } catch(e) { /* optional */ }
  for (var i = 0; i < results.length; i++) {
    results[i]._fromAISuggest = true;
  }
  return results;
}

// ── Gemini-powered "建議觀看" second search ──
// Instead of just using leftover papers from the main search,
// Gemini generates smart keywords for related plants (same family,
// similar growth habit) + same technique, then we search again.

async function searchSuggestedPapers(originalQuery, mainSearchQuery) {
  var apiKey = getApiKey();
  if (!apiKey) return [];

  // Ask Gemini for related search keywords
  var prompt = 'Given this academic search query: "' + originalQuery + '"\n\n' +
    'The main search found few or no directly relevant papers.\n' +
    'Generate 4-6 English keywords to find papers about SIMILAR plants (same family, ' +
    'similar growth habit, similar use/purpose) using the SAME technique.\n\n' +
    'RULES:\n' +
    '1. Identify the plant from the query → find its taxonomic family → suggest the family name.\n' +
    '2. Suggest related ornamental/crop plants with similar growth habits.\n' +
    '3. Include the technique keywords from the original query.\n' +
    '4. Return ONLY space-separated English keywords. No sentences.\n\n' +
    'Examples:\n' +
    '  "喜蔭花的組織培養" → Gesneriaceae African violet Streptocarpus tissue culture micropropagation ornamental\n' +
    '  "百合花球根真菌感染" → Lilium Tulipa bulb fungal disease ornamental geophytes\n' +
    '  "馬告扦插發根" → Lauraceae Cinnamomum essential oil cutting propagation rooting\n\n' +
    'Keywords:';

  var keywords = '';
  try {
    keywords = await callAI(prompt, 8000);
    if (!keywords) return [];
    keywords = keywords.trim().toLowerCase();
  } catch(e) {
    _logAIError('suggest-keywords', e.message || 'fetch error');
    return [];
  }

  if (!keywords) return [];

  // Search with Gemini's suggested keywords
  var results = [];
  try {
    var [oaR, crR] = await Promise.allSettled([
      searchOpenAlex(keywords, 8),
      searchCrossRef(keywords, 8),
    ]);

    [oaR, crR].forEach(function(r) {
      if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
        results = results.concat(r.value);
      }
    });

    // Remove papers that are already in the main results
    // (we'll dedup later in the orchestrator)
  } catch(e) {
    // Second search is optional — failure is OK
  }

  // Mark these as AI-suggested and store the keywords used
  for (var i = 0; i < results.length; i++) {
    results[i]._fromAISuggest = true;
  }
  results._keywords = keywords;  // Attach metadata to the array

  return results;
}

// ── V5 Reranker: species match × 0.45 + technical × 0.35 + citation × 0.10 + recency × 0.10 ──
// KEY INSIGHT (2026-07-21): species match provides the FLOOR — a paper about the RIGHT
// plant should always outrank a paper about the WRONG plant, even if it doesn't use
// our glossary's exact keywords. This makes the system robust against glossary gaps.
//   speciesMatchScore: 0-1 normalized from species level
//     Lv.2 + all-in-title → 1.0  (perfect match)
//     Lv.2 mixed           → 0.8
//     Lv.1                 → 0.5  (genus only or partial)
//     Lv.0                 → 0.0  (wrong plant — already ×0.3 in techScore)
function rerankPapers(papers) {
  if (papers.length <= 1) return papers;
  var currentYear = new Date().getFullYear();
  for (var i = 0; i < papers.length; i++) {
    var p = papers[i];
    var year = p.year || currentYear;
    var age = Math.max(0, currentYear - year);
    var recencyScore = Math.max(0, 1 - age / 20);
    var technicalScore = p._technicalScore || 0;
    var citations = p.citationCount || 0;
    var citationScore = Math.min(citations / 50, 1.0);
    var speciesLevel = p._speciesLevel || 0;
    var speciesBonus = p._speciesBonus || 0;
    // Normalize species match to 0-1: gives right-plant papers a guaranteed floor
    var speciesMatchScore = 0;
    if (speciesLevel === 2) {
      speciesMatchScore = speciesBonus >= 3.0 ? 1.0 : 0.8;  // all-in-title vs title+abstract
    } else if (speciesLevel === 1) {
      speciesMatchScore = 0.5;
    }
    // speciesLevel 0 → speciesMatchScore 0 (wrong plant)
    // V5 formula: species drives ranking, technique refines ordering
    p._rankScore = speciesMatchScore * 0.45 + technicalScore * 0.35 + citationScore * 0.10 + recencyScore * 0.10;
    // Store breakdown for transparency
    p._scoreBreakdown = {
      speciesMatchScore: speciesMatchScore,
      technicalScore: technicalScore,
      citationScore: citationScore,
      recency: recencyScore,
      speciesBonus: speciesBonus,
      rankScore: p._rankScore,
      year: year, age: age, citations: citations,
      keywordHits: p._keywordHits || {titleHits:[],abstractHits:[]},
      plantPenalty: p._plantPenalty || false,
      plantHits: p._plantHits || [],
      speciesLevel: speciesLevel,
      unigramScore: p._unigramScore || 0,
      techNumerator: p._techNumerator || 0,
      techDenominator: p._techDenominator || 1,
      idfWeights: p._idfWeights || {},
    };
  }
  papers.sort(function(a, b) { return (b._rankScore || 0) - (a._rankScore || 0); });
  return papers;
}

// ── Layer 3: Adaptive Gap Detection (V4) ──
// Finds the natural cutoff between "relevant" and "noise" papers
// using the largest relative drop in technicalScore. No fixed threshold.
function findAdaptiveGap(papers) {
  // Only consider papers that pass Layer 1 (Lv.1 or Lv.2, not Lv.0)
  var candidates = papers.filter(function(p) {
    return (p._speciesLevel || 0) >= 1 && p._technicalScore !== undefined;
  });
  if (candidates.length < 3) return candidates;  // Too few to gap

  // Sort by technicalScore desc
  candidates.sort(function(a, b) { return (b._technicalScore || 0) - (a._technicalScore || 0); });

  // Find max relative gap
  var maxGap = 0, cutIdx = candidates.length;
  for (var i = 0; i < candidates.length - 1; i++) {
    var scoreAbove = candidates[i]._technicalScore || 0;
    var scoreBelow = candidates[i + 1]._technicalScore || 0;
    if (scoreAbove <= 0) continue;
    var gap = scoreAbove - scoreBelow;
    var relGap = gap / scoreAbove;
    if (relGap > maxGap && relGap >= 0.30) {
      maxGap = relGap;
      cutIdx = i + 1;  // Papers above (incl i) pass, below are cut
    }
  }

  // If no significant gap found, keep all
  if (maxGap < 0.30) return candidates;

  // Return papers above the cut point
  var passed = candidates.slice(0, cutIdx);
  // Store gap info for display
  passed._gapInfo = { cutIdx: cutIdx, maxGap: maxGap, totalCandidates: candidates.length, cutScore: (candidates[cutIdx - 1] ? candidates[cutIdx - 1]._technicalScore : 0) };
  return passed;
}

// ── Fallback: generate basic why_matters from paper metadata ──
// Hard gate: every displayed paper MUST have why_matters.
// If Gemini didn't produce it, we fill from title + journal + year.

var _aiRunning = false;
var _aiRunning = false;
function buildFallbackWhyMatters(paper) {
  var journal = paper.journal || '學術期刊';
  var year = paper.year || '';
  var yearStr = year ? '（' + year + '年）' : '';
  if (!getApiKey()) return '此論文發表於 ' + journal + yearStr + '。設定 AI API key 或安裝 Ollama 可獲得 AI 中文摘要。';
  return '此論文發表於 ' + journal + yearStr + '。AI 分析中…';
}

// ── Query Analysis: suggest broader searches when results are sparse ──
function suggestBroaderQueries(query, papers) {
  // When very few papers are found on a niche topic,
  // suggest searching for the family/genus or broader category
  var suggestions = [];
  var queryLower = query.toLowerCase();

  // Domain-specific suggestions based on query content
  if (queryLower.indexOf('喜蔭花') !== -1 || queryLower.indexOf('episcia') !== -1) {
    suggestions.push('苦苣苔科 Gesneriaceae');
    suggestions.push('室內觀葉植物組織培養 indoor foliage plant tissue culture');
    suggestions.push('flame violet propagation');
  }
  if (queryLower.indexOf('組織培養') !== -1 || queryLower.indexOf('tissue culture') !== -1) {
    if (suggestions.indexOf('in vitro propagation micropropagation') === -1) {
      suggestions.push('in vitro propagation micropropagation');
    }
  }
  // Generic suggestion for niche plant queries
  if (papers.length <= 5 && suggestions.length === 0) {
    // Try to extract the genus/species name and suggest broader terms
    var engParts = queryLower.match(/[a-z]{3,}/g) || [];
    if (engParts.length > 0) {
      suggestions.push('broader taxonomic group or related genera');
    }
  }

  return suggestions;
}

// ── Deduplication ──

function deduplicatePapers(allPapers) {
  var merged = [];
  var seenDOIs = {};
  var mergedTitles = [];  // for Jaccard check

  for (var i = 0; i < allPapers.length; i++) {
    var p = allPapers[i];
    var doi = p.doi;

    // Exact DOI match
    if (doi && seenDOIs[doi]) {
      // Merge: enrich with data from the duplicate
      var existing = seenDOIs[doi];
      if (!existing.abstract && p.abstract) existing.abstract = p.abstract;
      if (!existing.journal && p.journal) existing.journal = p.journal;
      if (!existing.year && p.year) existing.year = p.year;
      if (!existing.citationCount && p.citationCount) existing.citationCount = p.citationCount;
      // Track which sources found this paper
      if (existing.source !== p.source) {
        existing.sources = existing.sources || [existing.source];
        if (existing.sources.indexOf(p.source) === -1) existing.sources.push(p.source);
      }
      continue;
    }

    // Title Jaccard similarity check
    var isDuplicate = false;
    for (var j = 0; j < mergedTitles.length; j++) {
      if (p.title && jaccardSimilarity(p.title, mergedTitles[j].title) >= 0.7) {
        isDuplicate = true;
        var existing = mergedTitles[j];
        if (!existing.abstract && p.abstract) existing.abstract = p.abstract;
        if (!existing.journal && p.journal) existing.journal = p.journal;
        if (!existing.doi && p.doi) existing.doi = p.doi;
        if (existing.source !== p.source) {
          existing.sources = existing.sources || [existing.source];
          if (existing.sources.indexOf(p.source) === -1) existing.sources.push(p.source);
        }
        break;
      }
    }
    if (isDuplicate) continue;

    // New paper
    if (doi) seenDOIs[doi] = p;
    merged.push(p);
    mergedTitles.push(p);
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════
// SECTION 4: Negative Result Classifier (Keyword Pattern Matching)
// ═══════════════════════════════════════════════════════════
//
// Design: inspired by NegativeResultDetector (SciBERT classifier),
// but implemented in pure JS for zero-dependency browser use.
// Uses weighted keyword patterns with confidence scoring.

var NEGATIVE_PATTERNS = {
  // ── Strong signals (weight 4): clear negative/null language ──
  strong: [
    { pattern: /\bno significant (effect|difference|impact|influence|response|change|improvement|benefit|correlation|association|relationship)\b/i, label: 'no-significant' },
    { pattern: /\b(did not|does not|failed to|was not able to|could not) (significantly )?(affect|improve|increase|decrease|reduce|enhance|promote|stimulate|induce|show|demonstrate|produce|yield|result in)\b/i, label: 'did-not-affect' },
    { pattern: /\b(null|negative) (result|finding|effect|outcome|response)\b/i, label: 'null-result' },
    { pattern: /\b(ineffective|unsuccessful) (in|for|at|as)\b/i, label: 'ineffective-for' },
    { pattern: /\b(contrary to|opposite to|in contrast to) (our |the )?(hypothesis|expectation|prediction|assumption)\b/i, label: 'contrary-hypothesis' },
    { pattern: /\b(failed|unable) to (replicate|reproduce|confirm|detect|find|observe|demonstrate)\b/i, label: 'failed-replicate' },
    { pattern: /\bdoes not (appear|seem) to (be|have|play|affect|influence|contribute)\b/i, label: 'does-not-appear' },
    { pattern: /\bno (clear|obvious|apparent|detectable|measurable|consistent) (effect|impact|difference|response|pattern|trend|benefit)\b/i, label: 'no-clear-effect' },
    { pattern: /\b(absence|lack) of (any |a |significant )?(effect|response|impact|difference|correlation|relationship|benefit)\b/i, label: 'absence-of-effect' },
  ],

  // ── Moderate signals (weight 2): suggestive of null/negative ──
  moderate: [
    { pattern: /\bnot (statistically |significantly )?different (from|between|among|across)\b/i, label: 'not-different' },
    { pattern: /\b(p >|p>|p =|p=)\s*0\.0[5-9]/i, label: 'p-gt-005' },
    { pattern: /\b(inversely|negatively) (correlated|associated|related) with\b/i, label: 'neg-correlation' },
    { pattern: /\b(phytotoxic|toxic|adverse|harmful|detrimental|deleterious) (effect|impact|response|activity)\b/i, label: 'toxicity' },
    // Note: "inhibitory" REMOVED from toxicity — in microbiology/pharmacology,
    // "inhibitory effect on bacteria" is a POSITIVE result, not a negative one.
    // Inhibitory is only negative when it inhibits PLANT GROWTH/ROOTING:
    { pattern: /\binhibitory (effect|impact) on (plant |root |shoot |cutting |seedling |growth |development |propagation)\b/i, label: 'plant-inhibitory' },
    { pattern: /\b(mortality|survival rate) (increased|was|were) (higher|observed|noted|recorded) (in|at|with|for)\b/i, label: 'mortality-increase' },
    { pattern: /\b(treatment|application|supplementation|addition) (had |showed |demonstrated |exhibited |resulted in )?no (effect|impact|benefit|advantage|improvement|difference)\b/i, label: 'treatment-no-effect' },
    { pattern: /\b(not recommended|should not be used|cannot be recommended) (for|as|in|due to|because)\b/i, label: 'not-recommended' },
    { pattern: /\b(without|with no) (any |a |significant )?(effect|impact|benefit|improvement|success|response)\b/i, label: 'without-effect', _weight: 1 },
    { pattern: /\b(little|limited|minimal|marginal|negligible) (effect|impact|benefit|improvement|success|response|influence)\b/i, label: 'limited-effect', _weight: 1 },
    { pattern: /\bdo not (support|confirm|provide evidence for|substantiate|validate)\b/i, label: 'do-not-support' },
    { pattern: /\bthese (results|findings|data) (do not|fail to|did not) (support|confirm|provide)\b/i, label: 'results-not-support' },
    { pattern: /\bunexpectedly,?\b/i, label: 'unexpectedly', _weight: 1 },
  ],

  // ── Weak signals (weight 1): context-dependent ──
  weak: [
    { pattern: /\b(however|nevertheless|nonetheless),? (the|no|our|this|these) (effect|result|finding|treatment|data)\b/i, label: 'however-effect' },
    { pattern: /\b(surprisingly|interestingly),? (the|no|our|this|these)\b/i, label: 'surprisingly' },
    { pattern: /\b(further|more|additional) (research|studies|investigation|work) (is|are|may be) (needed|required|necessary|warranted)\b/i, label: 'more-research-needed' },
    { pattern: /\b(only|just) (a |the |one |)(marginally?|slightly?|weakly|modestly?) (significant|effective|successful)\b/i, label: 'only-marginally' },
    { pattern: /\b(call|argue|suggest) (for|that) (more |further |additional |)(research|studies|investigation)\b/i, label: 'call-for-research' },
    { pattern: /\bit remains (unclear|unknown|uncertain|to be determined) whether\b/i, label: 'remains-unclear' },
    { pattern: /\b(contradictory|conflicting|inconsistent|mixed) (results|findings|evidence|data|outcomes)\b/i, label: 'conflicting-results' },
    { pattern: /\bresults (were|are|remain) (inconclusive|ambiguous|equivocal|uncertain)\b/i, label: 'inconclusive' },
  ],

  // ── Domain-specific: plant/cutting propagation ──
  domain_plant: [
    { pattern: /\b(low|poor|reduced|limited|minimal) (rooting|survival|establishment|cuttings survival)\b/i, label: 'poor-rooting' },
    { pattern: /\b(recalcitran|difficult.to.root|hard.to.root|difficult.to.propagate)\b/i, label: 'recalcitrant' },
    { pattern: /\b(callus formation|callusing) (without|but no|yet no|without subsequent) (root|rooting|adventitious root)\b/i, label: 'callus-no-root' },
    { pattern: /\b(low|poor) (rooting|survival) (rate|percentage|frequency)\b/i, label: 'low-rate' },
    { pattern: /\b(no|zero|absence of) (root|rooting|adventitious root|AR) (formation|initiation|development|emergence)\b/i, label: 'no-root-formation' },
  ],

  // ── NegativeResultDetector-inspired patterns (SciBERT, 86.4% accuracy) ──
  // These patterns capture linguistic signals that the SciBERT model learned
  // from 1,900 annotated clinical psychology abstracts, adapted for plant sciences.
  ndr_inspired: [
    // Methodological hedging (weight 2) — studies that are tentative
    { pattern: /\b(preliminary|exploratory|pilot) (study|trial|experiment|investigation|analysis|data|results|findings)\b/i, label: 'preliminary-study' },
    { pattern: /\bsmall sample (size|number)\b/i, label: 'small-sample' },
    { pattern: /\b(limited by|cautioned by|constrained by) (the |a |)(small|limited|low|insufficient)\b/i, label: 'study-limitation' },
    { pattern: /\b(further|more|additional) (research|investigation|work|studies) (is|are|will be) (needed|required|necessary|warranted|essential)\b/i, label: 'more-research' },
    // Uncertainty markers (weight 1)
    { pattern: /\b(inconsistent|conflicting|contradictory|mixed) (with|results|findings|evidence|data)\b/i, label: 'inconsistent' },
    { pattern: /\bwarrants? (further|cautious|careful) (investigation|interpretation|study|research)\b/i, label: 'warrants-caution' },
    { pattern: /\b(unclear|uncertain|ambiguous|equivocal) (whether|if|as to|role|effect|results|findings)\b/i, label: 'unclear' },
    // Negative evidence (weight 2)
    { pattern: /\bno (convincing|compelling|consistent|reliable|credible) (evidence|support|data) (for|of|that|was)\b/i, label: 'no-convincing-evidence' },
    { pattern: /\b(insufficient|inadequate|lacking) (evidence|data|support|information) (to|for|in)\b/i, label: 'insufficient-evidence' },
    { pattern: /\b(does not|do not|did not) (appear|seem|necessarily) (to |)(be|have|represent|indicate|imply|suggest|support|confirm|provide)\b/i, label: 'does-not-appear' },
    // Failed attempts (weight 2)
    { pattern: /\b(attempts?|efforts?|endeavors?) (to|were) (unsuccessful|failed|not successful|fruitless)\b/i, label: 'failed-attempts' },
    { pattern: /\b(despite|notwithstanding|in spite of) (the |a |)(attempt|effort|trial|experiment)\b/i, label: 'despite-attempt' },
  ],
};

function classifyPaper(paper) {
  // Classify a single paper as likely negative/null or not
  // Returns: { isNegative: bool, score: number, confidence: 'high'|'medium'|'low'|'none', signals: [...] }

  var text = '';
  if (paper.abstract) text += paper.abstract + ' ';
  if (paper.title) text += paper.title;

  if (!text.trim()) {
    return { isNegative: false, score: 0, confidence: 'none', signals: [], reason: 'no-text' };
  }

  var totalScore = 0;
  var signals = [];

  // ── Title-first check (before abstract patterns) ──
  // Many papers only have title (no abstract in search results).
  // Title signals are strong indicators and must be checked BEFORE abstract patterns.
  var titleText = paper.title || '';
  var TITLE_NEGATIVE_RE = /\b(negative|null|ineffective|unsuccessful|failure|failed|no effect|does not work|did not|does not|not effective|without effect|no benefit)\b/i;
  var titleNegative = TITLE_NEGATIVE_RE.test(titleText);
  if (titleNegative) {
    totalScore += 3;
    signals.push({ label: 'title-negative', weight: 3 });
  }

  // ── Title POSITIVE check: counterweight for background descriptions ──
  // "A Fungal Extract Promotes Rooting in Litsea cubeba" has "recalcitrant" in its
  // abstract BACKGROUND, not in its FINDING. If title language is clearly positive,
  // the paper is likely reporting a SUCCESS, not a negative result. Raise the
  // negative-classification threshold from 2 to 4 for these papers.
  var TITLE_POSITIVE_RE = /\b(promotes?|enhanc(es?|ing)|improv(es?|ing)|increas(es?|ing)|stimulat(es?|ing)|induc(es?|ing)|optimiz(es?|ing)|effectively?|successfully?|efficient(ly)?|beneficial|positively?)\b/i;
  var titleIsPositive = TITLE_POSITIVE_RE.test(titleText);

  // ── Check strong patterns (weight 4) ──
  NEGATIVE_PATTERNS.strong.forEach(function(entry) {
    if (entry.pattern.test(text)) {
      totalScore += 4;
      signals.push({ label: entry.label, weight: 4 });
    }
  });

  // ── Check moderate patterns (weight 2, or _weight override) ──
  // v36: some patterns downgraded to weight 1 via _weight field —
  // they fire too often on Discussion boilerplate in regular papers.
  NEGATIVE_PATTERNS.moderate.forEach(function(entry) {
    if (entry.pattern.test(text)) {
      var w = entry._weight || 2;
      totalScore += w;
      signals.push({ label: entry.label, weight: w });
    }
  });

  // ── Check weak patterns (weight 1) ──
  NEGATIVE_PATTERNS.weak.forEach(function(entry) {
    if (entry.pattern.test(text)) {
      totalScore += 1;
      signals.push({ label: entry.label, weight: 1 });
    }
  });

  // ── Check domain-specific patterns (weight 3) ──
  NEGATIVE_PATTERNS.domain_plant.forEach(function(entry) {
    if (entry.pattern.test(text)) {
      totalScore += 3;
      signals.push({ label: entry.label, weight: 3, domain: 'plant' });
    }
  });

  // ── Check NDR-inspired patterns (weight 0-1, DOWNGRADED from 1-2) ──
  // v36 (2026-07-12): weights halved — these patterns (from clinical psychology
  // SciBERT training) fire on Discussion-section boilerplate in regular papers
  // ("further research needed", "preliminary study", etc.), causing false positives.
  // Now: only the strongest signals contribute.
  NEGATIVE_PATTERNS.ndr_inspired.forEach(function(entry) {
    if (entry.pattern.test(text)) {
      var w = (/preliminary|small-sample|study-limitation|more-research/i.test(entry.label)) ? 1 : 0;
      if (w > 0) {
        totalScore += w;
        signals.push({ label: entry.label, weight: w, source: 'ndr' });
      }
    }
  });

  // ── COMPUTE RESULTS (AFTER all checks including title) ──
  // Title-positive papers: raise threshold from 3→5 to avoid false positives
  // where "recalcitrant"/"bottleneck" etc. describe the PROBLEM being solved,
  // not the FINDING itself. (e.g. "A Fungal Extract Promotes Rooting in Litsea cubeba")
  // v36 (2026-07-12): default threshold raised 2→3 — weak patterns alone
  // shouldn't trigger negative classification.
  var threshold = titleIsPositive ? 5 : 3;
  var isNegative = totalScore >= threshold;
  var confidence = 'none';
  if (totalScore >= 6) confidence = 'high';
  else if (totalScore >= 3) confidence = 'medium';
  else if (totalScore >= 1) confidence = 'low';
  if (titleIsPositive && isNegative) {
    signals.push({ label: 'title-positive-override', weight: 0, note: 'title positive but abstract score=' + totalScore + ' ≥ ' + threshold });
  }

  return {
    isNegative: isNegative,
    score: totalScore,
    confidence: confidence,
    signals: signals,
    hasAbstract: !!paper.abstract
  };
}

function classifyAllPapers(papers) {
  var results = { regular: [], negative: [], stats: { total: papers.length, classified: 0, negative: 0, noAbstract: 0 } };

  papers.forEach(function(p) {
    var cls = classifyPaper(p);
    p.classification = cls;
    if (cls.hasAbstract) {
      results.stats.classified++;
      if (cls.isNegative) {
        results.stats.negative++;
        results.negative.push(p);
      } else {
        results.regular.push(p);
      }
    } else {
      results.stats.noAbstract++;
      // Papers without abstracts go to regular pool (can't confirm negative)
      results.regular.push(p);
    }
  });

  return results;
}

// ═══════════════════════════════════════════════════════════
// SECTION 5: Gate System
// ═══════════════════════════════════════════════════════════
//
// Each gate is a hard checkpoint. Fail → report + offer retry.
// Inspired by gate_check.py architecture: pre-commit (quick checks)
// then deep verification on demand.

var GATE_DEFS = [
  {
    id: 'search',
    phase: 1,
    label: '🔍 多來源搜尋',
    checks: [
      {
        id: 'sources',
        label: '≥2 個學術來源有回傳結果',
        fn: function(state) { return state.searchStats.sourcesWithResults >= 2; },
        severe: false,
      },
      {
        id: 'total',
        label: '搜尋結果 ≥5 篇論文',
        fn: function(state) { return state.searchStats.totalFound >= 5; },
        severe: true,
      },
      {
        id: 'dedup',
        label: '去重後保留 ≥4 篇不重複論文',
        fn: function(state) { return state.searchStats.afterDedup >= 4; },
        severe: false,
      },
      {
        id: 'quality',
        label: '年份+內容過濾後保留 ≥3 篇可用論文',
        fn: function(state) {
          var after = state.searchStats.afterQuality;
          return after !== undefined ? after >= 3 : true;
        },
        severe: false,
      },
      {
        id: 'year-range',
        label: '搜尋結果覆蓋近年文獻（有新於 2015 年的論文）',
        fn: function(state) { return true; },  // informational only — enforced by sorting
        severe: false,
      },
    ],
  },
  {
    id: 'classify',
    phase: 2,
    label: '🔬 不顯著結果分類',
    checks: [
      {
        id: 'abstracts',
        label: '≥40% 論文有摘要可供分類',
        fn: function(state) {
          var total = state.classifyStats.total || 0;
          if (total === 0) return false;
          var withAbstract = state.classifyStats.classified + (state.classifyStats.noAbstract || 0);
          return (state.classifyStats.classified / total) >= 0.4;
        },
        severe: false,
      },
      {
        id: 'neg-count',
        label: '≥2 篇潛在不顯著結果論文',
        fn: function(state) { return (state.classifyStats.negative || 0) >= 2; },
        severe: false,
      },
    ],
  },
  {
    id: 'verify',
    phase: 3,
    label: '✅ DOI 驗證',
    checks: [
      {
        id: 'doi-presence',
        label: '≥50% 論文有 DOI',
        fn: function(state) {
          var total = state.verifyStats.total || 0;
          if (total === 0) return false;
          return (state.verifyStats.withDOI / total) >= 0.5;
        },
        severe: false,
      },
      {
        id: 'doi-format',
        label: 'DOI 格式正確率 ≥80%',
        fn: function(state) {
          var withDOI = state.verifyStats.withDOI || 0;
          if (withDOI === 0) return true;  // No DOIs to check
          return (state.verifyStats.formatOK / withDOI) >= 0.8;
        },
        severe: true,
      },
      {
        id: 'crossref',
        label: 'CrossRef 驗證通過率 ≥60%（有 DOI 的論文）',
        fn: function(state) {
          var withDOI = state.verifyStats.withDOI || 0;
          if (withDOI === 0) return true;
          return (state.verifyStats.crossrefPass / withDOI) >= 0.6;
        },
        severe: false,
      },
    ],
  },
  {
    id: 'render',
    phase: 4,
    label: '📝 報告完整性',
    checks: [
      {
        id: 'has-direct',
        label: '≥1 篇直接相關文獻（非僅建議觀看）',
        fn: function(state) { return (state.renderStats.directRelevant || 0) >= 1; },
        severe: false,  // Not severe — we can show suggested reading instead
      },
      {
        id: 'has-content',
        label: '所有直接相關論文有基本 metadata（標題+年份+期刊）',
        fn: function(state) { return state.renderStats.allHaveMetadata; },
        severe: false,
      },
      {
        id: 'no-empty-shell',
        label: '無直接相關文獻時，不顯示空殼區段（已顯示警告橫幅）',
        fn: function(state) {
          // If 0 direct results, the warning banner replaces the empty section.
          // This is always true — the render logic handles it.
          return true;
        },
        severe: false,
      },
    ],
  },
];

function GateReporter() {
  this.results = [];
  this.allPassed = true;
  this.warnings = [];
  this.severeFailures = [];
}

GateReporter.prototype.runGate = function(gateDef, state) {
  var gateResult = { id: gateDef.id, label: gateDef.label, phase: gateDef.phase, checks: [], passed: true };
  var self = this;

  gateDef.checks.forEach(function(check) {
    var ok = false;
    try {
      ok = check.fn(state);
    } catch(e) {
      ok = false;
    }
    var checkResult = { id: check.id, label: check.label, ok: ok, severe: check.severe };
    gateResult.checks.push(checkResult);
    if (!ok) {
      gateResult.passed = false;
      if (check.severe) {
        self.severeFailures.push(check.label);
      } else {
        self.warnings.push(check.label);
      }
    }
  });

  this.results.push(gateResult);
  if (!gateResult.passed) this.allPassed = false;
  return gateResult;
};

GateReporter.prototype.canContinue = function() {
  // Can continue if no severe failures
  return this.severeFailures.length === 0;
};

GateReporter.prototype.getSummary = function() {
  return {
    allPassed: this.allPassed,
    severeFailures: this.severeFailures.slice(),
    warnings: this.warnings.slice(),
    gates: this.results,
  };
};

// ═══════════════════════════════════════════════════════════
// SECTION 6: DOI Verification
// ═══════════════════════════════════════════════════════════

async function verifyDOI(doi) {
  if (!doi || doi.trim() === '') return { title: null, verified: false, error: '無 DOI' };

  var clean = doi.trim().replace(/^https?:\/\/doi\.org\//, '');

  if (!isValidDOI(clean)) {
    return { title: null, verified: false, error: 'DOI 格式異常（非標準 DOI）' };
  }

  try {
    var resp = await fetch(CROSSREF_DOI + encodeURIComponent(clean), {
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      return { title: null, verified: false, error: 'CrossRef 查無此 DOI（可能為虛構或未註冊）' };
    }
    var data = await resp.json();
    var msg = data.message;
    if (!msg || !msg.title) {
      return { title: null, verified: false, error: 'CrossRef 無此記錄' };
    }
    return { title: msg.title[0], verified: true };
  } catch(e) {
    return { title: null, verified: false, error: '無法連線 CrossRef（CORS 或網路限制）' };
  }
}

async function verifyAllDOIs(papers, onProgress) {
  var stats = { total: papers.length, withDOI: 0, formatOK: 0, crossrefPass: 0, titleMatch: 0 };
  var verified = [];
  var totalWithDOI = 0;

  // Count papers with DOI
  papers.forEach(function(p) {
    if (p.doi && p.doi.trim()) stats.withDOI++;
  });
  totalWithDOI = stats.withDOI;

  for (var i = 0; i < papers.length; i++) {
    var p = papers[i];

    if (!p.doi || !p.doi.trim()) {
      p.doi_verified = false;
      p.doi_error = '無 DOI';
      verified.push(p);
      continue;
    }

    // Format check
    if (!isValidDOI(p.doi)) {
      p.doi_verified = false;
      p.doi_error = 'DOI 格式異常';
      p.doi_bad_format = true;
      verified.push(p);
      continue;
    }
    stats.formatOK++;

    // CrossRef check
    var v = await verifyDOI(p.doi);
    if (v && v.verified) {
      stats.crossrefPass++;
      // Strict title match: ≥70% of the shorter title's content words
      // must appear in the longer title. Binary — passes or fails.
      var titleMatch = titleWordOverlap(p.title, v.title);
      p.doi_verified = titleMatch >= 0.7;
      p.crossref_title = v.title;
      if (!p.doi_verified) {
        p.doi_error = '🔴 DOI 指向不同論文（標題不符：' + v.title.substring(0, 80) + '）';
      }
      if (p.doi_verified) stats.titleMatch++;
    } else if (v) {
      p.doi_verified = false;
      p.doi_error = v.error || '無法驗證';
    }

    verified.push(p);

    if (onProgress && totalWithDOI > 0) {
      onProgress(i + 1, papers.length);
    }
  }

  return { papers: verified, stats: stats };
}

// ═══════════════════════════════════════════════════════════
// SECTION 7: AI Summarization (Optional Gemini)
// ═══════════════════════════════════════════════════════════

function getApiKey() {
  // Support both old Gemini key and new OpenRouter key storage
  var stored = localStorage.getItem('ai_api_key') || localStorage.getItem('gemini_api_key');
  if (stored && stored.trim()) return stored.trim();
  if (DEMO_KEY && DEMO_KEY.trim()) return DEMO_KEY.trim();
  return null;
}

async function summarizeWithGemini(papers, query) {
  // Build a minimal prompt with real paper data — Gemini only does summarization, NOT search
  var paperList = papers.slice(0, 15).map(function(p, i) {
    var parts = [(i+1) + '. ' + (p.title || 'Untitled')];
    if (p.abstract) parts.push('   Abstract: ' + p.abstract.substring(0, 500));
    if (p.classification && p.classification.isNegative) parts.push('   [CLASSIFIED: potential negative/null result]');
    return parts.join('\n');
  }).join('\n\n');

  var prompt = 'You are a Taiwanese horticulture researcher writing in Traditional Chinese.\n\n' +
    '你是一位台灣園藝領域研究者，使用繁體中文寫作。\n\n' +
    '以下是從 OpenAlex/Semantic Scholar/CrossRef 學術資料庫找到的真實論文。\n' +
    '使用者查詢："' + query + '"\n\n' +
    '論文列表：\n' + paperList + '\n\n' +
    '任務：\n' +
    '1. 為每篇論文撰寫繁體中文摘要（4-6 句，約 80-120 字），包含研究目的、方法、主要發現。請提供足夠細節，讓研究者能判斷是否值得閱讀原文。\n' +
    '2. 為每篇論文撰寫「研究意義」（4-6 句，約 80-120 字）：\n' +
    '   - 不顯著結果論文：具體說明這個失敗能為後續研究者節省什麼實驗材料、時間、經費？\n' +
    '   - 一般論文：這項發現對此領域的具體應用價值是什麼？有哪些限制需要注意？\n' +
    '3. 撰寫一份整合性結論（6-8 句），綜合所有文獻的發現，提出未來研究方向。\n\n' +
    '僅回傳 JSON 物件（每篇摘要必須附上 "p": 論文編號）：\n' +
    '{\n' +
    '  "regular": [{"p": 1, "finding": "4-6 句繁體中文摘要（約 100 字）", "why_matters": "4-6 句研究意義（約 100 字）"}],\n' +
    '  "negative": [{"p": 3, "finding": "...", "why_matters": "..."}],\n' +
    '  "conclusion": "6-8 句整合性結論"\n' +
    '}\n\n' +
    '規則：\n' +
    '1. 每篇摘要必須包含 "p": 論文編號（對應上面列表的數字），不可漏。\n' +
    '2. 每篇論文只能出現在 regular 或 negative 其中一個陣列，不可同時出現在兩處。\n' +
    '3. 不可虛構論文，僅摘要提供的文獻。\n' +
    '4. 若摘要不足以判斷，finding 寫「摘要不足，無法判斷」，並歸入 regular。\n' +
    '5. 論文標題保持原始英文。\n' +
    '6. 請提供足夠細節——付費 API 使用者期望深度分析。\n' +
    '7. 「不顯著結果」的定義（嚴格）：論文的**主要發現**是某方法/藥劑/處理「無效」「不如預期」「沒有顯著差異」或「產生不良副作用」。\n' +
    '   ❌ 不是不顯著結果：論文報告正面發現，只是 Discussion 提到 limitations 或呼籲 further research。\n' +
    '   ❌ 不是不顯著結果：論文測試某方法有效，但效果因條件而異（這仍是正面發現）。\n' +
    '   ✅ 是不顯著結果：論文的主要結論是「X 對 Y 沒有顯著效果」「X 的效果不如現有方法」「X 無法解決 Y 問題」。\n' +
    '8. 植物中文名稱：請使用台灣通用名稱。Litsea cubeba = 馬告（山胡椒）。其他植物請依台灣園藝界慣用名稱，勿使用中國大陸譯名。';

  try {
    var raw = await callAI(prompt, 60000);

    if (!raw) {
      // Error already logged by callAI
      return null;
    }
    var jsonStr = raw.trim();

    // Strip markdown fences
    if (jsonStr.startsWith('```')) {
      var nl = jsonStr.indexOf('\n');
      if (nl > 0) jsonStr = jsonStr.substring(nl + 1);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf('```')).trim();
    }
    var startIdx = jsonStr.indexOf('{');
    var endIdx = jsonStr.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
      throw new Error('Gemini did not return valid JSON');
    }
    jsonStr = jsonStr.substring(startIdx, endIdx + 1);

    var result;
    try {
      result = JSON.parse(jsonStr);
    } catch(e) {
      result = JSON.parse(jsonStr.replace(/,(\s*[}\]])/g, '$1'));
    }
    return result;
  } catch(e) {
    _logAIError('summarize', e.message || 'parse error');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// SECTION 8: Search Orchestrator
// ═══════════════════════════════════════════════════════════

async function runFullSearchPipeline(query, callbacks) {
  // callbacks: { onPhase, onGate, onProgress, onError }
  var cb = callbacks || {};
  var state = {};
  var reporter = new GateReporter();
  _lastAIError = null;  // Reset AI error for new search

  try {
    var modeLabel = SEARCH_CONFIG.mode === 'showcase' ? '展示模式' : '深度搜尋';

    // ── Phase 0: Query Enrichment ──
    // openalexQuery = SIMPLE core (plant names only) → OpenAlex (too many keywords → recall collapse)
    // crossrefQuery = AI-rich (5-8 keywords) → CrossRef bibliographic + Semantic Scholar
    // scoreQuery = AI-rich → relevance scoring only
    var openalexQuery = query;
    var crossrefQuery = query;
    var scoreQuery = query;

    // Always call enrichQueryWithTranslation for scientific name detection.
    // English queries: inline binomial regex (cheap, no API calls).
    // Chinese queries: translation + AI/glossary scientific name.
    if (hasChinese(query)) {
      cb.onPhase && cb.onPhase(0, '🌐 正在翻譯中文查詢…');
    }
    var enriched = await enrichQueryWithTranslation(query);
    if (enriched) {
      if (hasChinese(query)) {
        openalexQuery = enriched.openalex || enriched.crossref || query;
        crossrefQuery = enriched.crossref || enriched.score || query;
        scoreQuery = enriched.score || query;
        cb.onPhase && cb.onPhase(1, '🔍 OA→' + openalexQuery.substring(0, 40) + '… CR→' + crossrefQuery.substring(0, 40) + '…');
      }
      // Scientific name extraction works for both English and Chinese queries
      state._scientificName = enriched.scientificName || null;
      state._scientificNameSource = enriched.scientificNameSource || 'none';
      state._scientificNameExplicitNone = enriched.scientificNameExplicitNone || false;
    }

    // ── Phase 1: Multi-Source Search (split query strategy per source) ──
    cb.onPhase && cb.onPhase(1, '🔍 正在從多個學術來源搜尋（' + modeLabel + '）…');

    // S2 query: strip negative-result intent words so S2 searches the TOPIC,
    // not the result direction. Our NLP classifier handles negative detection.
    var s2Query = stripNegativeIntentWords(crossrefQuery);

    var searchLimit = getSearchLimit();
    var [oaResults, s2Results, crResults] = await Promise.allSettled([
      searchOpenAlex(openalexQuery, searchLimit),
      searchSemanticScholar(s2Query, searchLimit),
      searchCrossRef(crossrefQuery, searchLimit),
    ]);

    var allRaw = [];
    var sourcesWithResults = 0;

    var sourceDebug = {};
    [oaResults, s2Results, crResults].forEach(function(r, idx) {
      var srcNames = ['openalex', 'semantic_scholar', 'crossref'];
      if (r.status === 'fulfilled') {
        var val = r.value;
        if (val && val._debug) sourceDebug[srcNames[idx]] = val._debug;
        if (val && val.length > 0) {
          sourcesWithResults++;
          allRaw = allRaw.concat(val);
        }
      } else {
        sourceDebug[srcNames[idx]] = { error: 'Promise rejected: ' + (r.reason || '') };
      }
    });

    // Deduplicate
    var deduped = deduplicatePapers(allRaw);

    // ── Query Expansion (SPAR-inspired parallel variant search) ──
    var variantResults = await searchWithVariants(openalexQuery, crossrefQuery, Math.ceil(searchLimit / 2));
    if (variantResults.length > 0) {
      // Dedup variant results against main results, then merge
      var mainDOIs = new Set();
      for (var mi = 0; mi < deduped.length; mi++) {
        if (deduped[mi].doi) mainDOIs.add(deduped[mi].doi);
      }
      var newFromVariants = [];
      for (var vi = 0; vi < variantResults.length; vi++) {
        if (variantResults[vi].doi && !mainDOIs.has(variantResults[vi].doi)) {
          variantResults[vi]._fromExpansion = true;
          newFromVariants.push(variantResults[vi]);
        }
      }
      deduped = deduped.concat(newFromVariants);
      state._expandedFrom = newFromVariants.length;
    }

    // ── Relevance Filter (CRITICAL: remove irrelevant papers) ──
    var beforeFilter = deduped.length;
    // CRITICAL: use scoreQuery (AI-rich keywords) for relevance filtering,
    // not the original Chinese query. Chinese keywords won't match English papers.
    deduped = filterRelevant(deduped, scoreQuery, openalexQuery, state._scientificName, state._scientificNameExplicitNone);
    var afterRelevance = deduped.length;
    var filteredOut = beforeFilter - afterRelevance;

    // ── Reranker (SPAR-inspired: citation + recency weighting) ──
    deduped = rerankPapers(deduped);

    // ── Year & Content Quality Filter (Gate-level hard rule) ──
    var yearFilterResult = filterByYearAndContent(deduped);
    deduped = yearFilterResult.papers;
    var excludedNoContent = yearFilterResult.excludedNoContent;
    var hasOldPapers = yearFilterResult.hasOldPapers;
    var oldestYear = yearFilterResult.oldestYear;
    var oldPaperCount = yearFilterResult.oldPaperCount;

    // ── Generate broader search suggestions (for niche topics) ──
    var broaderSuggestions = suggestBroaderQueries(query, deduped);

    state.searchStats = {
      sourcesWithResults: sourcesWithResults,
      totalFound: allRaw.length,
      afterDedup: beforeFilter,
      afterRelevance: afterRelevance,
      afterQuality: deduped.length,
      filteredOut: filteredOut,
      excludedNoContent: excludedNoContent,
      hasOldPapers: hasOldPapers,
      oldestYear: oldestYear,
      oldPaperCount: oldPaperCount,
      broaderSuggestions: broaderSuggestions,
      expandedFrom: state._expandedFrom || 0,
      mode: SEARCH_CONFIG.mode,
      sourceDebug: sourceDebug,
      sources: {
        openalex: oaResults.status === 'fulfilled' ? oaResults.value.length : 0,
        semantic_scholar: s2Results.status === 'fulfilled' ? s2Results.value.length : 0,
        crossref: crResults.status === 'fulfilled' ? crResults.value.length : 0,
      }
    };

    var gate1 = reporter.runGate(GATE_DEFS[0], state);
    cb.onGate && cb.onGate(gate1);

    // ── Phase 2: Negative Result Classification ──
    cb.onPhase && cb.onPhase(2, '🔬 正在分類不顯著結果（NLP 關鍵字分析）…');

    var classified = classifyAllPapers(deduped);
    state.classifyStats = classified.stats;

    var gate2 = reporter.runGate(GATE_DEFS[1], state);
    cb.onGate && cb.onGate(gate2);

    // ── Phase 3: DOI Verification ──
    cb.onPhase && cb.onPhase(3, '✅ 正在驗證 DOI（CrossRef 查證）…');

    var verifyResult = await verifyAllDOIs(deduped, function(done, total) {
      cb.onProgress && cb.onProgress('verify', done, total);
    });
    state.verifyStats = verifyResult.stats;

    var gate3 = reporter.runGate(GATE_DEFS[2], state);
    cb.onGate && cb.onGate(gate3);

    // ── Phase 4: Assemble Report (AI runs in background, non-blocking) ──
    cb.onPhase && cb.onPhase(4, '📝 正在彙整報告…');

    // Re-classify after verification
    classifyAllPapers(verifyResult.papers);

    // Separate papers into tiers + apply mode limits
    var regularPapers = [];       // Directly relevant, non-negative
    var negativePapers = [];      // Directly relevant, negative
    var maxReg = getMaxRegular();
    var maxNeg = getMaxNegative();
    var aiRegIdx = 0;
    var aiNegIdx = 0;

    // Build query keywords for relevance classification
    var queryKeywords = extractQueryKeywords(crossrefQuery);
    // Three-tier discriminating term extraction: glossary → capitals → all-keywords-minus-generic
    // crossrefQuery always has English keywords (never falls back to Chinese)
    queryKeywords._plantTerms = extractDiscriminatingTerms(openalexQuery, crossrefQuery);
    queryKeywords._scientificName = state._scientificName || null;
    queryKeywords._scientificNameExplicitNone = state._scientificNameExplicitNone || false;

    // ── Layer 3: Adaptive Gap Detection (V4) ──
    // Only papers passing Layer 1 (Lv.1 or Lv.2) are candidates for 5+5
    var gapResult = findAdaptiveGap(verifyResult.papers);
    state._gapInfo = gapResult._gapInfo || null;
    // Build a Set of DOIs that passed the gap cut
    var passedDOIs = new Set();
    gapResult.forEach(function(p) { if (p.doi) passedDOIs.add(p.doi); });

    verifyResult.papers.forEach(function(p, i) {
      var isNeg = p.classification && p.classification.isNegative;
      var isDirect = isDirectlyRelevant(p, queryKeywords);
      if (!isDirect) return;  // Skip non-directly-relevant papers

      // Layer 3 gate: must pass adaptive gap cut (or gap not triggered)
      if (p.doi && !passedDOIs.has(p.doi) && gapResult._gapInfo && gapResult._gapInfo.maxGap >= 0.30) return;

      // Apply mode limits
      if (isNeg && negativePapers.length >= maxNeg) return;
      if (!isNeg && regularPapers.length >= maxReg) return;

      if (isNeg) {
        negativePapers.push(p);
      } else {
        regularPapers.push(p);
      }
    });

    var directPapers = regularPapers.concat(negativePapers);
    // ── Hard gate: ensure all displayed papers have why_matters ──
    // If Gemini didn't produce it, fill with metadata-based template.
    var missingWhyMatters = 0;
    directPapers.forEach(function(p) {
      if (!p.ai_why_matters || p.ai_why_matters.trim() === '') {
        p.ai_why_matters = buildFallbackWhyMatters(p);
        missingWhyMatters++;
      }
    });

    state.renderStats = {
      regular: regularPapers.length,
      negative: negativePapers.length,
      directRelevant: directPapers.length,
      missingWhyMatters: missingWhyMatters,
      allHaveMetadata: directPapers.every(function(p) {
        return p.title && p.year && (p.journal || p.source);
      }),
    };

    var gate4 = reporter.runGate(GATE_DEFS[3], state);
    cb.onGate && cb.onGate(gate4);

    return {
      query: query,
      openalexQuery: openalexQuery,  // SIMPLE core → OpenAlex
      crossrefQuery: crossrefQuery,  // RICH AI → CrossRef + Semantic Scholar
      scoreQuery: scoreQuery,    // AI-enriched (used for relevance scoring)
      papers: verifyResult.papers,
      regular: regularPapers,
      negative: negativePapers,
      suggested: [],
      aiConclusion: null,  // AI runs in background after render
      gateReport: reporter.getSummary(),
      state: state,
      success: reporter.canContinue(),
      scientificName: state._scientificName || null,
      scientificNameSource: state._scientificNameSource || 'none',
      scientificNameExplicitNone: state._scientificNameExplicitNone || false,
    };

  } catch(e) {
    cb.onError && cb.onError(e);
    return {
      query: query,
      papers: [],
      regular: [],
      negative: [],
      aiConclusion: null,
      gateReport: reporter.getSummary(),
      state: state,
      success: false,
      error: e.message || '未知錯誤',
    };
  }
}

// ═══════════════════════════════════════════════════════════
// SECTION 9: Render Engine
// ═══════════════════════════════════════════════════════════

function renderDiagnostics(result, originalQuery) {
  // Render a detailed diagnostic when 0 papers are found.
  // Shows exactly what happened at each pipeline stage.
  var parts = [];
  parts.push('<div class="section-title">🔧 搜尋診斷報告</div>');
  // Show error if pipeline crashed
  if (result.error) {
    parts.push('<div class="search-card" style="padding:12px 16px;background:#fdf0ed;border:2px solid var(--danger);margin-bottom:16px;">' +
      '<div style="font-weight:700;color:var(--danger);">🔴 管線錯誤</div>' +
      '<div style="font-size:0.82rem;color:var(--muted);">' + esc(result.error) + '</div>' +
      '</div>');
  }

  parts.push('<div style="font-size:0.9rem;color:var(--muted);margin-bottom:16px;">' +
    '原始查詢：' + esc(originalQuery) + '<br>' +
    '實際搜尋詞：' + esc(result.crossrefQuery || result.query) +
    (result.crossrefQuery && result.crossrefQuery !== originalQuery ? ' <span style="color:var(--accent);">（已翻譯）</span>' : ' <span style="color:var(--danger);">（未翻譯！）</span>') +
    '</div>');

  var ss = result.state ? result.state.searchStats : null;
  var gs = result.gateReport;

  if (ss) {
    parts.push('<div class="search-card" style="padding:16px 20px;"><div style="font-weight:700;margin-bottom:8px;">📊 各階段數據</div>');
    parts.push('<table style="width:100%;font-size:0.85rem;border-collapse:collapse;">');

    var rows = [
      ['搜尋來源數', ss.sourcesWithResults + ' / 3（OpenAlex: ' + (ss.sources.openalex||0) + ', S2: ' + (ss.sources.semantic_scholar||0) + ', CrossRef: ' + (ss.sources.crossref||0) + '）'],
      ['原始命中', ss.totalFound + ' 篇'],
      ['去重後', ss.afterDedup + ' 篇'],
      ['相關性過濾排除', (ss.filteredOut || 0) + ' 篇'],
      ['相關性過濾後', (ss.afterRelevance || '?') + ' 篇'],
      ['內容品質排除', (ss.excludedNoContent || 0) + ' 篇'],
      ['最終可用', (ss.afterQuality || 0) + ' 篇'],
      ['搜尋模式', ss.mode || '?'],
    ];

    rows.forEach(function(row) {
      parts.push('<tr><td style="padding:4px 8px;color:var(--muted);">' + row[0] + '</td><td style="padding:4px 8px;">' + row[1] + '</td></tr>');
    });
    // Show per-source debug info
  var sourceDebug = ss.sourceDebug;
  if (sourceDebug) {
    parts.push('<div style="margin-top:8px;font-size:0.8rem;">');
    Object.keys(sourceDebug).forEach(function(src) {
      var d = sourceDebug[src];
      var icon = (d.count > 0 || !d.error) ? '✅' : '🔴';
      var detail = '';
      if (d.query) detail += ' 查詢詞: "' + esc(d.query.substring(0, 60)) + '"';
      if (d.count > 0) detail += ' 回傳: ' + d.count + ' 篇';
      else if (d.error) detail += ' 錯誤: ' + esc(d.error);
      else detail += ' 回傳: 0 篇（查詢可能過於精確或無匹配論文）';
      parts.push('<div style="margin:2px 0;">' + icon + ' <strong>' + esc(src) + '</strong>:' + detail + '</div>');
    });
    parts.push('</div>');
  }
  parts.push('</table></div>');
  }

  // Show which gates passed/failed
  if (gs && gs.gates) {
    parts.push('<div class="search-card" style="padding:16px 20px;margin-top:12px;"><div style="font-weight:700;margin-bottom:8px;">🛡️ 閘門狀態</div>');
    gs.gates.forEach(function(gate) {
      parts.push('<div style="font-size:0.85rem;margin:2px 0;">' +
        (gate.passed ? '✅' : '❌') + ' ' + esc(gate.label) + ': ' +
        gate.checks.map(function(c) { return (c.ok ? '✓' : '✗') + esc(c.label); }).join(', ') +
        '</div>');
    });
    parts.push('</div>');
  }

  // Suggestions
  parts.push('<div class="search-card" style="padding:16px 20px;margin-top:12px;">');
  parts.push('<div style="font-weight:700;margin-bottom:8px;">💡 可能原因與建議</div>');
  parts.push('<ul style="font-size:0.85rem;padding-left:20px;">');

  if (ss && ss.totalFound === 0) {
    parts.push('<li>🔴 <strong>所有學術來源均無回傳結果</strong>——可能原因：網路連線問題、API 暫時無法存取、或關鍵字過於冷門。建議：使用更簡短的英文關鍵字重試。</li>');
  }
  if (ss && ss.totalFound > 0 && ss.afterDedup > 0 && (ss.afterRelevance === 0 || ss.filteredOut === ss.afterDedup)) {
    parts.push('<li>🔴 <strong>所有論文被相關性過濾排除</strong>——中文關鍵字無法匹配英文論文標題/摘要。建議：使用英文關鍵字重試。</li>');
  }
  if (ss && ss.afterRelevance > 0 && ss.afterQuality === 0 && ss.excludedNoContent > 0) {
    parts.push('<li>🟡 <strong>所有論文無摘要/無法判斷內容</strong>——這些論文可能年代久遠或來自無摘要的期刊。建議：放寬搜尋條件或使用其他關鍵字。</li>');
  }
  if (ss && ss.totalFound > 0 && ss.afterQuality === 0) {
    parts.push('<li>🟡 <strong>過濾後無可用論文</strong>——可能是關鍵字過於冷門或限制過嚴。建議：使用較通用的英文關鍵字。</li>');
  }
  if (ss && ss.sourcesWithResults === 0) {
    parts.push('<li>🔴 <strong>網路可能無法連線學術 API</strong>——請檢查網路連線，或嘗試稍後再試。</li>');
  }

  parts.push('<li>💡 直接嘗試英文關鍵字：複製上述「實際搜尋詞」重新貼上搜尋。</li>');
  parts.push('</ul></div>');

  return parts.join('\n');
}


// ── Reference list sort toggle (Formal V1) ──
var _refListSortBy = "year";
function resortRefList(sortBy) {
  _refListSortBy = sortBy;
  var yearBtn = document.getElementById("sortYearBtn");
  var scoreBtn = document.getElementById("sortScoreBtn");
  if (sortBy === "year") {
    yearBtn.style.background = "var(--accent)"; yearBtn.style.color = "#fff";
    scoreBtn.style.background = "#e8e0d4"; scoreBtn.style.color = "var(--text)";
  } else {
    scoreBtn.style.background = "var(--accent)"; scoreBtn.style.color = "#fff";
    yearBtn.style.background = "#e8e0d4"; yearBtn.style.color = "var(--text)";
  }
  var table = document.getElementById("refListTable");
  if (!table) return;
  var tbody = table.querySelector("tbody");
  if (!tbody) return;
  var rows = Array.from(tbody.querySelectorAll("tr"));
  rows.sort(function(a, b) {
    if (sortBy === "year") return parseInt(b.cells[0].textContent) - parseInt(a.cells[0].textContent);
    else return parseFloat(b.cells[2].textContent) - parseFloat(a.cells[2].textContent);
  });
  rows.forEach(function(r) { tbody.appendChild(r); });
}
function renderReport(result) {
  var parts = [];

  // Header
  parts.push('<div class="section-title">🔍 ' + esc(result.query) + '</div>');

  // Source info
  if (result.state && result.state.searchStats) {
    var ss = result.state.searchStats;
    var srcParts = [];
    // Always show all 3 sources so user knows each was searched
    var oaCount = ss.sources.openalex || 0;
    var s2Count = ss.sources.semantic_scholar || 0;
    var crCount = ss.sources.crossref || 0;
    srcParts.push('OpenAlex: ' + oaCount + ' 篇');
    srcParts.push('Semantic Scholar: ' + s2Count + ' 篇');
    srcParts.push('CrossRef: ' + crCount + ' 篇');
    // Show S2 error hint if it returned 0 while others had results
    if (s2Count === 0 && (oaCount > 0 || crCount > 0)) {
      srcParts.push('⚠️ S2 無結果（可能對負面關鍵字敏感，不影響其他來源）');
    }
    var modeLabel = ss.mode === 'showcase' ? '📋 展示模式' : '🔬 深度搜尋';
    var filterInfo = '';
    var filterParts = [];
    if (ss.filteredOut > 0) {
      filterParts.push('相關性過濾：排除 ' + ss.filteredOut + ' 篇不相關');
    }
    if (ss.excludedNoContent > 0) {
      filterParts.push('排除 ' + ss.excludedNoContent + ' 篇無摘要/無法判斷');
    }
    if (ss.hasOldPapers) {
      filterParts.push('⚠️ 含 ' + ss.oldPaperCount + ' 篇 2000 年前文獻（最早 ' + ss.oldestYear + ' 年）——此領域近期研究可能較少');
    }
    if (filterParts.length > 0) {
      filterInfo = ' → ' + filterParts.join('，') + ' → ' + ss.afterQuality + ' 篇';
    }
    var sortNote = FORMAL_MODE ? '' : '（V4排序：技術訊號×0.85 + 引用×0.08 + 新舊×0.07 + 學名加成）';
    var sq = result.scoreQuery ? ' 📊評分關鍵字:' + esc(result.scoreQuery) : '';
    var openalexNote = (result.openalexQuery && result.openalexQuery !== result.query ? ' 🔎OA搜尋:' + esc(result.openalexQuery) : '');
    var crossrefNote = (result.crossrefQuery && result.crossrefQuery !== result.query ? ' CR搜尋:' + esc(result.crossrefQuery) : '');
    var searchQueryNote = openalexNote + crossrefNote + sq;
    parts.push('<div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px;">' +
      modeLabel + ' · ' + esc(srcParts.join('，')) +
      ' → 去重後 ' + ss.afterDedup + ' 篇' + filterInfo + ' ' + sortNote + searchQueryNote +
      '</div>');

    // ── Scientific name indicator ──
    if (result.scientificNameExplicitNone) {
      // AI explicitly said no plant — correct behavior, no warning needed
      // (tech query like "節水灌溉" — no plant was specified)
    } else if (result.scientificName && result.scientificName.genus) {
      var sciSourceMap = { 'ai': 'AI', 'glossary': '詞典', 'inline': '內文偵測', 'ai-none': 'AI（無植物）' };
      var sciSource = sciSourceMap[result.scientificNameSource] || result.scientificNameSource;
      parts.push('<div style="font-size:0.8rem;color:#6b8e4e;margin-bottom:12px;word-break:break-all;">' +
        '🧬 學名偵測：<b><i>' + esc(result.scientificName.genus.charAt(0).toUpperCase() + result.scientificName.genus.slice(1) +
        ' ' + (result.scientificName.species || 'sp.')) + '</i></b>（來源：' + sciSource + '）— Layer 1 物種閘門已啟用' +
        '</div>');
    } else {
      // No scientific name detected — neutral notice, doesn't pretend to know why
      parts.push('<div style="font-size:0.78rem;color:#6b5e4f;margin-bottom:12px;padding:6px 10px;background:#faf8f3;border:1px dashed #b8a9d4;border-radius:4px;">' +
        '⚠️ 未偵測到物種學名，Layer 1 物種閘門未啟用（設定 AI API key 可啟用精準篩選）' +
        '</div>');
    }

    // Show per-source debug (compact)
    var sd = ss.sourceDebug;
    if (sd) {
      var debugParts = [];
      Object.keys(sd).forEach(function(src) {
        var d = sd[src];
        if (d.error) {
          debugParts.push('<span style="color:var(--danger);">' + esc(src) + ': ' + esc(d.error) + '</span>');
        } else if (d.count === 0 && d.query) {
          debugParts.push('<span style="color:var(--accent-warm);">' + esc(src) + ': 0 篇（查詢詞: ' + esc(d.query.substring(0, 40)) + '）</span>');
        }
      });
      if (debugParts.length > 0) {
        parts.push('<div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px;">' + debugParts.join(' · ') + '</div>');
      }
    }

    // Broader search suggestions (for niche topics with few results)
    if (ss.broaderSuggestions && ss.broaderSuggestions.length > 0 && ss.afterQuality <= 5) {
      parts.push('<div style="padding:14px 18px;background:#fefbf4;border:1px solid var(--accent-warm);border-radius:8px;margin-bottom:16px;font-size:0.88rem;">' +
        '💡 <strong>此領域文獻較少，建議嘗試擴展搜尋：</strong><br>' +
        ss.broaderSuggestions.map(function(s) { return '　→ ' + esc(s); }).join('<br>') +
        '</div>');
    }
  }

  // Regular papers
  if (result.regular && result.regular.length > 0) {
    parts.push('<div class="section-title">📊 一般文獻回顧 (' + result.regular.length + ' 篇)</div>');
    for (var i = 0; i < result.regular.length; i++) {
      parts.push(renderPaperCard(result.regular[i], 'pos'));
    }
  }

  // Negative results
  if (result.negative && result.negative.length > 0) {
    parts.push('<div class="section-title">🔴 不顯著結果專區 (' + result.negative.length + ' 篇)</div>');
    for (var i = 0; i < result.negative.length; i++) {
      parts.push(renderPaperCard(result.negative[i], 'neg'));
    }
  } else if (result.papers && result.papers.length > 0) {
    // No negative results found — show a note
    parts.push('<div class="section-title">🔴 不顯著結果專區 (0 篇)</div>');
    parts.push('<div style="padding:16px 20px;color:var(--muted);font-size:0.9rem;border:1px dashed var(--border);border-radius:8px;margin:12px 0;">' +
      '⚠️ 本次搜尋未發現明確的不顯著結果論文。可能原因：(1) 此領域不顯著結果確實稀少（公開偏誤的證據）；(2) 論文無摘要，NLP 分類器無法判斷——請設定 AI API key 或安裝 Ollama 以獲得更深入的分析。' +
      '</div>');
  }

  if (!FORMAL_MODE) {
  // AI diagnostics (V5 — always show when available)
  if (result._aiDiagnostics) {
    parts.push(renderAIDiagnostics(result._aiDiagnostics, result));
  }
  }

  // Gate report (collapsible)
  parts.push(renderGateSummary(result.gateReport));

  // Note if no directly relevant papers were found
  var hasDirectResults = (result.regular && result.regular.length > 0) || (result.negative && result.negative.length > 0);
  if (!hasDirectResults && result.papers && result.papers.length > 0) {
    parts.push('<div style="padding:16px 20px;background:#fefbf4;border:2px solid var(--accent-warm);border-radius:8px;margin:16px 0;font-size:0.9rem;">' +
      '⚠️ <strong>未找到與「' + esc(result.query) + '」直接相關的文獻。</strong><br>' +
      '下方「建議觀看」為同領域（組織培養/微繁殖）的其他物種研究，可作為技術參考，但<strong>並非</strong>直接針對此查詢主題。' +
      '</div>');
  }

  // Conclusion
  var conclusionText = result.aiConclusion || buildAutoConclusion(result);
  if (conclusionText) {
    parts.push(
      '<div class="conclusion-box">' +
      '<div class="section-title">📝 總結與建議</div>' +
      '<div class="paper-body">' + esc(conclusionText).replace(/\n/g, '<br>') + '</div>' +
      '</div>'
    );
  }

  // ── 完整文獻清單（依年份新→舊，含完整標題）──
  if (result.papers && result.papers.length > 0) {
    var allPapers = result.papers.slice().sort(function(a, b) { return _refListSortBy === "score" ? ((b._rankScore || 0) - (a._rankScore || 0)) : ((b.year || 0) - (a.year || 0)); });
    parts.push('<div class="search-card" style="margin-top:16px;padding:16px 20px;background:#faf8f3;">');
    parts.push('<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span>📚 完整文獻清單（' + allPapers.length + ' 篇）</span>' +
      '<span style="font-size:0.78rem;font-weight:normal;">' +
      '<button id="sortYearBtn" onclick="resortRefList(\'year\')" ' +
      'style="padding:4px 10px;background:var(--accent);color:#fff;border:none;border-radius:12px;cursor:pointer;font-family:inherit;font-size:0.75rem;font-weight:600;">📅 依年份</button> ' +
      '<button id="sortScoreBtn" onclick="resortRefList(\'score\')" ' +
      'style="padding:4px 10px;background:#e8e0d4;color:var(--text);border:1px solid var(--border);border-radius:12px;cursor:pointer;font-family:inherit;font-size:0.75rem;">📊 依分數</button>' +
      '</span></div>');
    parts.push('<table id="refListTable" style="width:100%;font-size:0.78rem;border-collapse:collapse;margin-top:8px;">');
    parts.push('<tr style="background:#e8e0d4;text-align:left;"><th style="padding:4px 8px;">年</th><th style="padding:4px 8px;">論文標題</th><th style="padding:4px 8px;text-align:center;">分數</th></tr>');
    allPapers.forEach(function(p, i) {
      var sb = p._scoreBreakdown;
      var scoreStr = sb ? sb.rankScore.toFixed(3) : '-';
      var yearStr = p.year || '?';
      parts.push('<tr style="border-bottom:1px solid #e8e0d4;">' +
        '<td style="padding:4px 8px;white-space:nowrap;">' + yearStr + '</td>' +
        '<td style="padding:4px 8px;">' + esc(p.title || '(無標題)') + '</td>' +
        '<td style="padding:4px 8px;text-align:center;white-space:nowrap;">' + scoreStr + '</td>' +
        '</tr>');
    });
    parts.push('</table>');
    parts.push('</div>');
  }

  // Suggested reading (tangentially relevant — filtered for quality)
  var goodSuggestions = filterQualitySuggestions(result.suggested || [], result.query);
  // No "建議觀看" section — only show directly relevant papers.
  // Low-quality tangential results (spinach, maize, etc.) are excluded.
  // If no directly relevant papers found, the warning banner above is sufficient.

  // Export buttons
  parts.push(renderExportButtons(result));

  if (!FORMAL_MODE) {
  // AI error diagnostics (if any)
  if (_aiErrors.length > 0) {
    parts.push('<div class="search-card" style="padding:12px 16px;margin-top:16px;background:#fdf0ed;border:1px solid var(--danger);">' +
      '<div style="font-weight:700;font-size:0.85rem;color:var(--danger);margin-bottom:4px;">🔴 AI API 錯誤</div>' +
      '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px;">' +
      _aiErrors.map(function(e) { return esc(e); }).join('<br>') +
      '</div>' +
      '<div style="font-size:0.75rem;color:var(--muted);border-top:1px solid #f0c0b0;padding-top:6px;">' +
      '💡 <b>使用 OpenRouter 免費 API（Tencent Hy3 / Gemma 4）</b><br>' +
      'API key 請從 <a href="https://openrouter.ai/settings/keys" target="_blank">openrouter.ai/settings/keys</a> 取得。<br>' +
      '免費額度 50 次/天。自動依序嘗試 Hy3 → Gemma 4 → Nemotron。' +
      '</div></div>');
  }
  }

  // Disclaimer
  var aiLabel = _aiSource || (getApiKey() ? '雲端 API' : '');
  var apiNote = aiLabel ? 'AI 中文摘要由 ' + aiLabel + ' 產生' : '（設定 AI API key 或安裝 Ollama 可獲得 AI 中文摘要）';
  parts.push('<div class="disclaimer">⚠️ 論文 metadata 來自 OpenAlex / Semantic Scholar / CrossRef 真實資料庫。DOI 已驗證。' + apiNote + '。仍建議自行核對原始出處。</div>');

  return parts.join('\n');
}

function buildAutoConclusion(result) {
  var parts = [];
  var totalPapers = (result.regular ? result.regular.length : 0) + (result.negative ? result.negative.length : 0);

  if (result.negative && result.negative.length > 0) {
    parts.push('本次搜尋發現 ' + result.negative.length + ' 篇潛在不顯著結果論文。');
    var titles = result.negative.slice(0, 3).map(function(p) { return p.title; });
    parts.push('其中包括：「' + titles.join('」、「') + '」等。');
  } else {
    parts.push('本次搜尋未發現明確的不顯著結果論文。');
  }

  // Old paper note
  if (result.state && result.state.searchStats && result.state.searchStats.hasOldPapers) {
    var ss = result.state.searchStats;
    parts.push('⚠️ 此領域文獻較舊（最早至 ' + ss.oldestYear + ' 年，共 ' + ss.oldPaperCount + ' 篇），顯示近期研究較少——這本身可能就是一個研究缺口。');
  }

  // Sparse results note
  if (totalPapers <= 5 && result.state && result.state.searchStats && result.state.searchStats.broaderSuggestions) {
    var suggestions = result.state.searchStats.broaderSuggestions;
    parts.push('此主題文獻稀少，建議擴展查詢範圍：' + suggestions.join('、') + '。');
  }

  if (_aiRunning) {
    parts.push('🤖 AI 正在分析中，摘要即將更新…');
  } else if (!_aiSource && !getApiKey()) {
    parts.push('💡 設定 AI API key 或安裝 Ollama 可獲得逐篇中文摘要與跨文獻分析。');
  }
  return parts.join('\n');
}

function renderPaperCard(p, badgeType) {
  var isNeg = badgeType === 'neg';
  var isSuggested = badgeType === 'suggested';
  var badgeLabel = isNeg ? '🔴 不顯著結果' : (isSuggested ? '📖 建議觀看' : '📄 一般文獻');
  var badgeClass = isNeg ? 'neg' : (isSuggested ? 'sug' : 'pos');
  var cardClass = isNeg ? 'paper-card negative' : (isSuggested ? 'paper-card suggested' : 'paper-card');

  var parts = [];
  parts.push('<div class="' + cardClass + '">');
  parts.push('<span class="card-badge ' + badgeClass + '">' + badgeLabel + '</span>');

  // Title
  parts.push('<div class="paper-title">' + esc(p.title) + '</div>');
  if (p.title_zh && p.title_zh !== p.title) {
    parts.push('<div class="paper-title-zh" style="font-size:0.82rem;color:var(--muted);font-weight:400;margin-top:2px;">' + esc(p.title_zh) + '</div>');
  }

  // Meta
  var metaArr = [];
  if (p.authors && p.authors.length > 0) metaArr.push(formatAuthors(p.authors));
  if (p.journal) metaArr.push(p.journal);
  if (p.year) metaArr.push(p.year);
  var meta = metaArr.filter(Boolean).join(' · ');
  if (meta) parts.push('<div class="paper-meta">' + esc(meta) + '</div>');

  // Old paper warning
  if (p._isOld && p._ageWarning) {
    parts.push('<div style="font-size:0.78rem;color:var(--accent-warm);margin-bottom:4px;">⚠️ ' + esc(p._ageWarning) + '——此領域近期研究可能較少</div>');
  }

  // Journal quality badge
  var quality = getJournalQuality(p);
  var citationStr = p.citationCount > 0 ? ' · 引用: ' + p.citationCount : '';
  if (quality && quality.tier) {
    var qColors = {Q1: '#2c8f3a', Q2: '#6b8e4e', Q3: '#c4943a', Q4: '#999'};
    parts.push('<div style="font-size:0.78rem;margin-bottom:4px;">' +
      '<span style="color:' + (qColors[quality.tier] || '#999') + ';font-weight:700;">' + quality.tier + '</span>' +
      ' <span style="color:var(--muted);">· h-index: ' + quality.h_index + citationStr + '</span>' +
      '</div>');
  } else {
    // Journal not in quality database yet — show placeholder
    parts.push('<div style="font-size:0.78rem;margin-bottom:4px;">' +
      '<span style="color:#aaa;font-weight:700;" title="此期刊尚未收錄於品質資料庫">Q?</span>' +
      ' <span style="color:var(--muted);">' + (citationStr ? citationStr.substring(3) : '') + '</span>' +
      '</div>');
  }

  // Source badge
  if (p.sources && p.sources.length > 1) {
    parts.push('<div style="font-size:0.78rem;color:var(--accent);margin-bottom:4px;">📚 多來源確認：' + esc(p.sources.join(' + ')) + '</div>');
  } else if (p.source) {
    parts.push('<div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">來源：' + esc(p.source) + '</div>');
  }

  // Classification confidence
  if (isNeg && p.classification && p.classification.confidence !== 'none') {
    var confLabel = {high: '高信心', medium: '中信心', low: '低信心'}[p.classification.confidence] || '';
    var confColor = {high: 'var(--danger)', medium: 'var(--accent-warm)', low: 'var(--muted)'}[p.classification.confidence] || 'var(--muted)';
    if (confLabel) {
      parts.push('<div style="font-size:0.78rem;color:' + confColor + ';margin-bottom:4px;">🤖 不顯著結果分類信心：' + confLabel + '（分數：' + p.classification.score + '）</div>');
    }
  }

  // DOI display
  if (p.doi && p.doi.trim()) {
    if (p.doi_bad_format) {
      parts.push('<div class="paper-doi" style="color:var(--danger);">⚠️ 異常 DOI：' + esc(p.doi.trim()) + '（格式不符合 DOI 標準）</div>');
    } else if (p.doi_verified) {
      parts.push('<div class="paper-doi">DOI: <a href="https://doi.org/' + esc(p.doi.trim()) + '" target="_blank">' + esc(p.doi.trim()) + '</a> ✓ 已驗證</div>');
    } else if (p.doi_error) {
      parts.push('<div class="paper-doi">DOI: <a href="https://doi.org/' + esc(p.doi.trim()) + '" target="_blank">' + esc(p.doi.trim()) + '</a> <span class="unverified">⚠️ ' + esc(p.doi_error) + '</span></div>');
    } else {
      parts.push('<div class="paper-doi">DOI: <a href="https://doi.org/' + esc(p.doi.trim()) + '" target="_blank">' + esc(p.doi.trim()) + '</a></div>');
    }
  }

  // Abstract snippet
  if (p.abstract) {
    var snippet = p.abstract.substring(0, 400);
    if (p.abstract.length > 400) snippet += '…';
    parts.push('<div style="font-size:0.85rem;color:var(--muted);margin:8px 0;line-height:1.6;max-height:100px;overflow-y:auto;">' + esc(snippet) + '</div>');
  }

  // AI finding
  var finding = p.ai_finding || '';
  if (finding) {
    parts.push('<div class="paper-body" style="margin-top:8px;">' + esc(finding) + '</div>');
  }

  // AI disclaimer for negative
  if (isNeg) {
    parts.push('<div style="font-size:0.78rem;color:var(--muted);margin-top:8px;">⚠️ NLP 分類僅供參考。請自行查閱原文確認是否確實為不顯著結果。</div>');
  }

  // Why matters — always show insight box for all papers
  var whyMatters = p.ai_why_matters || '';
  var label = isNeg ? '💡 對後續研究者的啟示（這個「沒用」可以省下什麼？）' : '💡 對研究者的意義';
  var text = whyMatters || '請設定 AI API key 或安裝 Ollama 以獲得逐篇中文分析。';
  // Detect AI failure: "AI 分析中…" displayed but AI is no longer running
  if (whyMatters.indexOf('AI 分析中') !== -1 && !_aiRunning) {
    text = whyMatters + ' ⚠️ AI 可能未成功回應（檢查 Console 錯誤）。';
  }
  parts.push(
    '<div class="insight-box">' +
    '<div class="insight-label">' + label + '</div>' +
    '<div class="insight-text">' + esc(text) + '</div>' +
    '</div>'
  );

  if (!FORMAL_MODE) {
  // ── 權重計算明細（測試版V1：透明化）──
  if (p._scoreBreakdown) {
    parts.push(renderScoreBreakdown(p));
  }

  }
  parts.push('</div>');
  return parts.join('\n');
}

// ── Render score breakdown (測試版V1: weight transparency) ──
function renderScoreBreakdown(p) {
  var sb = p._scoreBreakdown;
  if (typeof FORMAL_MODE !== "undefined" && FORMAL_MODE) return "";
  var parts = [];
  parts.push('<details class="score-breakdown" open style="margin-top:10px;padding:10px 14px;background:#f4f6ed;border-radius:8px;font-size:0.78rem;color:var(--text);">');
  parts.push('<summary style="cursor:pointer;font-weight:600;color:var(--accent);">🔬 權重計算明細</summary>');
  parts.push('<div style="margin-top:8px;line-height:1.8;">');

  // Layer 1: Species gate level
  parts.push('<div><b>Layer 1 物種等級:</b> ');
  var gateLabel = p._gateMethod;
  if (gateLabel === 'ai-none') {
    parts.push('<span style="color:var(--muted);">未啟用（AI 判斷查詢無指定植物）</span>');
  } else if (gateLabel === 'none') {
    parts.push('<span style="color:var(--muted);">未啟用（未偵測到物種學名）</span>');
  } else if (sb.speciesLevel === 2) {
    parts.push('<span style="color:#27ae60;">Lv.2 全中 (+' + sb.speciesBonus.toFixed(1) + ')</span>');
  } else if (sb.speciesLevel === 1) {
    parts.push('<span style="color:#f39c12;">Lv.1 部分命中（同屬不同種）</span>');
  } else {
    parts.push('<span style="color:#c0392b;">Lv.0 未命中 → ×0.3 懲罰</span>');
  }
  // Show gate method
  if (gateLabel === 'scientific-name') {
    var sn = p._scientificName;
    parts.push(' <span style="font-size:0.7rem;color:var(--muted);">[學名: <i>' + esc((sn&&sn.genus||'') + ' ' + (sn&&sn.species||'')) + '</i>]</span>');
  } else if (gateLabel === 'discriminating-terms') {
    parts.push(' <span style="font-size:0.7rem;color:var(--accent-warm);">[關鍵詞判斷]</span>');
  }
  parts.push('</div>');

  // Layer 2: Technical signal
  parts.push('<div><b>Layer 2 技術訊號:</b> ' + sb.technicalScore.toFixed(4));
  parts.push(' = ' + (sb.techNumerator || sb.unigramScore || 0).toFixed(3) + ' / ' + (sb.techDenominator || 1).toFixed(3));
  parts.push(' (分子=Σ命中技術詞TF×1.5|1.0×IDF², 分母=Σ全部技術詞IDF²)</div>');

  // Keyword hits
  var th = sb.keywordHits.titleHits || [];
  var ah = sb.keywordHits.abstractHits || [];
  if (th.length > 0) {
    parts.push('<div>📌 技術詞標題命中 (×1.5): ' + th.map(function(w){return '<code style="background:#d4edda;padding:1px 4px;border-radius:3px;">'+esc(w)+'</code>';}).join(', ') + '</div>');
  }
  if (ah.length > 0) {
    parts.push('<div>📎 技術詞摘要命中 (×1.0): ' + ah.map(function(w){return '<code style="background:#fff3cd;padding:1px 4px;border-radius:3px;">'+esc(w)+'</code>';}).join(', ') + '</div>');
  }

  // Plant gate
  if (sb.plantHits && sb.plantHits.length > 0) {
    parts.push('<div>🌿 植物名命中: ' + sb.plantHits.map(function(w){return '<b>'+esc(w)+'</b>';}).join(', ') + '</div>');
  }

  // Final rank score
  parts.push('<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #ccc;"><b>最終排序</b> = ' + sb.technicalScore.toFixed(4) + '×0.85 + ' + sb.citationScore.toFixed(2) + '×0.08 + ' + sb.recency.toFixed(2) + '×0.07');
  if (sb.speciesBonus > 0) parts.push(' + ' + sb.speciesBonus.toFixed(1));
  parts.push(' = <b style="color:var(--accent);">' + sb.rankScore.toFixed(4) + '</b></div>');

  parts.push('</div></details>');
  return parts.join('\n');
}

// ── AI Summary Diagnostics Panel (V5) ──
function renderAIDiagnostics(diag, result) {
  if (!diag) return '';
  if (typeof FORMAL_MODE !== "undefined" && FORMAL_MODE) return "";
  var parts = [];

  // ── Coverage analysis: displayed papers vs AI-processed papers ──
  var displayedPapers = (result && result.regular ? result.regular : []).concat(
    result && result.negative ? result.negative : []
  );
  var aiTitles = new Set();
  var aiDOIs = new Set();
  if (diag.perPaper) {
    diag.perPaper.forEach(function(s) {
      if (s._fullTitle) aiTitles.add(s._fullTitle.toLowerCase());
      if (s._doi) aiDOIs.add(s._doi);
    });
  }
  var coveredCount = 0;
  var missedPapers = [];
  displayedPapers.forEach(function(p) {
    var titleMatch = p.title && aiTitles.has(p.title.toLowerCase());
    var doiMatch = p.doi && aiDOIs.has(p.doi);
    if (titleMatch || doiMatch) {
      coveredCount++;
    } else {
      missedPapers.push(p);
    }
  });
  var hasCoverageGap = missedPapers.length > 0;
  var allDisplayed = displayedPapers.length;

  parts.push('<details class="ai-diagnostics" style="margin-top:16px;padding:14px 18px;background:' +
    (hasCoverageGap && !diag.pending ? '#fef5f5' : '#f9f7fd') + ';border:1px solid ' +
    (hasCoverageGap && !diag.pending ? '#e8c8c8' : '#b8a9d4') + ';border-radius:8px;font-size:0.82rem;">');
  parts.push('<summary style="cursor:pointer;font-weight:700;color:' +
    (hasCoverageGap && !diag.pending ? '#c0392b' : '#6b5e9f') + ';font-size:0.9rem;">' +
    '🤖 AI 摘要診斷' +
    (diag.pending ? ' 🔄 執行中…' : '') +
    ' — 畫面顯示 ' + allDisplayed + ' 篇' +
    (diag.pending ? '' : '，AI 涵蓋 ' + coveredCount + '/' + allDisplayed + ' 篇') +
    '，AI 回傳 ' + (diag.pending ? '?' : (diag.regularCount + diag.negativeCount) + ' 筆 (regular:' + diag.regularCount + ' / negative:' + diag.negativeCount + ')') +
    '，成功配對 ' + (diag.pending ? '?' : diag.mappedCount + ' 篇') +
    (hasCoverageGap && !diag.pending ? ' 🔴 ' + missedPapers.length + ' 篇畫面顯示但 AI 未處理！' : '') +
    (diag.anomalies && diag.anomalies.length > 0 ? ' ⚠️ ' + diag.anomalies.length + ' 項異常' : '') +
    '</summary>');

  // ── Coverage gap warning (most important — shown first) ──
  if (hasCoverageGap && !diag.pending) {
    parts.push('<div style="margin-top:10px;padding:10px 14px;background:#fef0ed;border:2px solid #c0392b;border-radius:6px;">');
    parts.push('<div style="font-weight:700;color:#c0392b;margin-bottom:4px;">🔴 覆蓋率不足：' + missedPapers.length + ' 篇畫面顯示的論文未在 AI 處理範圍內</div>');
    parts.push('<div style="font-size:0.78rem;color:#a0524a;margin-bottom:4px;">這些論文會持續顯示「AI 分析中…⚠️ AI 可能未成功回應」</div>');
    missedPapers.forEach(function(p) {
      parts.push('<div style="font-size:0.78rem;margin:2px 0;color:#3d3226;">• <b>' +
        esc((p.title || '?').substring(0, 80)) + '</b> (' + (p.year || '?') + ')</div>');
    });
    parts.push('<div style="font-size:0.75rem;color:var(--muted);margin-top:4px;">可能原因：AI 處理範圍為 rank 前 N 名，但這些論文排名在 N+1 之後，仍通過相關性閘門顯示在畫面上。</div>');
    parts.push('</div>');
  }

  // ── Scope summary ──
  parts.push('<div style="margin-top:10px;padding:8px 12px;background:#f4f6ed;border-radius:6px;font-size:0.8rem;">');
  parts.push('<b>📊 資料範圍</b>：搜尋總數 ' + (result && result.papers ? result.papers.length : '?') + ' 篇 → ');
  parts.push('畫面顯示 ' + allDisplayed + ' 篇（一般:' + (result && result.regular ? result.regular.length : 0) +
    ' / 負面:' + (result && result.negative ? result.negative.length : 0) + '）→ ');
  parts.push('AI 處理 ' + diag.papersSent + ' 篇');
  if (!diag.pending) {
    parts.push(' → 涵蓋率 ' + coveredCount + '/' + allDisplayed + '（' + (allDisplayed > 0 ? Math.round(coveredCount/allDisplayed*100) : 0) + '%）');
  }
  parts.push('</div>');

  // ── AI Status ──
  if (diag.pending) {
    parts.push('<div style="margin-top:10px;padding:8px 12px;background:#fefbf4;border-radius:6px;">');
    parts.push('<b style="color:#c4943a;">🔄 AI 分析執行中…</b>');
    parts.push(' · 預計配對方式：' + esc(diag.mappingMethod));
    parts.push(' · 請等待 AI 回應（約 15-30 秒）');
    parts.push('</div>');
  } else {
    var statusIcon = diag.aiSuccess ? '✅' : '❌';
    var statusColor = diag.aiSuccess ? '#6b8e4e' : '#c0392b';
    parts.push('<div style="margin-top:10px;padding:8px 12px;background:' + (diag.aiSuccess ? '#eef6e8' : '#fdf0ed') + ';border-radius:6px;">');
    parts.push('<b style="color:' + statusColor + ';">' + statusIcon + ' AI 呼叫狀態：' + (diag.aiSuccess ? '成功' : '失敗') + '</b>');
    if (!diag.aiSuccess && diag.aiError) {
      parts.push(' — ' + esc(diag.aiError.context) + ': ' + esc(diag.aiError.message.substring(0, 100)));
    }
    parts.push(' · 結論長度：' + diag.conclusionLen + ' 字元');
    parts.push(' · 配對方式：' + esc(diag.mappingMethod));
    parts.push('</div>');
  }

  // ── Anomalies ──
  // v36: smart summary — when AI disputes ALL NLP negative classifications,
  // it likely indicates NLP over-sensitivity, not AI error.
  var classMismatches = (diag.anomalies || []).filter(function(a) { return a.indexOf('分類不一致') >= 0; });
  var allNegDisputed = classMismatches.length > 0 && classMismatches.every(function(a) { return a.indexOf('本地=negative AI=regular') >= 0; });
  if (allNegDisputed && classMismatches.length >= 3) {
    parts.push('<div style="margin-top:8px;padding:10px 14px;background:#fffbed;border:1px solid #e8d89e;border-radius:6px;">');
    parts.push('<div style="font-weight:700;color:#c4943a;margin-bottom:4px;">💡 診斷提示：AI 將所有 NLP 標記的負面論文重新分類為一般論文</div>');
    parts.push('<div style="color:#6b5e4f;font-size:0.85rem;">');
    parts.push('這通常表示 <b>NLP 關鍵字分類器過度敏感</b>（false positive），而非 AI 漏判。');
    parts.push('正常論文 Discussion 段落中常見的「limitations」「further research needed」等措辭會觸發 NLP 關鍵字，');
    parts.push('但 AI 能理解全文語意，判斷這些論文實際上是報告正面或中性發現。');
    parts.push('<br>✅ 此搜尋結果的 AI 分類可能比 NLP 更可靠。');
    parts.push('</div></div>');
  }
  if (diag.anomalies && diag.anomalies.length > 0) {
    parts.push('<div style="margin-top:8px;padding:10px 14px;background:#fef5f5;border:1px solid #e8c8c8;border-radius:6px;">');
    parts.push('<div style="font-weight:700;color:#c0392b;margin-bottom:4px;">⚠️ 異常偵測（' + diag.anomalies.length + ' 項）</div>');
    diag.anomalies.forEach(function(a) {
      // v36: tone down classification mismatches when all are NLP→AI disputes
      var icon = '•';
      if (allNegDisputed && a.indexOf('分類不一致：本地=negative AI=regular') >= 0) {
        icon = '🔍';  // investigative, not alarming
      }
      parts.push('<div style="color:#a0524a;margin:2px 0;">' + icon + ' ' + esc(a) + '</div>');
    });
    parts.push('</div>');
  }

  // ── AI p-values ──
  parts.push('<div style="margin-top:10px;"><b>AI 回傳的 p 值：</b>');
  parts.push('regular: [' + (diag.aiPValues.regular.length > 0 ? diag.aiPValues.regular.join(', ') : '無') + ']');
  parts.push(' · negative: [' + (diag.aiPValues.negative.length > 0 ? diag.aiPValues.negative.join(', ') : '無') + ']');
  parts.push('</div>');

  // ── Per-paper mapping table ──
  parts.push('<div style="margin-top:10px;"><b>逐篇配對明細：</b></div>');
  parts.push('<table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:0.78rem;">');
  parts.push('<tr style="background:#e8e0d4;text-align:left;">' +
    '<th style="padding:3px 6px;">p#</th>' +
    '<th style="padding:3px 6px;">分類</th>' +
    '<th style="padding:3px 6px;">論文標題</th>' +
    '<th style="padding:3px 6px;text-align:center;">中文標題</th>' +
    '<th style="padding:3px 6px;">配對</th>' +
    '<th style="padding:3px 6px;">AI來源</th>' +
    '<th style="padding:3px 6px;text-align:center;">類別吻合</th>' +
    '<th style="padding:3px 6px;text-align:center;">finding</th>' +
    '<th style="padding:3px 6px;text-align:center;">why_matters</th>' +
    '</tr>');
  diag.perPaper.forEach(function(s) {
    var rowColor = s.mapped ? (s.classMatch ? '#eef6e8' : '#fefbf4') : '#fdf0ed';
    var mapIcon = s.mapped ? '✅' : '❌';
    var matchIcon = s.mapped ? (s.classMatch ? '✓' : '⚠️ 不同') : '—';
    var findingLen = s.findingLen || 0;
    var whyLen = s.whyLen || 0;
    var titleZhLen = s.titleZhLen || 0;
    var zhIcon = titleZhLen > 0 ? '✅' : '❌';
    parts.push('<tr style="background:' + rowColor + ';">' +
      '<td style="padding:3px 6px;">' + s.paperNum + '</td>' +
      '<td style="padding:3px 6px;">' + (s.classification === 'negative' ? '🔴負面' : '📊一般') + '</td>' +
      '<td style="padding:3px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(s.title) + '">' + esc(s.title) + '</td>' +
      '<td style="padding:3px 6px;text-align:center;color:' + (titleZhLen > 0 ? '#6b8e4e' : '#c0392b') + ';">' + zhIcon + ' ' + titleZhLen + ' 字</td>' +
      '<td style="padding:3px 6px;">' + mapIcon + '</td>' +
      '<td style="padding:3px 6px;">' + (s.aiSource || '—') + '</td>' +
      '<td style="padding:3px 6px;text-align:center;">' + matchIcon + '</td>' +
      '<td style="padding:3px 6px;text-align:center;color:' + (findingLen > 0 ? '#6b8e4e' : '#c0392b') + ';">' + findingLen + ' 字</td>' +
      '<td style="padding:3px 6px;text-align:center;color:' + (whyLen > 0 ? '#6b8e4e' : '#c0392b') + ';">' + whyLen + ' 字</td>' +
      '</tr>');
    // Show reason for unmapped
    if (!s.mapped && s.reason) {
      parts.push('<tr style="background:#fdf0ed;"><td colspan="9" style="padding:2px 12px;font-size:0.72rem;color:#a0524a;">↳ ' + esc(s.reason) + '</td></tr>');
    }
    // Show finding preview for mapped
    if (s.mapped && s.findingPreview) {
      parts.push('<tr style="background:' + rowColor + ';"><td colspan="9" style="padding:2px 12px;font-size:0.72rem;color:var(--muted);">↳ ' + esc(s.findingPreview) + '…</td></tr>');
    }
  });
  parts.push('</table>');

  // ── AI error log ──
  if (_aiErrors.length > 0) {
    parts.push('<details style="margin-top:8px;font-size:0.75rem;"><summary style="cursor:pointer;color:var(--muted);">📋 AI 錯誤記錄（最近 ' + _aiErrors.length + ' 筆）</summary>');
    parts.push('<div style="margin-top:4px;padding:6px 10px;background:#faf8f3;border-radius:4px;max-height:120px;overflow-y:auto;">');
    _aiErrors.forEach(function(err) {
      parts.push('<div style="color:var(--danger);">' + esc(err) + '</div>');
    });
    parts.push('</div></details>');
  }

  parts.push('</details>');
  return parts.join('\n');
}

function renderGateSummary(gateReport) {
  if (!gateReport || !gateReport.gates) return '';

  var parts = [];
  parts.push('<div class="search-card" style="margin-top:16px;padding:16px 20px;background:#faf8f3;">');
  parts.push('<div style="font-weight:700;margin-bottom:8px;font-size:0.9rem;">🛡️ 閘門檢查報告</div>');

  gateReport.gates.forEach(function(gate) {
    var icon = gate.passed ? '✅' : '⚠️';
    parts.push('<div style="font-size:0.85rem;margin:4px 0;color:' + (gate.passed ? 'var(--accent)' : 'var(--accent-warm)') + ';">');
    parts.push(icon + ' ' + esc(gate.label) + ': ');
    var checkTexts = gate.checks.map(function(c) {
      return (c.ok ? '✓' : '✗') + ' ' + esc(c.label);
    });
    parts.push(checkTexts.join('；'));
    parts.push('</div>');
  });

  if (gateReport.severeFailures && gateReport.severeFailures.length > 0) {
    parts.push('<div style="font-size:0.82rem;color:var(--danger);margin-top:8px;">🔴 嚴重問題：' + esc(gateReport.severeFailures.join('、')) + '</div>');
  }
  if (gateReport.warnings && gateReport.warnings.length > 0) {
    parts.push('<div style="font-size:0.82rem;color:var(--accent-warm);margin-top:4px;">🟡 建議：' + esc(gateReport.warnings.join('、')) + '</div>');
  }

  parts.push('</div>');
  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════
// SECTION 10: Export Module
// ═══════════════════════════════════════════════════════════

function renderExportButtons(result) {
  var allPapers = (result.papers || []).map(function(p) { return exportPaperData(p); });
  var dataJson = JSON.stringify({
    query: result.query,
    timestamp: new Date().toISOString(),
    searchStats: result.state && result.state.searchStats ? result.state.searchStats : null,
    scientificName: result.scientificName || null,
    regular: result.regular.map(function(p) { return exportPaperData(p); }),
    negative: result.negative.map(function(p) { return exportPaperData(p); }),
    allPapers: allPapers,
    aiConclusion: result.aiConclusion || '',
    gateReport: result.gateReport || null,
  }, null, 2);

  // Escape for data attribute
  var encoded = btoa(unescape(encodeURIComponent(dataJson)));

  return '<div style="text-align:center;margin:24px 0;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">' +
    '<button onclick="downloadExportJSON(\'' + encoded + '\')" style="padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-size:0.9rem;">📥 下載 JSON（匯入 verified_refs）</button>' +
    '<button onclick="downloadExportHTML(\'' + encoded + '\')" style="padding:10px 20px;background:#6b5e4f;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-size:0.9rem;">📄 下載 HTML 報告（Word 可開）</button>' +
    '<button onclick="copyExportJSON(\'' + encoded + '\')" style="padding:10px 20px;background:var(--accent-warm);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-size:0.9rem;">📋 複製 JSON</button>' +
    '</div>';
}

function exportPaperData(p) {
  var jq = typeof getJournalQuality === 'function' ? getJournalQuality(p) : null;
  return {
    title: p.title || '',
    title_zh: p.title_zh || '',
    doi: p.doi || '',
    authors: p.authors || [],
    journal: p.journal || '',
    year: p.year || null,
    citationCount: p.citationCount || 0,
    rankScore: p._rankScore || null,
    classification: p.classification ? {
      isNegative: p.classification.isNegative,
      score: p.classification.score,
      confidence: p.classification.confidence,
    } : null,
    finding: p.finding || '',
    why_matters: p.why_matters || '',
    abstract: p.abstract || '',
    doi_verified: p.doi_verified || false,
    doi_error: p.doi_error || null,
    source: p.source || '',
    sources: p.sources || null,
    journalQuality: jq ? { tier: jq.tier, h_index: jq.h_index } : null,
  };
}

function downloadExportJSON(encoded) {
  var json = decodeURIComponent(escape(atob(encoded)));
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'search_results_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('✅ JSON 已下載', '');
}

function downloadExportHTML(encoded) {
  var data = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  var html = buildExportHTML(data);
  var blob = new Blob(['﻿' + html], { type: 'text/html;charset=utf-8' });  // BOM for Word
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'search_report_' + new Date().toISOString().slice(0,10) + '.html';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('✅ HTML 報告已下載（可用 Word 開啟）', '');
}

function buildExportHTML(data) {
  var parts = [];
  parts.push('<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><title>不顯著結果文獻搜尋報告</title>');
  parts.push('<style>');
  parts.push('body{font-family:"Microsoft JhengHei",sans-serif;max-width:860px;margin:0 auto;padding:40px 20px;color:#3d3226;line-height:1.8;background:#fffef9;}');
  parts.push('h1{color:#6b8e4e;border-bottom:2px solid #6b8e4e;padding-bottom:8px;}');
  parts.push('h2{color:#6b8e4e;margin-top:32px;}');
  parts.push('.paper{margin:16px 0;padding:16px 20px;border:1px solid #d4c8b4;border-radius:8px;}');
  parts.push('.paper.negative{border-left:4px solid #c0392b;background:#fefaf9;}');
  parts.push('.paper .title{font-weight:700;font-size:1.05rem;}');
  parts.push('.paper .title-zh{font-size:0.9rem;color:#6b5e4f;margin-bottom:4px;}');
  parts.push('.paper .meta{font-size:0.9rem;color:#6b5e4f;margin:4px 0;}');
  parts.push('.paper .doi{font-size:0.85rem;color:#6b8e4e;}');
  parts.push('.paper .finding{margin-top:8px;}');
  parts.push('.paper .why-matters{background:#faf7f2;padding:12px 16px;border-radius:6px;margin-top:10px;}');
  parts.push('.conclusion{background:#f0f7e8;border:2px solid #6b8e4e;border-radius:10px;padding:24px 28px;margin-top:32px;}');
  parts.push('.badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:0.8rem;font-weight:700;margin-bottom:8px;}');
  parts.push('.badge.neg{background:#fde0dc;color:#c0392b;}');
  parts.push('.badge.pos{background:#e0ecf5;color:#2c5f8a;}');
  parts.push('.stats{font-size:0.85rem;color:#6b5e4f;margin:12px 0;padding:10px 14px;background:#faf8f3;border-radius:6px;}');
  parts.push('.ref-table{width:100%;font-size:0.78rem;border-collapse:collapse;margin-top:12px;}');
  parts.push('.ref-table th{background:#e8e0d4;text-align:left;padding:4px 8px;}');
  parts.push('.ref-table td{padding:4px 8px;border-bottom:1px solid #e8e0d4;}');
  parts.push('.gate-summary{font-size:0.82rem;margin-top:24px;padding:12px 16px;background:#faf8f3;border-radius:6px;}');
  parts.push('.sci-name{font-size:0.85rem;color:#6b8e4e;margin:8px 0;padding:6px 10px;background:#f0f7e8;border-radius:4px;}');
  parts.push('</style></head><body>');

  parts.push('<h1>📚 不顯著結果文獻搜尋報告</h1>');
  parts.push('<p><strong>搜尋主題：</strong>' + esc(data.query) + '</p>');
  parts.push('<p><strong>搜尋時間：</strong>' + esc(data.timestamp || '') + '</p>');

  // Source stats
  if (data.searchStats) {
    var ss = data.searchStats;
    var srcParts = [];
    var oaCount2 = (ss.sources && ss.sources.openalex) ? ss.sources.openalex : 0;
    var s2Count2 = (ss.sources && ss.sources.semantic_scholar) ? ss.sources.semantic_scholar : 0;
    var crCount2 = (ss.sources && ss.sources.crossref) ? ss.sources.crossref : 0;
    srcParts.push('OpenAlex: ' + oaCount2 + ' 篇');
    srcParts.push('Semantic Scholar: ' + s2Count2 + ' 篇');
    srcParts.push('CrossRef: ' + crCount2 + ' 篇');
    if (s2Count2 === 0 && (oaCount2 > 0 || crCount2 > 0)) {
      srcParts.push('⚠️ S2 無結果（可能對負面關鍵字敏感）');
    }
    var modeLabel = ss.mode === 'showcase' ? '展示模式' : '深度搜尋';
    parts.push('<div class="stats">' +
      '<strong>來源：</strong>OpenAlex + Semantic Scholar + CrossRef（真實學術資料庫）<br>' +
      '<strong>模式：</strong>' + modeLabel + ' · ' + esc(srcParts.join('，')) +
      ' → 去重後 ' + (ss.afterDedup || '?') + ' 篇 → 篩選後 ' + (ss.afterQuality || '?') + ' 篇' +
      '</div>');
  }

  // Scientific name
  if (data.scientificName && data.scientificName.genus) {
    var sciSource = data.scientificName.source || '';
    parts.push('<div class="sci-name">🧬 學名偵測：<b><i>' +
      esc(data.scientificName.genus.charAt(0).toUpperCase() + data.scientificName.genus.slice(1) +
      ' ' + (data.scientificName.species || 'sp.')) + '</i></b>' +
      (sciSource ? '（來源：' + esc(sciSource) + '）' : '') +
      '</div>');
  }

  // Regular papers
  if (data.regular && data.regular.length > 0) {
    parts.push('<h2>📊 一般文獻回顧 (' + data.regular.length + ' 篇)</h2>');
    data.regular.forEach(function(p) {
      parts.push(buildExportPaperHTML(p, 'pos'));
    });
  }

  // Negative papers
  if (data.negative && data.negative.length > 0) {
    parts.push('<h2>🔴 不顯著結果專區 (' + data.negative.length + ' 篇)</h2>');
    data.negative.forEach(function(p) {
      parts.push(buildExportPaperHTML(p, 'neg'));
    });
  } else {
    parts.push('<h2>🔴 不顯著結果專區 (0 篇)</h2>');
    parts.push('<p style="color:#6b5e4f;">⚠️ 本次搜尋未發現明確的不顯著結果論文。</p>');
  }

  // Complete reference list
  if (data.allPapers && data.allPapers.length > 0) {
    var sorted = data.allPapers.slice().sort(function(a, b) { return (b.year || 0) - (a.year || 0); });
    parts.push('<h2>📚 完整文獻清單（' + sorted.length + ' 篇，依年份新→舊）</h2>');
    parts.push('<table class="ref-table">');
    parts.push('<tr><th>年</th><th>論文標題</th><th style="text-align:center;">分數</th></tr>');
    sorted.forEach(function(p) {
      var scoreStr = p.rankScore != null ? p.rankScore.toFixed(3) : '-';
      var yearStr = p.year || '?';
      parts.push('<tr>' +
        '<td style="white-space:nowrap;">' + yearStr + '</td>' +
        '<td>' + esc(p.title || '(無標題)') + '</td>' +
        '<td style="text-align:center;white-space:nowrap;">' + scoreStr + '</td>' +
        '</tr>');
    });
    parts.push('</table>');
  }

  // Conclusion
  if (data.aiConclusion) {
    parts.push('<div class="conclusion"><h2>📝 總結與建議</h2><p>' + esc(data.aiConclusion).replace(/\n/g, '<br>') + '</p></div>');
  }

  // Gate summary (compact)
  if (data.gateReport && data.gateReport.gates) {
    parts.push('<div class="gate-summary">');
    parts.push('<strong>🛡️ 閘門檢查</strong><br>');
    data.gateReport.gates.forEach(function(g) {
      var icon = g.passed ? '✅' : '❌';
      parts.push(icon + ' ' + esc(g.name) + ': ' + esc(g.status || '') + '<br>');
    });
    parts.push('</div>');
  }

  parts.push('<p style="text-align:center;font-size:0.78rem;color:#9b8e7f;margin-top:24px;border-top:1px solid #d4c8b4;padding-top:16px;">');
  parts.push('莊淳聿 · 115 年暑期專討 · 園藝領域不顯著結果登錄系統倡議<br>');
  parts.push('學術來源：OpenAlex + Semantic Scholar + CrossRef 真實資料庫 · DOI 已驗證');
  parts.push('</p>');

  parts.push('</body></html>');
  return parts.join('\n');
}

function buildExportPaperHTML(p, badgeType) {
  var isNeg = badgeType === 'neg';
  var parts = [];
  parts.push('<div class="paper' + (isNeg ? ' negative' : '') + '">');
  parts.push('<span class="badge ' + (isNeg ? 'neg' : 'pos') + '">' + (isNeg ? '🔴 不顯著結果' : '📄 一般文獻') + '</span>');
  parts.push('<div class="title">' + esc(p.title) + '</div>');

  // Chinese title
  if (p.title_zh) {
    parts.push('<div class="title-zh">' + esc(p.title_zh) + '</div>');
  }

  var metaArr = [];
  if (p.authors && p.authors.length > 0) metaArr.push(formatAuthors(p.authors));
  if (p.journal) metaArr.push(p.journal);
  if (p.year) metaArr.push(p.year);
  var meta = metaArr.filter(Boolean).join(' · ');
  if (meta) parts.push('<div class="meta">' + esc(meta) + '</div>');

  // Journal quality
  if (p.journalQuality && p.journalQuality.tier) {
    var qColors = {Q1: '#2c8f3a', Q2: '#6b8e4e', Q3: '#c4943a', Q4: '#999'};
    var citStr = p.citationCount > 0 ? ' · 引用: ' + p.citationCount : '';
    parts.push('<div style="font-size:0.85rem;margin-bottom:4px;">' +
      '<span style="color:' + (qColors[p.journalQuality.tier] || '#999') + ';font-weight:700;">' + p.journalQuality.tier + '</span>' +
      ' · h-index: ' + p.journalQuality.h_index + citStr +
      (p.rankScore != null ? ' · 分數: ' + p.rankScore.toFixed(3) : '') +
      '</div>');
  } else if (p.citationCount > 0 || p.rankScore != null) {
    var extras = [];
    if (p.citationCount > 0) extras.push('引用: ' + p.citationCount);
    if (p.rankScore != null) extras.push('分數: ' + p.rankScore.toFixed(3));
    parts.push('<div style="font-size:0.85rem;color:#6b5e4f;">' + esc(extras.join(' · ')) + '</div>');
  }

  // Source
  if (p.sources && p.sources.length > 1) {
    parts.push('<div style="font-size:0.85rem;color:#6b8e4e;margin-bottom:4px;">📚 多來源確認：' + esc(p.sources.join(' + ')) + '</div>');
  } else if (p.source) {
    parts.push('<div style="font-size:0.85rem;color:#6b5e4f;margin-bottom:4px;">來源：' + esc(p.source) + '</div>');
  }

  // Classification
  if (p.classification && p.classification.isNegative) {
    parts.push('<div style="font-size:0.85rem;color:#c0392b;">🤖 不顯著結果分類信心：' + esc(p.classification.confidence || '') + '（分數：' + p.classification.score + '）</div>');
  }

  if (p.doi) {
    parts.push('<div class="doi">DOI: <a href="https://doi.org/' + esc(p.doi) + '">' + esc(p.doi) + '</a>' + (p.doi_verified ? ' ✓ 已驗證' : (p.doi_error ? ' ⚠️ ' + esc(p.doi_error) : '')) + '</div>');
  }

  // AI summary (finding = the Chinese abstract paragraph)
  if (p.finding) {
    parts.push('<div style="margin:8px 0;line-height:1.7;font-size:0.95rem;">' + esc(p.finding) + '</div>');
  }
  if (p.why_matters) {
    parts.push('<div class="why-matters"><strong>💡 對研究者的意義：</strong>' + esc(p.why_matters) + '</div>');
  }

  // Abstract snippet
  if (p.abstract) {
    var snippet = p.abstract.substring(0, 400);
    if (p.abstract.length > 400) snippet += '…';
    parts.push('<div style="font-size:0.85rem;color:#6b5e4f;margin-top:8px;line-height:1.6;">' + esc(snippet) + '</div>');
  }

  parts.push('</div>');
  return parts.join('\n');
}

function copyExportJSON(encoded) {
  var json = decodeURIComponent(escape(atob(encoded)));
  if (navigator.clipboard) {
    navigator.clipboard.writeText(json).then(function() {
      setStatus('✅ JSON 已複製到剪貼簿（可貼到 verified_refs.json）', '');
    }).catch(function() {
      setStatus('❌ 複製失敗，請改用下載', 'error');
    });
  } else {
    // Fallback
    var textarea = document.createElement('textarea');
    textarea.value = json;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    setStatus('✅ JSON 已複製到剪貼簿', '');
  }
}

// ═══════════════════════════════════════════════════════════
// SECTION 11: Pre-built Demos (expanded from verified_refs.json)
// ═══════════════════════════════════════════════════════════

window.PREBUILT = {};

(function() {
  // ── Demo 1: IBA Cutting Propagation (from verified data) ──
  var IBA_DEMO = [
    '<div class="section-title">🔍 IBA 濃度 扦插 發根——不顯著結果文獻回顧</div>',
    '<div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px;">📚 預建置範例（不需 API）。資料來源：CrossRef 已驗證文獻。</div>',

    '<div class="section-title">📊 一般文獻回顧 (5 篇)</div>',

    buildDemoPaperCard('pos', 'Events Associated with Early Age-Related Decline in Adventitious Rooting Competence of Eucalyptus globulus Labill',
      'Aumond ML, de Araujo AT, de Oliveira Junkes CF, de Almeida MR, Matsuura HN, de Costa F & Fett-Neto AG · Frontiers in Plant Science · 2017',
      '10.3389/fpls.2017.01734', true,
      '探討桉樹插穗隨著母株年齡增加而發生不定根能力衰退的分子機制。發現隨著母株成熟，與生長素運輸和訊號傳遞相關的基因表現顯著下降，導致插穗即使在外源 IBA 處理下也難以發根。',
      '如果你的物種跟桉樹一樣隨著母株年齡增加而難以發根——問題可能不在 IBA 濃度，而在生長素訊號傳遞路徑已随年齡下調。'),

    buildDemoPaperCard('pos', 'Molecular basis of differential adventitious rooting competence in poplar genotypes',
      'Ranjan A, Perrone I, Alallaq S, Singh R et al. · Journal of Experimental Botany · 2022',
      '10.1093/jxb/erac126', true,
      '比較不同發根能力的楊樹基因型，發現發根能力強和弱的基因型之間，關鍵差異不在生長素受體的數量，而在於生長素訊號下游的細胞壁重塑基因的表現量。',
      '如果你的物種 IBA 處理後仍然不發根，問題可能不在「給不夠生長素」——而是下游的細胞壁重塑機制沒有被啟動。'),

    buildDemoPaperCard('pos', 'Molecular basis of differential adventitious rooting competence in poplar genotypes — 難易發根物種的 auxin 調控差異',
      'Fogaca CM & Fett-Neto AG · Plant Growth Regulation · 2005',
      '10.1007/s10725-004-6547-7', true,
      '比較 E. saligna（易發根）vs. E. globulus（難發根），發現 auxin 中間穩定性的分子對難發根物種最有效。Ethylene 的角色很小——發根反應主要來自 auxin 的直接效應，而非間接路徑。',
      '如果馬告也是「難發根」物種，問題可能不在 auxin 濃度不夠，而在 auxin 的穩定性和代謝速度。'),

    buildDemoPaperCard('pos', '板栗扦插中 auxin 與 strigolactone 的時間動態',
      'Horticulturae · 2026',
      '10.3390/horticulturae12050575', true,
      '在難發根的板栗基因型中，游離 IAA 早期佔優勢，但 strigolactone 濃度升高——與不定根起始的抑制相關。發根能力取決於活性 auxin、不活性代謝物、與 strigolactone 之間的動態平衡。',
      'Strigolactone 是一個相對新的角色——它在扦插發根中可能是「抑制劑」。如果你的馬告插穗內生 strigolactone 偏高，可能解釋為什麼某些處理沒用。'),

    buildDemoPaperCard('pos', 'GABA 參與蘋果成熟期扦插發根障礙',
      'J Plant Growth Regul · 2021',
      '10.1007/s00344-020-10251-9', true,
      '在 Malus xiaojinensis 的成熟期插穗中，IBA 處理誘導 GABA 累積——而 GABA 會抑制極性 auxin 運輸（下調 PIN 基因），進而抑制不定根形成。',
      '這是一個「藥反而害」的經典案例——你加 IBA，結果誘導了 GABA 累積，GABA 反而抑制發根。'),

    '<div class="section-title">🔴 不顯著結果專區 (3 篇)</div>',

    buildDemoPaperCard('neg', 'Auxins Fail to Stimulate Rooting of Yellow-Poplar Cuttings (Liriodendron tulipifera)',
      'Huckenpahler BJ · Botanical Gazette · 1955',
      '10.1086/335892', true,
      '研究者對北美鵝掌楸插穗進行七次不同採集時間、多種 auxin 濃度、多種浸泡時間的處理——<strong>全部無法促進發根</strong>。',
      '如果你打算研究北美鵝掌楸的扦插繁殖——<strong>不要再測試 IBA 濃度了</strong>。1955 年就已經證明 auxin 對這個物種無效。'),

    buildDemoPaperCard('neg', 'IBA phytotoxicity in Campomanesia phaea cuttings',
      'Santos LC et al. · Acta Scientiarum. Agronomy · 2022',
      '10.4025/actasciagron.v44i1.53646', true,
      '高濃度 IBA 對 Campomanesia phaea 插穗產生明顯植物毒性：80% 落葉率、30 天存活率僅 5%。酚類物質含量與不定根抑制有顯著相關。',
      '對於酚類化合物含量高的物種（如馬告），IBA 濃度不是「愈高愈好」——過量 IBA 會誘導酚類氧化，產生植物毒性。'),

    buildDemoPaperCard('neg', 'Humic acid does not promote rooting of vegetative cuttings of Rhododendron',
      'Evans MR, Graves WR · Journal American Rhododendron Society · 2003',
      '', false,
      '測試腐植酸對杜鵑花插穗發根的影響。結果：<strong>腐植酸不僅沒有促進發根，在某些處理中死亡率高達 80–100%。</strong>',
      '腐植酸在農業上被廣泛宣傳為「土壤改良劑」，但在扦插繁殖中可能完全無效甚至有害。'),

    '<div class="conclusion-box">',
    '<div class="section-title">📝 總結與建議</div>',
    '<div class="paper-body">',
    '<strong>知識缺口：</strong>扦插繁殖研究中，不顯著結果的系統性記錄幾乎為零。大多數研究只報告「有效」的濃度和組合，對於「無效」或「有毒」的處理幾乎沒有正式發表。<br><br>',
    '<strong>已確認的失敗方向：</strong>(1) Auxin 對某些物種完全無效；(2) 高濃度 IBA 對酚類含量高的物種有毒；(3) 腐植酸並非萬能添加物；(4) GABA 路徑可能使 IBA 適得其反。<br><br>',
    '<strong>建議下一步：</strong>若研究難發根物種，應先測試內生酚類物質含量和 strigolactone 濃度，再決定 IBA 的濃度範圍。<br><br>',
    '<strong>建議投稿不顯著結果的期刊：</strong>PLOS ONE、F1000Research、BMC Research Notes、Journal of Trial and Error、Experimental Results (CUP)。',
    '</div>',
    '</div>',
    '<div class="disclaimer">📋 此為預建置示範內容，使用 CrossRef 已驗證文獻。設定 API key 後可搜尋任意主題。</div>',
  ].join('\n');

  window.PREBUILT['IBA'] = IBA_DEMO;

  // ── Demo 2: Registered Reports & Publication Bias ──
  var RR_DEMO = [
    '<div class="section-title">🔍 Registered Reports 與公開偏誤——不顯著結果的制度面解方</div>',
    '<div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px;">📚 預建置範例（不需 API）。資料來源：CrossRef 已驗證文獻。</div>',

    '<div class="section-title">📊 核心證據 (4 篇)</div>',

    buildDemoPaperCard('pos', 'Estimating the reproducibility of psychological science',
      'Open Science Collaboration · Science · 2015',
      '10.1126/science.aac4716', true,
      '100 個心理學經典效應中只有 36% 被成功複製。這是再現性危機的開端——也是推動 Registered Reports 和開放科學運動的關鍵論文。',
      '36%——這個數字本身就夠震撼。如果你在第三幕（證據）放這篇，聽眾會立刻理解為什麼這個議題重要。'),

    buildDemoPaperCard('pos', 'Investigating the replicability of preclinical cancer biology',
      'Errington TM et al. · eLife · 2021',
      '10.7554/eLife.71601', true,
      '53 個癌症生物學實驗中只有 5 個可以完整複製。不到 10% 的複製率——比心理學的 36% 更慘。',
      '這篇把再現性危機從心理學延伸到生物醫學。如果你的聽眾來自生農領域，這個數據比心理學的 36% 更能引起共鳴。'),

    buildDemoPaperCard('neg', 'Registered Reports 提升研究品質的初步證據',
      'Nature Human Behaviour · 2021',
      '10.1038/s41562-021-01142-4', true,
      '比較 Registered Reports 和傳統發表模式的研究品質。RRs 在方法嚴謹度和結果的可靠性上優於傳統論文。',
      '這是 Registered Reports 有效性的核心實證文獻之一。可以用來回應「RRs 會降低研究品質」的質疑。'),

    buildDemoPaperCard('neg', '結果的性質強烈預測選擇性報告——不顯著結果被系統性壓制的量化證據',
      'BMC Medical Research Methodology · 2024',
      '10.1186/s12874-024-02381-5', true,
      '不顯著結果 vs 正面結果的省略型選擇性報告的 OR = 7.39——不顯著結果被「選擇性忘記」的機率是正面結果的 7.39 倍。',
      '這可能是目前最強的量化證據，證明不顯著結果被系統性壓制。OR = 7.39 這個數字，是你在演講中可以用來震撼聽眾的數據。'),

    '<div class="conclusion-box">',
    '<div class="section-title">📝 總結</div>',
    '<div class="paper-body">',
    '公開偏誤不是某個領域的個案——從心理學（36% 複製率）到癌症生物學（<10%），這是跨領域的系統性問題。Registered Reports 提供了結構性解方：在研究執行前就接受審查，不管結果是正面的還是負面的都發表。不顯著結果被隱藏的機率是正面結果的 7.39 倍（OR = 7.39）。',
    '</div>',
    '</div>',
    '<div class="disclaimer">📋 此為預建置示範內容，使用 CrossRef 已驗證文獻。設定 API key 後可搜尋任意主題。</div>',
  ].join('\n');

  window.PREBUILT['RR'] = RR_DEMO;

  // ── Demo 3: Recalcitrant Species ──
  var RECALCITRANT_DEMO = [
    '<div class="section-title">🔍 難發根物種扦插繁殖——什麼方法「沒用」？</div>',
    '<div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px;">📚 預建置範例（不需 API）。資料來源：CrossRef 已驗證文獻。</div>',

    '<div class="section-title">📊 物種案例 (4 篇)</div>',

    buildDemoPaperCard('neg', '巴西本土樹種的扦插繁殖——低發根率的自然瓶頸',
      'Revista Árvore · 2016',
      '10.1590/0100-67622016000300006', true,
      '多種巴西本土樹種（包括 Myrtaceae 科）在扦插中表現極低的發根率，auxin 處理效果有限。某些物種的發根率低於 20%，被認為「不適合無性繁殖」。',
      '直接對應你的馬告（同為難扦插的本土樹種）。這篇記錄了「什麼方法對哪些本土樹種沒用」——這些資訊如果沒有被發表，每個做本土樹種扦插的研究者都要從零開始摸索。'),

    buildDemoPaperCard('neg', '山藥藤蔓插穗發根障礙的轉錄組分析',
      'BMC Plant Biology · 2025',
      '10.1186/s12870-025-07603-6', true,
      'Dioscorea polystachya（難發根，<5%）vs. D. alata（易發根，>70%）。難發根物種中 auxin 濃度遠低於易發根物種。外源 NAA 可促進發根。',
      '山藥藤蔓扦插的 <5% 發根率聽起來很熟悉？你的馬告可能也屬於這類「天生就很難」的物種。'),

    buildDemoPaperCard('neg', '不同 IBA 濃度對木薯扦插的影響——部分不顯著結果',
      'Revista Brasileira de Engenharia Agrícola e Ambiental · 2018',
      '10.1590/1807-1929/agriambi.v22n6p412-417', true,
      '雖然 IBA 有促進效果，但高濃度 IBA 導致插穗死亡率上升、根系品質下降。最適濃度遠低於一般建議的商用濃度。',
      '又是一個「多不一定好」的扦插案例。不要只用一個 IBA 濃度——要做劑量反應曲線。'),

    buildDemoPaperCard('pos', '林木成熟度相關的發根能力下降——2026 年最新回顧',
      'Plants · 2026',
      '10.3390/plants15132054', true,
      '系統性回顧林木隨著年齡/成熟度增加，不定根形成能力下降的調控路徑。這不是「處理沒用」的不顯著結果——而是「生物學上本來就有瓶頸」的結構性限制。',
      '母株年齡和成熟度可能是影響發根能力的關鍵變數——而這個變數在大多數扦插實驗中沒有被控制或報告。'),

    '<div class="conclusion-box">',
    '<div class="section-title">📝 總結</div>',
    '<div class="paper-body">',
    '許多本土樹種天生就難扦插（發根率 <20%）。auxin 處理對某些物種效果有限。高濃度 IBA 常常適得其反。在浪費時間測試更多 IBA 濃度之前，應該先了解：這個物種的發根障礙是在 auxin 訊號的哪一個環節？',
    '</div>',
    '</div>',
    '<div class="disclaimer">📋 此為預建置示範內容，使用 CrossRef 已驗證文獻。設定 API key 後可搜尋任意主題。</div>',
  ].join('\n');

  window.PREBUILT['RECALCITRANT'] = RECALCITRANT_DEMO;

  // ── Helper ──
  function buildDemoPaperCard(badgeType, title, meta, doi, verified, finding, whyMatters) {
    var isNeg = badgeType === 'neg';
    var badgeLabel = isNeg ? '🔴 不顯著結果' : '📄 一般文獻';
    var badgeClass = isNeg ? 'neg' : 'pos';
    var cardClass = isNeg ? 'paper-card negative' : 'paper-card';

    var parts = [];
    parts.push('<div class="' + cardClass + '">');
    parts.push('<span class="card-badge ' + badgeClass + '">' + badgeLabel + '</span>');
    parts.push('<div class="paper-title">' + esc(title) + '</div>');
    if (meta) parts.push('<div class="paper-meta">' + esc(meta) + '</div>');

    if (doi && verified) {
      parts.push('<div class="paper-doi">DOI: <a href="https://doi.org/' + esc(doi) + '" target="_blank">' + esc(doi) + '</a> ✓ 已驗證</div>');
    } else if (doi) {
      parts.push('<div class="paper-doi" style="color:var(--muted);font-size:0.82rem;">📎 無 DOI（學會期刊，可能未數位化）</div>');
    }

    if (finding) parts.push('<div class="paper-body">' + finding + '</div>');

    if (isNeg) {
      parts.push('<div style="font-size:0.78rem;color:var(--muted);margin-top:8px;">⚠️ 請自行查閱原文確認是否確實為不顯著結果。</div>');
    }

    if (whyMatters) {
      var label = isNeg ? '💡 對後續研究者的啟示（這個「沒用」可以省下什麼？）' : '💡 對研究者的意義';
      parts.push(
        '<div class="insight-box">' +
        '<div class="insight-label">' + label + '</div>' +
        '<div class="insight-text">' + esc(whyMatters) + '</div>' +
        '</div>'
      );
    }

    parts.push('</div>');
    return parts.join('\n');
  }
})();

// ═══════════════════════════════════════════════════════════
// SECTION 12: UI Controller
// ═══════════════════════════════════════════════════════════

var currentResult = null;  // Store last search result for export

function setStatus(msg, cls) {
  var s = document.getElementById('status');
  s.innerHTML = msg;
  s.className = 'status ' + (cls || '');
}

// ── Progress Bar ──
var PR = { step: 0, total: 4 };
function progressStart() {
  PR.step = 0; PR.total = 4;
  var wrap = document.getElementById('progressWrap');
  if (wrap) wrap.classList.add('active');
  var fill = document.getElementById('progressFill');
  if (fill) fill.style.width = '0%';
  ['stage1','stage2','stage3','stage4'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.className = '';
  });
}
function progressNext(label) {
  PR.step++;
  var pct = Math.round((PR.step / PR.total) * 100);
  var fill = document.getElementById('progressFill');
  if (fill) fill.style.width = pct + '%';
  var stageEl = document.getElementById('stage' + PR.step);
  if (stageEl) stageEl.className = 'current';
  if (PR.step > 1) {
    var prev = document.getElementById('stage' + (PR.step - 1));
    if (prev) prev.className = 'done';
  }
  setStatus('<span class="spinner"></span> ' + label, 'loading');
}
function progressDone() {
  var fill = document.getElementById('progressFill');
  if (fill) fill.style.width = '100%';
  ['stage1','stage2','stage3','stage4'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.className = 'done';
  });
  setTimeout(function() {
    var wrap = document.getElementById('progressWrap');
    if (wrap) wrap.classList.remove('active');
  }, 1000);
}

// ── Demo Showcase ──
function showDemo(key) {
  var reportDiv = document.getElementById('report');
  if (window.PREBUILT && window.PREBUILT[key]) {
    reportDiv.innerHTML = window.PREBUILT[key];
    reportDiv.classList.add('visible');
    setStatus('📋 範例展示（內建內容，不需 API）', '');
    reportDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function fillSearch(query) {
  document.getElementById('searchInput').value = query;
}

// ── Live Search ──
async function doSearch() {
  var query = document.getElementById('searchInput').value.trim();
  if (!query) { setStatus('請輸入搜尋關鍵字', 'error'); return; }

  var reportDiv = document.getElementById('report');
  var searchBtn = document.getElementById('searchBtn');

  _aiErrors = []; _aiRunning = false;
  progressStart();
  searchBtn.disabled = true;
  reportDiv.classList.remove('visible');
  reportDiv.innerHTML = '';

  var phaseLabels = {
    1: '🔍 多來源搜尋中…',
    2: '🔬 NLP 分類中…',
    3: '✅ DOI 驗證中…',
    4: '📝 彙整報告中…',
  };

  var result = await runFullSearchPipeline(query, {
    onPhase: function(phase, msg) { progressNext(phaseLabels[phase] || msg); },
    onGate: function(gateResult) {},
    onProgress: function(stage, done, total) {},
    onError: function(err) { setStatus('❌ ' + (err.message || '未知錯誤'), 'error'); },
  });

  progressDone();

  if (result.papers.length === 0) {
    reportDiv.innerHTML = renderDiagnostics(result, query);
    reportDiv.classList.add('visible');
    setStatus('⚠️ 未找到文獻', 'error');
    reportDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    searchBtn.disabled = false;
    return;
  }

  currentResult = result;

  // ── Set preliminary AI diagnostics BEFORE first render ──
  if (getApiKey()) {
    _aiRunning = true;
    // Use displayed papers (regular + negative), same as runAIBackground
    var prelimPapers = (result.regular || []).concat(result.negative || []).slice(0, 10);
    result._aiDiagnostics = {
      timestamp: new Date().toISOString(),
      papersSent: prelimPapers.length,
      aiSuccess: false,
      aiError: null,
      conclusionLen: 0,
      regularCount: -1,   // -1 = pending
      negativeCount: -1,
      aiPValues: { regular: [], negative: [] },
      perPaper: prelimPapers.map(function(p, i) {
        return {
          index: i, paperNum: i + 1,
          title: (p.title || '?').substring(0, 60),
          classification: (p.classification && p.classification.isNegative) ? 'negative' : 'regular',
          mapped: false, reason: '等待 AI 回應中…',
          findingLen: 0, whyLen: 0, titleZhLen: (p.title_zh || '').length,
          _fullTitle: p.title || '', _doi: p.doi || ''
        };
      }),
      mappedCount: -1,
      unmappedPapers: [],
      mappingMethod: 'p-field lookup (1-indexed → array index)',
      anomalies: [],
      pending: true
    };
  }

  // ── Render immediately (AI diagnostics panel shows pending if API key set) ──
  reportDiv.innerHTML = renderReport(result);
  reportDiv.classList.add('visible');

  var totalPapers = result.papers.length;
  var negCount = result.negative ? result.negative.length : 0;
  var verifiedCount = result.papers.filter(function(p) { return p.doi_verified; }).length;
  var statusMsg = '✅ 搜尋完成：' + totalPapers + ' 篇論文（' + negCount + ' 篇不顯著結果，' + verifiedCount + ' 篇 DOI 已驗證）';
  if (!result.gateReport.allPassed && result.gateReport.warnings.length > 0) {
    statusMsg += ' ⚠️ ' + result.gateReport.warnings.length + ' 項建議';
  }
  setStatus(statusMsg, result.success ? '' : 'error');
  reportDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  searchBtn.disabled = false;

  // ── AI in background (non-blocking) ──
  if (getApiKey()) {
    setStatus(statusMsg + ' 🤖 AI 分析中…', '');
    runAIBackground(result, query).then(function(aiOk) {
      if (aiOk) setStatus(statusMsg + ' [AI 摘要]', '');
      else setStatus(statusMsg, '');
    });
  }
}

async function translateTitles(papers) {
  // Translate titles one at a time — avoids Google's newline-segment concatenation bug
  // where 8 titles joined by \n return 8 segments that get concatenated without separators,
  // causing split('\n') to fail and only the first paper getting a (giant) title_zh.
  var titles = papers.map(function(p) { return p.title || ''; }).filter(Boolean);
  if (!titles.length) return;
  var translatedCount = 0;

  // Build an index map: title → array of paper indices (handles duplicate titles)
  var titleToIndices = {};
  papers.forEach(function(p, i) {
    if (!p.title) return;
    var t = p.title.trim();
    if (!titleToIndices[t]) titleToIndices[t] = [];
    titleToIndices[t].push(i);
  });

  var uniqueTitles = Object.keys(titleToIndices);
  console.log('[AI] translateTitles: ' + uniqueTitles.length + ' unique titles to translate');

  for (var t = 0; t < uniqueTitles.length; t++) {
    try {
      var result = await translateViaGoogle(uniqueTitles[t], 'en', 'zh-TW');
      if (result && result.trim()) {
        var zh = result.trim();
        // Assign to all papers with this title
        var indices = titleToIndices[uniqueTitles[t]];
        for (var j = 0; j < indices.length; j++) {
          papers[indices[j]].title_zh = zh;
        }
        translatedCount += indices.length;
      }
      // Small delay between calls to avoid rate limiting on free endpoint
      if (t < uniqueTitles.length - 1) {
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }
    } catch(e) {
      // Individual title translation failed — continue with next
    }
  }
  console.log('[AI] translateTitles: ' + translatedCount + '/' + papers.length + ' titles translated');
}

// ── Run AI summarization in background ──
async function runAIBackground(result, query) {
  _aiRunning = true;
  // Process papers that actually get displayed (regular + negative sections),
  // NOT result.papers.slice(0,8) which is by rank score — rank top-8 may be
  // dominated by negative papers, leaving displayed regular papers without AI.
  var displayPapers = (result.regular || []).concat(result.negative || []);
  var papers = displayPapers.slice(0, 10);  // Up to 10 displayed papers
  console.log('[AI] translateTitles start, papers=' + papers.length + ' (from displayed regular+negative)');
  await translateTitles(papers);
  console.log('[AI] translateTitles done, calling summarizeWithGemini...');
  var ai = await summarizeWithGemini(papers, query);
  _aiRunning = false;
  console.log('[AI] summarizeWithGemini result:', ai ? 'OK (conclusion=' + (ai.conclusion||'').substring(0,40) + '..., regular=' + (ai.regular||[]).length + ', negative=' + (ai.negative||[]).length + ')' : 'NULL — AI call failed');

  // ── Build diagnostics regardless of success/failure ──
  var diag = {
    timestamp: new Date().toISOString(),
    papersSent: papers.length,
    aiSuccess: !!ai,
    aiError: _lastAIError || null,
    conclusionLen: ai && ai.conclusion ? ai.conclusion.length : 0,
    regularCount: ai && ai.regular ? ai.regular.length : 0,
    negativeCount: ai && ai.negative ? ai.negative.length : 0,
    aiPValues: { regular: [], negative: [] },
    perPaper: [],
    mappedCount: 0,
    unmappedPapers: [],
    mappingMethod: 'p-field lookup (1-indexed → array index)',
  };

  // Record all "p" values from AI response
  if (ai) {
    if (ai.regular) ai.regular.forEach(function(item) { diag.aiPValues.regular.push(item.p); });
    if (ai.negative) ai.negative.forEach(function(item) { diag.aiPValues.negative.push(item.p); });
  }

  if (!ai) {
    // AI failed — record per-paper status as unmapped
    papers.forEach(function(p, i) {
      diag.perPaper.push({
        index: i, paperNum: i + 1,
        title: (p.title || '?').substring(0, 60),
        classification: (p.classification && p.classification.isNegative) ? 'negative' : 'regular',
        mapped: false, reason: 'AI call returned null',
        findingLen: 0, whyLen: 0, titleZhLen: (p.title_zh || '').length,
        _fullTitle: p.title || '', _doi: p.doi || ''
      });
    });
    result._aiDiagnostics = diag;
    return false;
  }

  result.aiConclusion = ai.conclusion;
  result._aiSummaries = ai;

  // ── Build p-field lookup table ──
  var aiByPaperNum = {};
  var duplicatePNs = [];  // Track duplicate p-values (AI bug indicator)
  (ai.regular || []).forEach(function(item) {
    var pn = +item.p;  // Coerce to number (AI might return string)
    if (!isNaN(pn)) {
      if (aiByPaperNum[pn]) duplicatePNs.push(pn);
      aiByPaperNum[pn] = { source: 'regular', finding: item.finding, why_matters: item.why_matters };
    }
  });
  (ai.negative || []).forEach(function(item) {
    var pn = +item.p;
    if (!isNaN(pn)) {
      if (aiByPaperNum[pn]) duplicatePNs.push(pn);
      aiByPaperNum[pn] = { source: 'negative', finding: item.finding, why_matters: item.why_matters };
    }
  });
  if (duplicatePNs.length > 0) {
    console.log('[AI] ⚠️ duplicate p-values detected (last wins):', duplicatePNs);
  }

  // ── Map using p-field ──
  var mapped = 0;
  papers.forEach(function(p, i) {
    var paperNum = i + 1;
    var aiEntry = aiByPaperNum[paperNum];
    var isNeg = p.classification && p.classification.isNegative;
    var status = {
      index: i, paperNum: paperNum,
      title: (p.title || '?').substring(0, 60),
      classification: isNeg ? 'negative' : 'regular',
    };

    if (aiEntry) {
      p.ai_finding = aiEntry.finding || '';
      p.ai_why_matters = aiEntry.why_matters || '';
      mapped++;
      status.mapped = true;
      status.aiSource = aiEntry.source;
      status.classMatch = (aiEntry.source === status.classification);
      status.findingLen = (aiEntry.finding || '').length;
      status.whyLen = (aiEntry.why_matters || '').length;
      status.findingPreview = (aiEntry.finding || '').substring(0, 40);
      status.titleZhLen = (p.title_zh || '').length;
      status._fullTitle = p.title || '';
      status._doi = p.doi || '';
    } else {
      status.mapped = false;
      status.reason = 'AI 未回傳 p=' + paperNum + ' 的摘要（p-values found: ' + JSON.stringify(diag.aiPValues) + '）';
      status.findingLen = 0;
      status.whyLen = 0;
      status.titleZhLen = (p.title_zh || '').length;
      status._fullTitle = p.title || '';
      status._doi = p.doi || '';
    }
    diag.perPaper.push(status);
  });

  diag.mappedCount = mapped;
  diag.unmappedPapers = diag.perPaper.filter(function(s) { return !s.mapped; }).map(function(s) { return s.paperNum; });

  // ── Detect anomalies ──
  diag.anomalies = [];
  if (duplicatePNs.length > 0) {
    diag.anomalies.push('AI 回傳重複 p 值：p=' + duplicatePNs.join(',p=') + '（後者覆蓋前者，可能導致摘要錯位）');
  }
  if (mapped < papers.length) {
    diag.anomalies.push('只配對了 ' + mapped + '/' + papers.length + ' 篇（缺 p=' + diag.unmappedPapers.join(',') + '）');
  }
  diag.perPaper.forEach(function(s) {
    if (s.mapped && !s.classMatch) {
      diag.anomalies.push('p=' + s.paperNum + ' 分類不一致：本地=' + s.classification + ' AI=' + s.aiSource);
    }
  });
  var totalAIEntries = diag.regularCount + diag.negativeCount;
  if (totalAIEntries < papers.length) {
    diag.anomalies.push('AI 回傳 ' + totalAIEntries + ' 筆，但送出了 ' + papers.length + ' 篇論文（缺 ' + (papers.length - totalAIEntries) + ' 筆）');
  }
  if (totalAIEntries > papers.length) {
    diag.anomalies.push('AI 回傳了 ' + totalAIEntries + ' 筆，比送出的 ' + papers.length + ' 篇還多（可能有虛構 p 值）');
  }

  // ── Log summary ──
  console.log('[AI] mapped ' + mapped + '/' + papers.length + ' papers via p-field lookup');
  if (diag.anomalies.length > 0) {
    console.log('[AI] ⚠️ anomalies:', diag.anomalies.join('; '));
  }
  console.log('[AI] diagnostics:', JSON.stringify({
    papersSent: diag.papersSent, mapped: diag.mappedCount,
    aiPValues: diag.aiPValues, unmapped: diag.unmappedPapers,
    anomalies: diag.anomalies
  }));

  result._aiDiagnostics = diag;

  var reportDiv = document.getElementById('report');
  if (reportDiv) reportDiv.innerHTML = renderReport(result);
  return mapped > 0;
}

// ── Settings ──
document.addEventListener('DOMContentLoaded', function() {
  // Restore saved API key (supports both old and new storage keys)
  var saved = localStorage.getItem('ai_api_key') || localStorage.getItem('gemini_api_key');
  if (saved) document.getElementById('apiKeyInput').value = saved;
  if (DEMO_KEY && !saved) {
    document.getElementById('apiKeyInput').placeholder = '(示範模式已啟用)';
  }

  // API key change handler
  document.getElementById('apiKeyInput').addEventListener('change', function() {
    var val = this.value.trim();
    if (val) localStorage.setItem('ai_api_key', val);
    else localStorage.removeItem('ai_api_key');
  });
});

function setSearchMode(mode) {
  SEARCH_CONFIG.mode = mode;
  var showcaseBtn = document.getElementById('modeShowcase');
  var deepBtn = document.getElementById('modeDeep');
  if (showcaseBtn && deepBtn) {
    if (mode === 'showcase') {
      showcaseBtn.style.background = 'var(--accent)';
      showcaseBtn.style.color = '#fff';
      showcaseBtn.style.border = 'none';
      deepBtn.style.background = '#e8e0d4';
      deepBtn.style.color = 'var(--text)';
      deepBtn.style.border = '1px solid var(--border)';
    } else {
      deepBtn.style.background = 'var(--accent)';
      deepBtn.style.color = '#fff';
      deepBtn.style.border = 'none';
      showcaseBtn.style.background = '#e8e0d4';
      showcaseBtn.style.color = 'var(--text)';
      showcaseBtn.style.border = '1px solid var(--border)';
    }
  }
  setStatus('已切換至「' + (mode === 'showcase' ? '展示模式（5+5 篇）' : '深度搜尋（完整結果）') + '」', '');
}

function toggleSettings() {
  document.getElementById('settingsPanel').classList.toggle('open');
}

// ═══ SELF-TEST: open with ?test ═══
if (window.location.search.indexOf('test') !== -1) {
  document.addEventListener('DOMContentLoaded', function() {
    var ok=0, fail=0, results=[];
    function T(n,fn){try{var r=fn();if(r){ok++;results.push({name:n,pass:true})}else{fail++;results.push({name:n,pass:false,msg:r===false?'failed':r})}}catch(e){fail++;results.push({name:n,pass:false,msg:e.message})}}
    function EQ(g,w,n){T(n||(JSON.stringify(g)+'='+JSON.stringify(w)),function(){return JSON.stringify(g)===JSON.stringify(w)?true:'got '+JSON.stringify(g)})}

    T('cleanApiText: HTML entities', function(){return cleanApiText('&lt;em&gt;Litsea&lt;/em&gt;')==='Litsea'});
    T('cleanApiText: whitespace', function(){return cleanApiText('  a  b ')==='a b'});
    T('cleanApiText: null', function(){return cleanApiText(null)===''});
    EQ(extractEnglishText('litsea cubeba扦插'),['litsea','cubeba'],'extractEnglishText: mixed');
    T('jaccard: identical',function(){return jaccardSimilarity('Litsea propagation','Litsea propagation')>0.9});
    T('jaccard: different',function(){return jaccardSimilarity('Litsea propagation','Fraser fir')<0.2});
    T('classifyPaper: strong negative',function(){var c=classifyPaper({title:'T',abstract:'no significant effect on rooting'});return c.isNegative&&c.score>=4});
    T('classifyPaper: positive title override',function(){var c=classifyPaper({title:'Fungal Extract Promotes Rooting',abstract:'recalcitrant woody species'});return !c.isNegative});
    EQ(getNegJournalTier({issn_l:'2667-0904'}),1,'journal: Trial and Error → Tier 1');
    EQ(getNegJournalTier({issn_l:'1932-6203'}),2,'journal: PLOS ONE → Tier 2');
    T('isDirectlyRelevant: match',function(){return isDirectlyRelevant({title:'Litsea cubeba'},{_plantTerms:['litsea']})===true});
    T('isDirectlyRelevant: mismatch',function(){return isDirectlyRelevant({title:'Fraser fir',abstract:'Abies'},{_plantTerms:['litsea']})===false});
    T('dedup: same DOI→1',function(){return deduplicatePapers([{doi:'10.1234/x',title:'Litsea propagation study'},{doi:'10.1234/x',title:'Litsea propagation dup'}]).length===1});
    T('rerank: high relevance first',function(){var p=[{title:'A',_relevance:0.3,year:2000},{title:'B',_relevance:0.9,year:2025}];rerankPapers(p);return p[0].title==='B'});
    T('fallback: no key shows hint',function(){var r=buildFallbackWhyMatters({journal:'J',year:2025});return r.indexOf('API key')!==-1||r.indexOf('Ollama')!==-1});
    T('hasChinese',function(){return hasChinese('大岩桐')&&!hasChinese('litsea')});
    T('KNOWN_PLANT_NAMES',function(){return KNOWN_PLANT_NAMES.has('litsea')&&!KNOWN_PLANT_NAMES.has('cuttings')});
    T('known plant terms',function(){var p=extractPlantTerms(['litsea','cubeba','cuttings','vegetative']);return p.length===2&&p.indexOf('cuttings')===-1});

    var body='<div style="max-width:800px;margin:40px auto;font-family:system-ui,sans-serif"><h1>🧪 Self-Test</h1><p>'+ok+'/'+(ok+fail)+' passed'+(fail>0?' · <span style=color:#a0524a>'+fail+' failed</span>':'')+'</p><hr>';
    results.forEach(function(r){body+='<div style=padding:4px 0;color:'+(r.pass?'#6b8e4e':'#a0524a')+'>'+(r.pass?'✓':'✗')+' '+r.name+(r.msg?' — '+r.msg:'')+'</div>'});
    body+='</div>';document.body.innerHTML=body;document.title='🧪 Self-Test';
  });
}
