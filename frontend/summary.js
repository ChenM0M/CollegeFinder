// CollegeFinder Summary Page
const UI_VERSION = '2026-03-02-1';
let API_BASE = '/api';

const SUBJECTS = [
    { key: 'chinese', label: '国文' },
    { key: 'english', label: '英文' },
    { key: 'math_a', label: '数学A' },
    { key: 'math_b', label: '数学B' },
    { key: 'social', label: '社会' },
    { key: 'science', label: '自然' },
];

const STANDARD_RANK = {
    '底标': 1,
    '后标': 2,
    '均标': 3,
    '前标': 4,
    '顶标': 5,
};

const TIER_RANK = {
    '非双一流': 1,
    '双一流': 2,
    '211': 3,
    '985': 4,
};

const CONF_RANK = {
    low: 1,
    medium: 2,
    high: 3,
};

const CHOICE_WORDS = [
    '任一',
    '任一科',
    '任一门',
    '任一門',
    '任一项',
    '任一項',
    '其一',
    '择一',
    '擇一',
    '之一',
    '任意',
    '多者其一',
    '其中一',
    '任何一',
    '任何一科',
    '任何一门',
    '任何一門',
    '任何一项',
    '任何一項',
];

const STORAGE_KEY_SCORES = 'collegefinder.summary.user_scores.v1';
const STORAGE_KEY_SELECTED_MAJORS = 'collegefinder.summary.selected_majors.v1';
const STORAGE_KEY_OPPTY = 'collegefinder.summary.oppty_settings.v1';
const STORAGE_KEY_LANG = 'collegefinder.ui.lang.v1';

let UI_LANG = loadUiLang();
let _CN2T = null;

function loadUiLang() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_LANG);
        if (raw === 'zh-TW' || raw === 'zh-CN') return raw;
    } catch (e) {
        // ignore
    }
    return 'zh-CN';
}

function ensureCn2t() {
    if (UI_LANG !== 'zh-TW') return null;
    if (_CN2T) return _CN2T;
    try {
        if (typeof OpenCC !== 'undefined' && OpenCC && typeof OpenCC.Converter === 'function') {
            _CN2T = OpenCC.Converter({ from: 'cn', to: 'tw' });
        }
    } catch (e) {
        _CN2T = null;
    }
    return _CN2T;
}

function toUI(s) {
    const str = String(s ?? '');
    const conv = ensureCn2t();
    if (UI_LANG === 'zh-TW' && conv) {
        try {
            return conv(str);
        } catch (e) {
            return str;
        }
    }
    return str;
}

function setText(el, text) {
    if (!el) return;
    el.textContent = toUI(text);
}

function setHtml(el, html) {
    if (!el) return;
    el.innerHTML = toUI(html);
}

function applyLangToStaticDom() {
    try {
        document.documentElement.setAttribute('lang', UI_LANG);
    } catch (e) {
        // ignore
    }

    if (UI_LANG !== 'zh-TW') return;
    const conv = ensureCn2t();
    if (!conv) return;

    // Convert placeholders / titles / aria-labels
    document.querySelectorAll('[placeholder]').forEach(el => {
        const v = el.getAttribute('placeholder');
        if (v) el.setAttribute('placeholder', toUI(v));
    });
    document.querySelectorAll('[title]').forEach(el => {
        const v = el.getAttribute('title');
        if (v) el.setAttribute('title', toUI(v));
    });
    document.querySelectorAll('[aria-label]').forEach(el => {
        const v = el.getAttribute('aria-label');
        if (v) el.setAttribute('aria-label', toUI(v));
    });

    // Convert visible text nodes (skip scripts/styles)
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                const tag = (p.tagName || '').toUpperCase();
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                if (p.closest('.ignore-opencc')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => {
        n.nodeValue = toUI(n.nodeValue);
    });
}

function initLangSwitch() {
    const wrap = document.getElementById('lang-switch');
    if (!wrap) return;
    const btns = Array.from(wrap.querySelectorAll('button[data-lang]'));
    if (!btns.length) return;

    const update = () => {
        btns.forEach(btn => {
            const lang = String(btn.dataset.lang || '');
            const active = lang === UI_LANG;
            btn.classList.toggle('bg-gray-900', active);
            btn.classList.toggle('text-white', active);
            btn.classList.toggle('bg-white', !active);
            btn.classList.toggle('text-gray-700', !active);
        });
    };

    update();

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            const lang = String(btn.dataset.lang || '');
            if (lang !== 'zh-CN' && lang !== 'zh-TW') return;
            if (lang === UI_LANG) return;
            try {
                localStorage.setItem(STORAGE_KEY_LANG, lang);
            } catch (e) {
                // ignore
            }
            window.location.reload();
        });
    });
}

function noCacheUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_ts=${Date.now()}`;
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(noCacheUrl(url), { signal: controller.signal, cache: 'no-store' });
    } finally {
        clearTimeout(timer);
    }
}

async function detectApiBase() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        try {
            const resp = await fetchWithTimeout('/api/status', 1500);
            if (resp.ok) return '/api';
        } catch (e) {
            // ignore
        }
    }

    const candidates = [8000, 8001, 8002, 8003, 8004, 8005, 4567];
    for (const port of candidates) {
        try {
            const resp = await fetchWithTimeout(`http://localhost:${port}/api/status`, 1500);
            if (resp.ok) return `http://localhost:${port}/api`;
        } catch (e) {
            // ignore
        }
    }

    return 'http://localhost:8000/api';
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractFirstUrl(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    const m = s.match(/https?:\/\/[^\s]+/i);
    if (m && m[0]) {
        return m[0].replace(/[)\],.，。；;]+$/g, '');
    }
    return s;
}

function formatReq(req) {
    if (!req) return '-';
    const std = req.standard || '';
    const ms = req.min_score;
    if (std && ms) return `${std}(${ms}级)`;
    if (std) return std;
    if (ms) return `(${ms}级)`;
    return '-';
}

function parseStandard(std) {
    const raw = String(std || '').trim();
    if (!raw) return { rank: null, any: false, base: '' };

    let any = false;
    let s = raw;

    // normalize common any-of prefixes (we persist as "任一X标")
    if (s.startsWith('任一')) {
        any = true;
        s = s.slice(2);
    } else if (s.startsWith('任何一')) {
        any = true;
        s = s.replace(/^任何一(?:科|門|门|項|项)?/, '');
    }

    // strip common suffixes
    s = s.replace(/(级以上|級以上|以上)$/, '');
    s = s.trim();

    const rank = STANDARD_RANK[s] || null;
    return { rank, any, base: s };
}

function standardRank(std) {
    return parseStandard(std).rank;
}

function tierRank(tier) {
    const t = String(tier || '非双一流').trim();
    return TIER_RANK[t] || 1;
}

function confidenceRank(conf) {
    const c = String(conf || '').toLowerCase();
    return CONF_RANK[c] || 0;
}

function isReqEmpty(req) {
    if (!req) return true;
    return !req.standard && !req.min_score;
}

function normalizeReq(req) {
    const r = (req && typeof req === 'object') ? req : {};
    return {
        standard: r.standard || null,
        min_score: (typeof r.min_score === 'number') ? r.min_score : null,
    };
}

function mergeRequirements(gen, deptSubjects) {
    const g = (gen && typeof gen === 'object') ? gen : {};
    const d = (deptSubjects && typeof deptSubjects === 'object') ? deptSubjects : null;
    const out = {};

    for (const { key } of SUBJECTS) {
        const dv = d ? normalizeReq(d[key]) : null;
        const gv = normalizeReq(g[key]);

        if (dv && (dv.standard || dv.min_score)) {
            out[key] = dv;
        } else if (gv.standard || gv.min_score) {
            out[key] = gv;
        } else {
            out[key] = { standard: null, min_score: null };
        }
    }
    return out;
}

function hasAnyRequirements(reqs) {
    return SUBJECTS.some(({ key }) => {
        const r = reqs ? reqs[key] : null;
        return r && (r.standard || r.min_score);
    });
}

function hasChoiceExpression(text) {
    const t = String(text || '');
    return CHOICE_WORDS.some(w => t.includes(w));
}

function detectSubjectKeys(text) {
    const t = String(text || '').replace(/（/g, '(').replace(/）/g, ')');
    const keys = [];

    // 数学A/B并列写法（如 数学A/B、数学A或B）
    if (/(数学|數學)\s*[AaＡ].{0,4}[/、,，及和與与或].{0,4}[BbＢ]/.test(t)) {
        keys.push('math_a', 'math_b');
    }

    if (t.includes('语文') || t.includes('國文') || t.includes('国文')) keys.push('chinese');
    if (t.includes('英语') || t.includes('英文')) keys.push('english');
    if (t.includes('数学A') || t.includes('數學A')) keys.push('math_a');
    if (t.includes('数学B') || t.includes('數學B')) keys.push('math_b');

    // 仅写“数学”时，通常表示数学(A/B均可或未区分)
    if ((t.includes('数学') || t.includes('數學')) && !keys.includes('math_a') && !keys.includes('math_b')) {
        keys.push('math_a', 'math_b');
    }

    if (t.includes('社会') || t.includes('社會')) keys.push('social');
    if (t.includes('自然')) keys.push('science');

    // de-dup
    return Array.from(new Set(keys));
}

function expandChoiceSubjectKeys(text, keys) {
    const t = String(text || '');
    const out = Array.from(new Set(keys || []));
    if (!hasChoiceExpression(t)) return out;

    if (t.includes('四科') || t.includes('四门') || t.includes('四項') || t.includes('四项') || t.includes('四科目')) {
        for (const k of ['chinese', 'english', 'math_a', 'math_b']) {
            if (!out.includes(k)) out.push(k);
        }
    }

    if (/(数学|數學)\s*[AaＡ].{0,4}[/、,，及和與与或].{0,4}[BbＢ]/.test(t)) {
        if (!out.includes('math_a')) out.push('math_a');
        if (!out.includes('math_b')) out.push('math_b');
    }

    return Array.from(new Set(out));
}

function extractChoiceGroups(text) {
    const raw = String(text || '');
    if (!hasChoiceExpression(raw)) return [];
    const cleaned = raw.replace(/\s+/g, '');
    const groups = [];

    const re = /((?:国文|國文|语文|英文|英语|数学A|數學A|数学B|數學B|数学|數學|社会|社會|自然|四科|四门|四項|四项|四科目)[^。；;]{0,40}?)(任一科|任一門|任一门|任一項|任一项|任一|其一|择一|擇一|之一|任意|多者其一|其中一|任何一科|任何一門|任何一门|任何一項|任何一项|任何一)/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const seg = m[1] || '';
        let keys = detectSubjectKeys(seg);
        keys = expandChoiceSubjectKeys(seg, keys);
        if (keys.length) groups.push(keys);
    }

    if (!groups.length) {
        let keys = detectSubjectKeys(cleaned);
        keys = expandChoiceSubjectKeys(cleaned, keys);
        if (keys.length) groups.push(keys);
    }

    // de-dup groups by signature
    const seen = new Set();
    const out = [];
    for (const g of groups) {
        const sig = g.slice().sort().join('|');
        if (sig && !seen.has(sig)) {
            seen.add(sig);
            out.push(g);
        }
    }
    return out;
}

function extractChoiceGroupsFromReqs(reqs) {
    const requirements = reqs || {};
    const byBase = new Map();

    for (const { key } of SUBJECTS) {
        const v = requirements[key];
        if (!v || !v.standard) continue;
        const p = parseStandard(v.standard);
        if (!p.any || !p.rank || !p.base) continue;

        if (!byBase.has(p.base)) byBase.set(p.base, []);
        byBase.get(p.base).push(key);
    }

    const groups = [];
    for (const g of byBase.values()) {
        const uniq = Array.from(new Set(g));
        if (uniq.length >= 2) groups.push(uniq);
    }
    return groups;
}

function mergeChoiceGroups(...lists) {
    const seen = new Set();
    const out = [];
    for (const groups of lists) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
            if (!Array.isArray(g) || g.length === 0) continue;
            const uniq = Array.from(new Set(g));
            const sig = uniq.slice().sort().join('|');
            if (!sig || seen.has(sig)) continue;
            seen.add(sig);
            out.push(uniq);
        }
    }
    return out;
}

function parseDeadline(deadline) {
    const s = String(deadline || '').trim();
    if (!s) return null;
    const m = s.match(/(\d{4})\s*[\-./年]\s*(\d{1,2})\s*[\-./月]\s*(\d{1,2})/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || !mo || !d) return null;
    const dt = new Date(y, mo - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

function buildOtherText(otherConditions, deptNotes, isFirstRow) {
    const parts = [];
    if (isFirstRow && Array.isArray(otherConditions)) {
        const cleaned = otherConditions.filter(x => typeof x === 'string' && x.trim());
        parts.push(...cleaned.slice(0, 2));
    }
    if (typeof deptNotes === 'string' && deptNotes.trim()) parts.push(deptNotes.trim());
    return parts.join('；');
}

function evaluateRow(reqs, userScores, choiceGroups, opts) {
    const requirements = reqs || {};
    const user = userScores || {};
    const includeUnknown = !!(opts && opts.includeUnknown);

    if (!hasAnyRequirements(requirements)) {
        return { status: 'unknown', fit: null, reason: '无科目要求' };
    }

    // 暂不处理级分（min_score）— 有级分要求时标记为需核对
    for (const { key } of SUBJECTS) {
        const r = requirements[key];
        if (r && r.min_score) {
            return { status: 'unknown', fit: null, reason: '包含级分要求（需核对）' };
        }
    }

    const consumed = new Set();
    let fit = 0;

    // 组装 choice groups（含数学A/B的默认择一）
    const groups = Array.isArray(choiceGroups) ? choiceGroups.slice() : [];
    const ma = requirements.math_a;
    const mb = requirements.math_b;
    const maP = ma && ma.standard ? parseStandard(ma.standard) : { rank: null, any: false, base: '' };
    const mbP = mb && mb.standard ? parseStandard(mb.standard) : { rank: null, any: false, base: '' };
    const hasMathPair = maP.rank && mbP.rank && maP.rank === mbP.rank && maP.base === mbP.base;
    if (hasMathPair) {
        const alreadyGrouped = groups.some(g => Array.isArray(g) && g.includes('math_a') && g.includes('math_b'));
        if (!alreadyGrouped) groups.push(['math_a', 'math_b']);
    }

    // 先评估 OR 组
    for (const g of groups) {
        if (!Array.isArray(g) || g.length === 0) continue;
        const targets = g.filter(k => requirements[k] && !isReqEmpty(requirements[k]));
        if (!targets.length) continue;

        let bestSlack = null;
        let providedCount = 0;
        for (const k of targets) {
            const r = requirements[k];
            const rr = standardRank(r.standard);
            if (!rr) continue;
            const ur = standardRank(user[k]);
            if (!ur) continue;
            providedCount += 1;
            if (ur < rr) continue;
            const slack = ur - rr;
            if (bestSlack === null || slack < bestSlack) bestSlack = slack;
        }

        if (bestSlack === null) {
            if (includeUnknown && providedCount === 0) {
                return { status: 'unknown', fit: null, reason: '缺少可判定成绩' };
            }
            return { status: 'fail', fit: null, reason: '未满足任一条件' };
        }

        fit += bestSlack;
        targets.forEach(k => consumed.add(k));
    }

    // 再评估其余 AND 条件
    for (const { key } of SUBJECTS) {
        if (consumed.has(key)) continue;
        const r = requirements[key];
        if (!r || isReqEmpty(r)) continue;
        const rr = standardRank(r.standard);
        if (!rr) continue;
        const ur = standardRank(user[key]);
        if (!ur) {
            if (includeUnknown) {
                return { status: 'unknown', fit: null, reason: `缺少${key}成绩` };
            }
            return { status: 'fail', fit: null, reason: `缺少${key}成绩` };
        }
        if (ur < rr) {
            return { status: 'fail', fit: null, reason: '科目未达标' };
        }
        fit += (ur - rr);
    }

    return { status: 'pass', fit, reason: null };
}

const elements = {
    btnRefresh: document.getElementById('btn-refresh'),
    loadIndicator: document.getElementById('load-indicator'),
    scoreSelects: {
        chinese: document.getElementById('score-chinese'),
        english: document.getElementById('score-english'),
        math_a: document.getElementById('score-math_a'),
        math_b: document.getElementById('score-math_b'),
        social: document.getElementById('score-social'),
        science: document.getElementById('score-science'),
    },
    chkOnlyEligible: document.getElementById('chk-only-eligible'),
    chkIncludeUnknown: document.getElementById('chk-include-unknown'),
    chkShowFail: document.getElementById('chk-show-fail'),
    sortBy: document.getElementById('sort-by'),
    btnReset: document.getElementById('btn-reset'),
    matchStats: document.getElementById('match-stats'),
    majorCount: document.getElementById('major-count'),
    majorSelectedCount: document.getElementById('major-selected-count'),
    majorNote: document.getElementById('major-note'),
    majorSearch: document.getElementById('major-search'),
    majorChips: document.getElementById('major-chips'),
    btnClearMajors: document.getElementById('btn-clear-majors'),
    filterAreaBtn: document.getElementById('filter-area-btn'),
    filterAreaLabel: document.getElementById('filter-area-label'),
    filterAreaPanel: document.getElementById('filter-area-panel'),
    filterAreaSearch: document.getElementById('filter-area-search'),
    filterAreaOptions: document.getElementById('filter-area-options'),
    filterAreaClear: document.getElementById('filter-area-clear'),
    filterAreaAll: document.getElementById('filter-area-all'),
    filterTierBtn: document.getElementById('filter-tier-btn'),
    filterTierLabel: document.getElementById('filter-tier-label'),
    filterTierPanel: document.getElementById('filter-tier-panel'),
    filterTierOptions: document.getElementById('filter-tier-options'),
    filterTierClear: document.getElementById('filter-tier-clear'),
    filterTierAll: document.getElementById('filter-tier-all'),
    filterTaiwan: document.getElementById('filter-taiwan'),
    filterConfidence: document.getElementById('filter-confidence'),
    filterSearch: document.getElementById('filter-search'),
    opptyEnabled: document.getElementById('oppty-enabled'),
    opptyPanel: document.getElementById('oppty-panel'),
    opptyModeTransfer: document.getElementById('oppty-mode-transfer'),
    opptyModeNearmiss: document.getElementById('oppty-mode-nearmiss'),
    opptyTargets: document.getElementById('oppty-targets'),
    opptyKeywords: document.getElementById('oppty-keywords'),
    opptyGap: document.getElementById('oppty-gap'),
    opptyHotzones: document.getElementById('oppty-hotzones'),
    rowCount: document.getElementById('row-count'),
    dataMeta: document.getElementById('data-meta'),
    tableBody: document.getElementById('summary-table-body'),
    cardsWrap: document.getElementById('summary-cards'),
    modal: document.getElementById('detail-modal'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalSubtitle: document.getElementById('modal-subtitle'),
    modalContent: document.getElementById('modal-content'),
};

let resultsMeta = { last_updated: null };
let schoolGroups = []; // full
let visibleRowMap = new Map();

let selectedAreas = new Set();
let selectedTiers = new Set();

let selectedMajors = new Set(); // store normalized major names
let majorLabelCache = new Map(); // norm -> display label

let lastMajorAvailable = [];
let lastMajorNoteText = '';

let opptyOnlyEligibleSnapshot = null;
let opptyShowFailSnapshot = null;

let renderRaf = null;

function scheduleRender() {
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = requestAnimationFrame(() => {
        renderRaf = null;
        render();
    });
}

function fillStandardOptions(selectEl) {
    if (!selectEl) return;
    const opts = [''].concat(Object.keys(STANDARD_RANK));
    setHtml(selectEl, opts.map(v => {
        const label = v ? v : '未填写';
        return `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
    }).join(''));
}

function getUserScores() {
    const out = {};
    for (const { key } of SUBJECTS) {
        const el = elements.scoreSelects[key];
        out[key] = el ? (el.value || '') : '';
    }
    return out;
}

function saveUserScoresToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY_SCORES, JSON.stringify(getUserScores()));
    } catch (e) {
        // ignore
    }
}

function loadUserScoresFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_SCORES);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return;

        for (const { key } of SUBJECTS) {
            const v = data[key];
            if (typeof v !== 'string') continue;
            if (v !== '' && !STANDARD_RANK[v]) continue;
            const el = elements.scoreSelects[key];
            if (el) el.value = v;
        }
    } catch (e) {
        // ignore
    }
}

function clearUserScoresStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY_SCORES);
    } catch (e) {
        // ignore
    }
}

function saveSelectedMajorsToStorage() {
    try {
        const arr = Array.from(selectedMajors).map(norm => {
            const label = majorLabelCache.get(norm) || norm;
            return { norm, label };
        });
        localStorage.setItem(STORAGE_KEY_SELECTED_MAJORS, JSON.stringify(arr));
    } catch (e) {
        // ignore
    }
}

function loadSelectedMajorsFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_SELECTED_MAJORS);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;
        arr.forEach(it => {
            if (!it) return;
            if (typeof it === 'string') {
                const norm = normalizeMajorKey(it);
                if (norm) selectedMajors.add(norm);
                return;
            }
            if (typeof it === 'object') {
                const norm = normalizeMajorKey(it.norm);
                const label = typeof it.label === 'string' ? it.label : '';
                if (norm) {
                    selectedMajors.add(norm);
                    if (label) majorLabelCache.set(norm, label);
                }
            }
        });
    } catch (e) {
        // ignore
    }
}

function clearSelectedMajorsStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY_SELECTED_MAJORS);
    } catch (e) {
        // ignore
    }
}

function getOpptySettingsFromUI() {
    const enabled = !!(elements.opptyEnabled && elements.opptyEnabled.checked);
    const modeTransfer = !!(elements.opptyModeTransfer && elements.opptyModeTransfer.checked);
    const modeNearmiss = !!(elements.opptyModeNearmiss && elements.opptyModeNearmiss.checked);
    const gapLimit = Number(elements.opptyGap ? elements.opptyGap.value : 1) || 1;

    const targetIds = [];
    if (elements.opptyTargets) {
        elements.opptyTargets.querySelectorAll('input.oppty-target[type="checkbox"][value]').forEach(cb => {
            if (cb.checked) targetIds.push(String(cb.value || ''));
        });
    }

    const hotAreas = [];
    if (elements.opptyHotzones) {
        elements.opptyHotzones.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
            if (cb.checked) hotAreas.push(String(cb.value || ''));
        });
    }

    const keywordText = elements.opptyKeywords ? String(elements.opptyKeywords.value || '') : '';

    return { enabled, modeTransfer, modeNearmiss, gapLimit, targetIds, hotAreas, keywordText };
}

function saveOpptySettingsToStorage() {
    try {
        const s = getOpptySettingsFromUI();
        localStorage.setItem(STORAGE_KEY_OPPTY, JSON.stringify(s));
    } catch (e) {
        // ignore
    }
}

function loadOpptySettingsFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_OPPTY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
        return null;
    }
}

function applyOpptySettingsToUI(settings) {
    const s = settings && typeof settings === 'object' ? settings : null;
    if (!s) return;

    if (elements.opptyEnabled && typeof s.enabled === 'boolean') {
        elements.opptyEnabled.checked = s.enabled;
    }
    if (elements.opptyModeTransfer && typeof s.modeTransfer === 'boolean') {
        elements.opptyModeTransfer.checked = s.modeTransfer;
    }
    if (elements.opptyModeNearmiss && typeof s.modeNearmiss === 'boolean') {
        elements.opptyModeNearmiss.checked = s.modeNearmiss;
    }
    if (elements.opptyGap && (s.gapLimit === 1 || s.gapLimit === 2 || s.gapLimit === 3 || s.gapLimit === '1' || s.gapLimit === '2' || s.gapLimit === '3')) {
        elements.opptyGap.value = String(s.gapLimit);
    }
    if (elements.opptyKeywords && typeof s.keywordText === 'string') {
        elements.opptyKeywords.value = s.keywordText;
    }

    if (elements.opptyTargets && Array.isArray(s.targetIds)) {
        const set = new Set(s.targetIds.map(x => String(x || '')));
        elements.opptyTargets.querySelectorAll('input.oppty-target[type="checkbox"][value]').forEach(cb => {
            const v = String(cb.value || '');
            if (!v) return;
            cb.checked = set.has(v);
        });
    }

    if (elements.opptyHotzones && Array.isArray(s.hotAreas)) {
        const set = new Set(s.hotAreas.map(x => String(x || '')));
        elements.opptyHotzones.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
            const v = String(cb.value || '');
            if (!v) return;
            cb.checked = set.has(v);
        });
    }
}

function anyUserScoreSelected(userScores) {
    const u = userScores || {};
    return SUBJECTS.some(({ key }) => !!String(u[key] || '').trim());
}

function setPanelOpen(panelEl, open) {
    if (!panelEl) return;
    panelEl.classList.toggle('hidden', !open);
}

function updateAreaFilterLabel() {
    if (!elements.filterAreaLabel) return;
    const n = selectedAreas.size;
    setText(elements.filterAreaLabel, n ? `已选 ${n} 项` : '全部地区');
}

function updateTierFilterLabel() {
    if (!elements.filterTierLabel) return;
    const n = selectedTiers.size;
    setText(elements.filterTierLabel, n ? `已选 ${n} 项` : '全部类别');
}

function applyAreaSearchFilter() {
    const q = String(elements.filterAreaSearch ? (elements.filterAreaSearch.value || '') : '').trim().toLowerCase();
    const wrap = elements.filterAreaOptions;
    if (!wrap) return;
    wrap.querySelectorAll('label[data-value]').forEach(lb => {
        const v = String(lb.dataset.value || '').toLowerCase();
        const ok = !q || v.includes(q);
        lb.classList.toggle('hidden', !ok);
    });
}

function populateAreaFilter(groups) {
    const areas = new Set();
    for (const g of groups || []) {
        if (g && g.area) areas.add(String(g.area));
    }
    const sorted = Array.from(areas).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    // drop selections that no longer exist
    selectedAreas = new Set(Array.from(selectedAreas).filter(x => areas.has(x)));

    if (!elements.filterAreaOptions) return;
    setHtml(elements.filterAreaOptions, sorted.map(a => {
        const checked = selectedAreas.has(a);
        return `
            <label class="flex items-center gap-2 py-1" data-value="${escapeHtml(a)}">
                <input type="checkbox" class="w-4 h-4" data-value="${escapeHtml(a)}" ${checked ? 'checked' : ''}>
                <span>${escapeHtml(a)}</span>
            </label>
        `;
    }).join(''));

    updateAreaFilterLabel();
    applyAreaSearchFilter();
}

function initTierFilterOptions() {
    const tierOpts = [
        { value: '985', label: '985' },
        { value: '211', label: '211（非985）' },
        { value: '双一流', label: '双一流（非985/211）' },
        { value: '非双一流', label: '非双一流' },
    ];

    if (!elements.filterTierOptions) return;
    setHtml(elements.filterTierOptions, tierOpts.map(t => {
        const checked = selectedTiers.has(t.value);
        return `
            <label class="flex items-center gap-2 py-1" data-value="${escapeHtml(t.value)}">
                <input type="checkbox" class="w-4 h-4" data-value="${escapeHtml(t.value)}" ${checked ? 'checked' : ''}>
                <span>${escapeHtml(t.label)}</span>
            </label>
        `;
    }).join(''));

    updateTierFilterLabel();
}

async function fetchAllResults() {
    elements.loadIndicator.classList.remove('hidden');
    const oldText = elements.btnRefresh.textContent;
    elements.btnRefresh.disabled = true;
    setText(elements.btnRefresh, '刷新中...');
    try {
        const resp = await fetch(noCacheUrl(`${API_BASE}/results`), { cache: 'no-store' });
        if (!resp.ok) {
            const t = await resp.text();
            throw new Error(t || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        resultsMeta.last_updated = data.last_updated || null;
        const schools = data.schools || {};
        schoolGroups = buildSchoolGroupsFromResults(schools);
        populateAreaFilter(schoolGroups);
        render();
    } catch (e) {
        console.error('[CollegeFinder] summary load failed:', e);
        setText(elements.matchStats, `加载失败：${e && e.message ? e.message : String(e)}`);
        setHtml(elements.tableBody, '<tr><td colspan="12" class="px-4 py-8 text-center text-red-600">加载数据失败，请检查后端是否启动</td></tr>');
        if (elements.cardsWrap) {
            setHtml(elements.cardsWrap, '<div class="px-4 py-8 text-center text-red-600">加载数据失败，请检查后端是否启动</div>');
        }
    } finally {
        elements.loadIndicator.classList.add('hidden');
        elements.btnRefresh.disabled = false;
        setText(elements.btnRefresh, oldText);
    }
}

function buildSchoolGroupsFromResults(resultsMap) {
    const groups = [];
    for (const [sid, r] of Object.entries(resultsMap || {})) {
        if (!r || r.status !== 'success') continue;
        const ext = r.extraction || {};
        if (!ext.found) continue;

        const gen = ext.general_requirements || {};
        const depts = Array.isArray(ext.department_requirements) ? ext.department_requirements : [];
        const rows = [];

        if (depts.length > 0) {
            depts.forEach((dept, idx) => {
                const deptName = (dept && dept.department) ? String(dept.department) : '全部';
                const deptSubjects = (dept && dept.subjects) ? dept.subjects : null;
                const reqs = mergeRequirements(gen, deptSubjects);

                const contextParts = [];
                if (ext.notes) contextParts.push(String(ext.notes));
                if (Array.isArray(ext.other_conditions)) contextParts.push(ext.other_conditions.join(' '));
                if (dept && dept.notes) contextParts.push(String(dept.notes));
                const context = contextParts.join(' ');

                const contextGroups = extractChoiceGroups(context);
                const reqGroups = extractChoiceGroupsFromReqs(reqs);

                rows.push({
                    rowKey: `${sid}__${idx}`,
                    deptName,
                    deptNotes: (dept && dept.notes) ? String(dept.notes) : '',
                    majors: (dept && Array.isArray(dept.majors)) ? dept.majors : [],
                    reqs,
                    choiceGroups: mergeChoiceGroups(contextGroups, reqGroups),
                    otherText: buildOtherText(ext.other_conditions, dept && dept.notes, idx === 0),
                });
            });
        } else {
            const contextParts = [];
            if (ext.notes) contextParts.push(String(ext.notes));
            if (Array.isArray(ext.other_conditions)) contextParts.push(ext.other_conditions.join(' '));
            const context = contextParts.join(' ');

            const reqs = mergeRequirements(gen, null);
            const contextGroups = extractChoiceGroups(context);
            const reqGroups = extractChoiceGroupsFromReqs(reqs);

            rows.push({
                rowKey: `${sid}__0`,
                deptName: '全部',
                deptNotes: '',
                majors: [],
                reqs,
                choiceGroups: mergeChoiceGroups(contextGroups, reqGroups),
                otherText: buildOtherText(ext.other_conditions, null, true),
            });
        }

        groups.push({
            schoolId: String(r.school_id || sid),
            schoolName: String(r.school_name || ''),
            area: r.area || '',
            tier: r.tier || '非双一流',
            taiwanRecognized: !!r.taiwan_recognized,
            sourceUrl: extractFirstUrl(r.source_url || ''),
            processedAt: r.processed_at || '',
            majors: Array.isArray(ext.majors) ? ext.majors : [],
            result: r,
            extraction: ext,
            rows,
        });
    }
    return groups;
}

function normalizeMajorKey(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        .replace(/[·•]/g, '')
        .replace(/[，,;；。]+$/g, '');
}

function isUsefulMajorName(s) {
    const v = normalizeMajorKey(s);
    if (!v) return false;
    if (v.length < 2 || v.length > 40) return false;
    if (/^[0-9]+$/.test(v)) return false;
    const zh = (v.match(/[\u4e00-\u9fff]/g) || []).length;
    if (zh < 2) return false;
    if (v.length === 2 && !(v.endsWith('学') || v.endsWith('语'))) {
        const allow2 = new Set(['音乐', '舞蹈', '绘画', '摄影', '动画', '雕塑', '书法', '表演', '戏剧', '翻译', '美术', '体育', '播音', '编导', '导演']);
        if (!allow2.has(v)) return false;
    }
    if (/(学院|院系|学部|系|计划|人数|合计|小计|学制|年制|学费|备注|联系方式|地址|电话|网址|邮箱)/.test(v)) return false;
    return true;
}

function splitMajorTokens(text) {
    let s = String(text || '').trim();
    if (!s) return [];

    // handle "招生专业：..." like lines
    if (s.includes('：')) {
        const [left, right] = s.split('：', 2);
        if (/(招生专业|招生專業|专业|專業)/.test(left)) s = right;
    }

    s = s.replace(/（/g, '(').replace(/）/g, ')');
    for (const c of ['，', ',', '/', '\\', '；', ';', '、', '|', '｜']) {
        s = s.split(c).join('、');
    }

    // strip common numbering prefix
    s = s.replace(/^\(?[一二三四五六七八九十0-9]+\)?[、.．]\s*/, '');

    return s.split('、').map(x => x.trim()).filter(Boolean);
}

function parseMajorsFromLabel(label) {
    const s = normalizeMajorKey(label);
    if (!s) return [];

    // avoid generic group labels
    if (s.includes('类专业') || s.endsWith('专业') || s.endsWith('專業')) {
        if (!/[、，,\/]/.test(s)) return [];
    }

    const out = [];
    const seen = new Set();
    splitMajorTokens(s).forEach(tok => {
        const v = normalizeMajorKey(tok);
        if (!isUsefulMajorName(v)) return;
        if (seen.has(v)) return;
        seen.add(v);
        out.push(v);
    });
    return out;
}

function collectMajorsForRow(g, row) {
    const majors = [];

    const rowMaj = Array.isArray(row && row.majors) ? row.majors : [];
    rowMaj.forEach(m => {
        const v = normalizeMajorKey(m);
        if (isUsefulMajorName(v)) majors.push(v);
    });

    // fallback: parse from deptName if it looks like a list of majors
    if (majors.length === 0) {
        parseMajorsFromLabel(row && row.deptName).forEach(x => majors.push(x));
    }

    // last fallback: school-level majors
    if (majors.length === 0) {
        const schoolMaj = Array.isArray(g && g.majors) ? g.majors : [];
        schoolMaj.forEach(m => {
            const v = normalizeMajorKey(m);
            if (isUsefulMajorName(v)) majors.push(v);
        });
    }

    return Array.from(new Set(majors));
}

function collectMajorsForSchool(g) {
    const majors = [];
    const schoolMaj = Array.isArray(g && g.majors) ? g.majors : [];
    schoolMaj.forEach(m => {
        const v = normalizeMajorKey(m);
        if (isUsefulMajorName(v)) majors.push(v);
    });

    // supplement with row majors parsed from dept labels
    (g && Array.isArray(g.rows) ? g.rows : []).forEach(row => {
        collectMajorsForRow(g, row).forEach(m => majors.push(m));
    });

    return Array.from(new Set(majors));
}

function buildMajorOptionsFromGroups(groups) {
    const map = new Map();
    (groups || []).forEach(g => {
        collectMajorsForSchool(g).forEach(m => {
            if (!map.has(m)) map.set(m, m);
        });
    });

    const opts = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    // refresh label cache
    opts.forEach(m => {
        if (!majorLabelCache.has(m)) majorLabelCache.set(m, m);
    });

    return opts;
}

function renderMajorChips(availableMajors, noteText) {
    const all = Array.isArray(availableMajors) ? availableMajors : [];
    const availSet = new Set(all);

    // keep label cache fresh
    all.forEach(m => {
        if (!majorLabelCache.has(m)) majorLabelCache.set(m, m);
    });

    const selectedList = Array.from(selectedMajors);
    const missingSelected = selectedList.filter(m => !availSet.has(m));

    const q = String(elements.majorSearch ? (elements.majorSearch.value || '') : '').trim().toLowerCase();

    // chips to render: always show selected first, then available (filtered by q)
    const chips = [];
    missingSelected.forEach(m => chips.push({ norm: m, label: majorLabelCache.get(m) || m, missing: true }));
    selectedList.filter(m => availSet.has(m)).forEach(m => chips.push({ norm: m, label: majorLabelCache.get(m) || m, missing: false }));

    all.forEach(m => {
        if (selectedMajors.has(m)) return;
        const label = majorLabelCache.get(m) || m;
        if (q && !String(label).toLowerCase().includes(q)) return;
        chips.push({ norm: m, label, missing: false });
    });

    if (elements.majorCount) setText(elements.majorCount, String(all.length));
    if (elements.majorSelectedCount) setText(elements.majorSelectedCount, String(selectedMajors.size));
    if (elements.majorNote) setText(elements.majorNote, noteText || '');
    if (elements.btnClearMajors) elements.btnClearMajors.disabled = selectedMajors.size === 0;

    if (!elements.majorChips) return;
    if (chips.length === 0) {
        setHtml(elements.majorChips, '<div class="text-sm text-gray-400">暂无专业数据（请在工作台勾选“强制刷新已有结果”后重跑提取以补全专业）</div>');
        return;
    }

    setHtml(elements.majorChips, chips.map(c => {
        const selected = selectedMajors.has(c.norm);
        const base = 'text-xs px-2 py-1 rounded border';
        const cls = c.missing
            ? `${base} bg-rose-50 text-rose-800 border-rose-200`
            : selected
                ? `${base} bg-blue-600 text-white border-blue-600`
                : `${base} bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100`;
        const suffix = c.missing ? '（不在当前范围）' : '';
        return `<button type="button" class="${cls}" data-major="${escapeHtml(c.norm)}" aria-pressed="${selected ? 'true' : 'false'}">${escapeHtml(String(c.label || '') + suffix)}</button>`;
    }).join(''));
}

function applyMajorFilterToGroups(groups) {
    if (!selectedMajors || selectedMajors.size === 0) {
        return { groups, majorFiltered: false, majorUnmapped: 0 };
    }

    const selected = new Set(Array.from(selectedMajors));
    const out = [];
    let unmapped = 0;

    for (const g of groups || []) {
        const schoolMajors = new Set(collectMajorsForSchool(g));
        let hitSchool = false;
        for (const m of selected) {
            if (schoolMajors.has(m)) { hitSchool = true; break; }
        }
        if (!hitSchool) continue;

        const matchedRows = [];
        const allRows = Array.isArray(g.rows) ? g.rows : [];
        for (const row of allRows) {
            const rowMajors = new Set(collectMajorsForRow(g, row));
            let hitRow = false;
            for (const m of selected) {
                if (rowMajors.has(m)) { hitRow = true; break; }
            }
            if (hitRow) matchedRows.push(row);
        }

        if (matchedRows.length === 0) {
            unmapped += 1;
            out.push({ ...g, rows: allRows.slice(), _majorMappingUnknown: true });
        } else {
            out.push({ ...g, rows: matchedRows.slice(), _majorMappingUnknown: false });
        }
    }

    return { groups: out, majorFiltered: true, majorUnmapped: unmapped };
}

function recountStats(groups, scoreActive) {
    let totalRows = 0;
    let statPass = 0;
    let statUnknown = 0;
    let statFail = 0;

    for (const g of groups || []) {
        const rows = Array.isArray(g.rows) ? g.rows : [];
        totalRows += rows.length;
        if (!scoreActive) continue;
        rows.forEach(r => {
            const m = r._match || {};
            if (m.status === 'pass') statPass += 1;
            else if (m.status === 'unknown') statUnknown += 1;
            else if (m.status === 'fail') statFail += 1;
        });
    }

    return { totalRows, statPass, statUnknown, statFail };
}

// Opportunity mode (built on existing table)
const OPPTY_TARGET_GROUPS = {
    cs: {
        label: '计算机/软件/网络',
        keywords: [
            '计算机',
            '软件',
            '软件工程',
            '网络工程',
            '网络',
            '物联网',
            '数字媒体',
            '数字媒体技术',
            '区块链',
            '云计算',
            '信息对抗',
            '空间信息',
        ],
    },
    data: {
        label: '数据/统计/信息与计算',
        keywords: [
            '数据科学',
            '大数据',
            '数据',
            '统计',
            '应用统计',
            '信息与计算科学',
            '数学与应用数学',
            '计算数学',
            '运筹',
            '精算',
            '信息管理与信息系统',
        ],
    },
    ai: {
        label: '人工智能/智能科学',
        keywords: [
            '人工智能',
            '智能科学与技术',
            '机器学习',
            '深度学习',
        ],
    },
    sec: {
        label: '网安/信息安全/密码',
        keywords: [
            '网络空间安全',
            '信息安全',
            '网络安全',
            '密码',
            '保密',
        ],
    },
    ee: {
        label: '电子信息/通信/电气',
        keywords: [
            '电子信息',
            '电子信息工程',
            '通信',
            '通信工程',
            '电气',
            '电气工程',
            '电气工程及其自动化',
            '电子科学与技术',
            '光电',
            '光电信息',
            '信息工程',
            '电子工程',
        ],
    },
    ic: {
        label: '集成电路/微电子/半导体',
        keywords: [
            '集成电路',
            '微电子',
            '微电子科学与工程',
            '半导体',
            '芯片',
            '封装',
            '电子封装',
            '集成电路设计与集成系统',
        ],
    },
    auto: {
        label: '自动化/控制/机器人',
        keywords: [
            '自动化',
            '控制',
            '控制工程',
            '机器人工程',
            '机器人',
            '测控',
            '测控技术',
            '导航',
        ],
    },
    me: {
        label: '机械/机电/智能制造',
        keywords: [
            '机械',
            '机械工程',
            '机械设计制造及其自动化',
            '机械电子',
            '机电',
            '机电一体化',
            '智能制造',
            '工业工程',
            '过程装备',
        ],
    },
    vehicle: {
        label: '车辆/交通/船舶',
        keywords: [
            '车辆',
            '车辆工程',
            '交通运输',
            '交通工程',
            '轨道交通',
            '船舶',
            '航海',
            '海洋工程',
        ],
    },
    aero: {
        label: '航空航天/飞行器',
        keywords: [
            '航空',
            '航天',
            '航空航天',
            '飞行器',
            '飞行技术',
            '空天',
            '宇航',
        ],
    },
    civil: {
        label: '土木/建筑/城规/测绘',
        keywords: [
            '土木',
            '土木工程',
            '建筑',
            '建筑学',
            '城乡规划',
            '城市规划',
            '风景园林',
            '给排水',
            '道路桥梁',
            '工程造价',
            '工程管理',
            '测绘',
            '地理信息',
            '智能建造',
        ],
    },
    materials: {
        label: '材料/冶金/高分子',
        keywords: [
            '材料',
            '材料科学与工程',
            '高分子',
            '冶金',
            '金属材料',
            '无机非金属',
            '复合材料',
            '纳米',
            '材料成型',
            '焊接',
        ],
    },
    chem: {
        label: '化学/化工/制药工程',
        keywords: [
            '化学',
            '应用化学',
            '化工',
            '化学工程',
            '化学工程与工艺',
            '制药工程',
            '精细化工',
        ],
    },
    bio: {
        label: '生物/生科/生物工程',
        keywords: [
            '生物',
            '生命科学',
            '生物科学',
            '生物工程',
            '生物技术',
            '生物制药',
            '生物医学工程',
        ],
    },
    med: {
        label: '医学/临床/药学/护理',
        keywords: [
            '医学',
            '临床',
            '临床医学',
            '口腔',
            '口腔医学',
            '护理',
            '护理学',
            '药学',
            '中医学',
            '公共卫生',
            '预防医学',
            '医学检验',
            '医学影像',
            '康复',
            '麻醉',
        ],
    },
    env: {
        label: '环境/能源/新能源',
        keywords: [
            '环境',
            '环境工程',
            '环境科学',
            '能源',
            '新能源',
            '储能',
            '能源与动力工程',
            '核工程',
            '核技术',
            '资源循环',
            '资源环境',
            '水利',
            '水文',
        ],
    },
    econ: {
        label: '经济/金融/贸易',
        keywords: [
            '经济',
            '经济学',
            '金融',
            '金融学',
            '金融工程',
            '财政',
            '税收',
            '国际经济与贸易',
            '国际经济',
            '贸易',
            '保险',
            '投资',
        ],
    },
    acct: {
        label: '会计/审计/财务',
        keywords: [
            '会计',
            '会计学',
            '审计',
            '财务',
            '财务管理',
            '资产评估',
        ],
    },
    biz: {
        label: '管理/工商/市场',
        keywords: [
            '工商管理',
            '管理科学与工程',
            '市场营销',
            '人力资源',
            '行政管理',
            '公共管理',
            '物流',
            '电子商务',
            '旅游管理',
            '酒店管理',
        ],
    },
    law: {
        label: '法学/公安/政治',
        keywords: [
            '法学',
            '法律',
            '知识产权',
            '公安',
            '侦查',
            '政治',
            '国际政治',
            '外交',
        ],
    },
    lang: {
        label: '外语/翻译',
        keywords: [
            '外语',
            '翻译',
            '英语',
            '商务英语',
            '日语',
            '俄语',
            '法语',
            '德语',
            '西班牙语',
            '葡萄牙语',
            '韩语',
        ],
    },
    media: {
        label: '新闻传播/广告/新媒体',
        keywords: [
            '新闻',
            '传播',
            '新闻传播',
            '广告',
            '新媒体',
            '网络与新媒体',
            '广播电视',
            '影视',
            '播音',
            '编导',
            '传媒',
        ],
    },
    edu: {
        label: '教育/心理',
        keywords: [
            '教育',
            '师范',
            '学前教育',
            '特殊教育',
            '心理',
            '心理学',
            '应用心理',
        ],
    },
    design: {
        label: '艺术/设计/表演',
        keywords: [
            '艺术',
            '设计',
            '美术',
            '视觉传达',
            '工业设计',
            '动画',
            '数字媒体艺术',
            '音乐',
            '舞蹈',
            '表演',
            '戏剧',
            '摄影',
        ],
    },
};

function parseOpptyCustomKeywords(text) {
    const s = String(text || '').trim();
    if (!s) return [];
    const parts = s.split(/\s+/g).map(x => x.trim()).filter(Boolean);
    const out = [];
    const seen = new Set();
    parts.forEach(p => {
        const k = p.replace(/[，,;；/\\|｜]+/g, '').trim();
        if (!k) return;
        const kk = k.toLowerCase();
        if (seen.has(kk)) return;
        seen.add(kk);
        out.push(k);
    });
    return out;
}

function buildOpptySettings() {
    const ui = getOpptySettingsFromUI();
    if (!ui.enabled) return { enabled: false };

    const targetIds = Array.isArray(ui.targetIds) ? ui.targetIds : [];
    const keywords = [];
    targetIds.forEach(id => {
        const g = OPPTY_TARGET_GROUPS[String(id || '')];
        if (g && Array.isArray(g.keywords)) keywords.push(...g.keywords);
    });
    keywords.push(...parseOpptyCustomKeywords(ui.keywordText));

    const uniq = Array.from(new Set(keywords.map(x => String(x || '').trim()).filter(Boolean)));
    const hotAreas = new Set((ui.hotAreas || []).map(x => String(x || '').trim()).filter(Boolean));

    return {
        enabled: true,
        modeTransfer: !!ui.modeTransfer,
        modeNearmiss: !!ui.modeNearmiss,
        gapLimit: Math.max(1, Math.min(3, Number(ui.gapLimit || 1) || 1)),
        keywords: uniq,
        hotAreas,
        targetIds,
    };
}

function matchesKeywords(text, keywords) {
    const t = String(text || '');
    if (!t) return false;
    const low = t.toLowerCase();
    return (keywords || []).some(k => {
        const kk = String(k || '').trim();
        if (!kk) return false;
        if (/^[a-z0-9+_.-]+$/i.test(kk)) return low.includes(kk.toLowerCase());
        return t.includes(kk);
    });
}

function schoolHitsTarget(g, keywords) {
    const majors = collectMajorsForSchool(g);
    if (majors.some(m => matchesKeywords(m, keywords))) return true;
    // fallback: dept names
    return (g.rows || []).some(r => matchesKeywords(r.deptName, keywords));
}

function classifyRowTrack(row, g) {
    const name = String((row && row.deptName) || '');
    const notes = String((row && row.deptNotes) || '');
    const majors = collectMajorsForRow(g, row).join('、');
    const text = (name + ' ' + majors + ' ' + notes).replace(/\s+/g, '');

    const mixed = ['文理兼', '兼收', '兼招', '文理兼收', '文理兼招', '普通类', '普通類'];
    if (mixed.some(x => text.includes(x))) return 'mixed';

    const arts = ['文史', '文科', '经管', '經管', '管理', '经济', '經濟', '外语', '外語', '法学', '文学', '文學', '历史', '歷史', '哲学', '哲學', '教育', '新闻', '新聞', '传播', '傳播', '社会', '社會', '汉语言', '漢語', '英语', '英語', '日语', '日語', '会计', '會計', '金融'];
    const sci = ['理工', '理科', '工科', '计算机', '計算機', '软件', '數據', '数据', '人工智能', '信息', '電子', '电子', '通信', '自動化', '自动化', '机械', '材料', '土木', '电气', '電氣', '数学', '數學', '物理', '化学', '生物', '医学', '药学', '工程', '技術', '技术'];

    const a = arts.some(x => text.includes(x));
    const s = sci.some(x => text.includes(x));
    if (a && s) return 'mixed';
    if (s) return 'science';
    if (a) return 'arts';

    // requirement fallback
    const reqs = (row && row.reqs) || {};
    const hasSci = reqs.science && reqs.science.standard;
    const hasSoc = reqs.social && reqs.social.standard;
    if (hasSci && !hasSoc) return 'science';
    if (hasSoc && !hasSci) return 'arts';
    if (hasSci && hasSoc) return 'mixed';

    return 'unknown';
}

function buildChoiceGroupsForGap(reqs, choiceGroups) {
    const requirements = reqs || {};
    const groups = Array.isArray(choiceGroups) ? choiceGroups.slice() : [];

    const ma = requirements.math_a;
    const mb = requirements.math_b;
    const maP = ma && ma.standard ? parseStandard(ma.standard) : { rank: null, any: false, base: '' };
    const mbP = mb && mb.standard ? parseStandard(mb.standard) : { rank: null, any: false, base: '' };
    const hasMathPair = maP.rank && mbP.rank && maP.rank === mbP.rank && maP.base === mbP.base;
    if (hasMathPair) {
        const alreadyGrouped = groups.some(g => Array.isArray(g) && g.includes('math_a') && g.includes('math_b'));
        if (!alreadyGrouped) groups.push(['math_a', 'math_b']);
    }

    return groups;
}

function evaluateRowGap(reqs, userScores, choiceGroups) {
    const requirements = reqs || {};
    const user = userScores || {};

    if (!hasAnyRequirements(requirements)) {
        return { status: 'unknown', maxDeficit: null, details: [], reason: '无科目要求' };
    }
    for (const { key } of SUBJECTS) {
        const r = requirements[key];
        if (r && r.min_score) {
            return { status: 'unknown', maxDeficit: null, details: [], reason: '包含级分要求（需核对）' };
        }
    }

    const groups = buildChoiceGroupsForGap(requirements, choiceGroups);
    const consumed = new Set();
    const details = [];

    // OR groups: take best option
    for (const g of groups) {
        if (!Array.isArray(g) || g.length === 0) continue;
        const targets = g.filter(k => requirements[k] && !isReqEmpty(requirements[k]));
        if (!targets.length) continue;

        let best = null;
        for (const k of targets) {
            const rr = standardRank(requirements[k].standard);
            if (!rr) continue;
            const ur = standardRank(user[k]);
            if (!ur) continue;
            const deficit = ur >= rr ? 0 : (rr - ur);
            if (!best || deficit < best.deficit) {
                best = { key: k, required: rr, user: ur, deficit, keys: targets.slice() };
            }
        }

        if (!best) {
            return { status: 'unknown', maxDeficit: null, details: [], reason: '缺少可判定成绩' };
        }

        targets.forEach(k => consumed.add(k));
        if (best.deficit > 0) {
            details.push({ type: 'or', ...best });
        }
    }

    // AND conditions
    for (const { key } of SUBJECTS) {
        if (consumed.has(key)) continue;
        const r = requirements[key];
        if (!r || isReqEmpty(r)) continue;
        const rr = standardRank(r.standard);
        if (!rr) continue;
        const ur = standardRank(user[key]);
        if (!ur) {
            return { status: 'unknown', maxDeficit: null, details: [], reason: `缺少${key}成绩` };
        }
        const deficit = ur >= rr ? 0 : (rr - ur);
        if (deficit > 0) {
            details.push({ type: 'and', key, required: rr, user: ur, deficit });
        }
    }

    if (!details.length) {
        return { status: 'pass', maxDeficit: 0, details: [], reason: null };
    }

    const maxDeficit = Math.max(...details.map(d => Number(d.deficit || 0)));
    return { status: 'fail', maxDeficit, details, reason: null };
}

function stdFromRank(rank) {
    const r = Number(rank || 0);
    if (r === 1) return '底标';
    if (r === 2) return '后标';
    if (r === 3) return '均标';
    if (r === 4) return '前标';
    if (r === 5) return '顶标';
    return '';
}

function formatGapDetails(gap) {
    if (!gap || gap.status !== 'fail' || !Array.isArray(gap.details)) return '';
    const parts = [];
    gap.details.forEach(d => {
        if (!d || !d.key) return;
        const subj = SUBJECTS.find(x => x.key === d.key);
        const label = subj ? subj.label : d.key;
        const req = stdFromRank(d.required);
        const usr = stdFromRank(d.user);
        if (req && usr) {
            const tag = d.type === 'or' ? '择一' : '';
            parts.push(`${label}${tag}差${d.deficit}（${usr}→${req}）`);
        }
    });
    return parts.join('；');
}

function extractFlexSignals(g, row) {
    const ext = (g && g.extraction) || {};
    const parts = [];
    if (ext.notes) parts.push(String(ext.notes));
    if (Array.isArray(ext.other_conditions)) parts.push(ext.other_conditions.join(' '));
    if (row && row.deptNotes) parts.push(String(row.deptNotes));
    if (row && row.otherText) parts.push(String(row.otherText));
    const text = parts.join(' ').replace(/\s+/g, '');

    const out = [];
    if (/资料审核|材料审核|资料审查|材料审查|资格审核|资格審核/.test(text)) out.push('资料审核');
    if (/面试|面試|面談|远程面试|線上面試|线上面试/.test(text)) out.push('面试');
    if (/择优|擇優|综合素质|綜合素質|综合评定|綜合評定/.test(text)) out.push('择优');
    if (/作品集|portfolio|项目|專案|竞赛|競賽/.test(text)) out.push('作品/项目');
    return out;
}

function computeOpptyGroupMeta(rows) {
    const rs = Array.isArray(rows) ? rows : [];
    let score = null;
    let bestGap = null;
    let hasTransfer = false;
    let hasNearmiss = false;

    for (const row of rs) {
        const t = String((row && row._opptyType) || '');
        if (t === 'transfer') {
            hasTransfer = true;
            const m = (row && row._match) || {};
            let s = 50_000;
            if (m.status === 'pass') {
                const fit = (typeof m.fit === 'number') ? m.fit : 0;
                s = fit;
            } else if (m.status === 'unknown') {
                s = 500;
            } else {
                s = 5_000;
            }
            if (score === null || s < score) score = s;
        } else if (t === 'nearmiss') {
            hasNearmiss = true;
            const gap = (typeof row._opptyGapMax === 'number') ? row._opptyGapMax : 99;
            if (bestGap === null || gap < bestGap) bestGap = gap;
            const s = 10_000 + gap * 100;
            if (score === null || s < score) score = s;
        }
    }

    return {
        score: (typeof score === 'number') ? score : 9e15,
        bestGap,
        hasTransfer,
        hasNearmiss,
    };
}

function applyFiltersAndMatch() {
    const areaSet = selectedAreas;
    const tierSet = selectedTiers;
    const taiwan = elements.filterTaiwan.value || '';
    const confidence = elements.filterConfidence.value || '';
    const search = String(elements.filterSearch.value || '').toLowerCase().trim();
    const sortBy = elements.sortBy.value || 'fit';

    const userScores = getUserScores();
    const scoreActive = anyUserScoreSelected(userScores);

    const onlyEligible = !!elements.chkOnlyEligible.checked;
    const includeUnknown = !!elements.chkIncludeUnknown.checked;
    const showFail = !!(elements.chkShowFail && elements.chkShowFail.checked);

    const oppty = buildOpptySettings();
    const opptyActive = !!(
        oppty.enabled &&
        scoreActive &&
        Array.isArray(oppty.keywords) &&
        oppty.keywords.length > 0 &&
        (oppty.modeTransfer || oppty.modeNearmiss)
    );
    let opptyReason = '';
    let opptyTransferSchools = 0;
    let opptyNearmissSchools = 0;
    if (oppty.enabled && !scoreActive) opptyReason = '请先填写学测成绩（标准）后再使用机会探索';
    if (oppty.enabled && scoreActive && (!oppty.modeTransfer && !oppty.modeNearmiss)) opptyReason = '请选择至少一种机会类型';
    if (oppty.enabled && scoreActive && (!oppty.keywords || oppty.keywords.length === 0)) opptyReason = '请选择目标科系大类或填写关键词';

    const filtered = [];
    let statPass = 0;
    let statUnknown = 0;
    let statFail = 0;
    let totalRows = 0;

    for (const g of schoolGroups) {
        if (areaSet && areaSet.size > 0 && !areaSet.has(g.area)) continue;
        if (tierSet && tierSet.size > 0 && !tierSet.has(g.tier)) continue;
        if (taiwan === 'yes' && !g.taiwanRecognized) continue;
        if (taiwan === 'no' && g.taiwanRecognized) continue;
        if (confidence && String(g.extraction.confidence || '') !== confidence) continue;

        if (search) {
            const nameHit = String(g.schoolName || '').toLowerCase().includes(search);
            const deptHit = g.rows.some(r => String(r.deptName || '').toLowerCase().includes(search));
            const majorHit = collectMajorsForSchool(g).some(m => String(m || '').toLowerCase().includes(search));
            if (!nameHit && !deptHit && !majorHit) continue;
        }

        const rows = [];
        let bestFit = null;
        let groupStatusRank = 0;

        const allRows = Array.isArray(g.rows) ? g.rows : [];
        for (const row of allRows) {
            // clear old markers
            delete row._opptyType;
            delete row._opptyGapText;
            delete row._opptyGapMax;
            delete row._opptySignals;
            delete row._gapText;
            delete row._gapMax;
            delete row._gapCount;
            delete row._gapReason;

            let match = { status: 'n/a', fit: null, reason: null };
            if (scoreActive) {
                match = evaluateRow(row.reqs, userScores, row.choiceGroups, { includeUnknown });
            }
            row._match = match;

            if (scoreActive && match.status === 'fail') {
                const gap = evaluateRowGap(row.reqs, userScores, row.choiceGroups);
                if (gap && gap.status === 'fail' && typeof gap.maxDeficit === 'number') {
                    row._gapMax = gap.maxDeficit;
                    row._gapCount = Array.isArray(gap.details) ? gap.details.length : null;
                    row._gapText = formatGapDetails(gap);
                } else if (gap && gap.status === 'unknown') {
                    row._gapReason = gap.reason || '';
                }
            }
        }

        if (!scoreActive || !opptyActive) {
            // normal behavior
            for (const row of allRows) {
                const match = row._match || { status: 'n/a', fit: null, reason: null };

                if (scoreActive) {
                    if (match.status === 'pass') {
                        statPass += 1;
                        if (bestFit === null || (typeof match.fit === 'number' && match.fit < bestFit)) bestFit = match.fit;
                        groupStatusRank = Math.max(groupStatusRank, 3);
                    } else if (match.status === 'unknown') {
                        statUnknown += 1;
                        groupStatusRank = Math.max(groupStatusRank, 2);
                    } else {
                        statFail += 1;
                        groupStatusRank = Math.max(groupStatusRank, 1);
                    }
                }

                if (!scoreActive) {
                    rows.push(row);
                    continue;
                }

                if (onlyEligible) {
                    if (match.status === 'pass' || (includeUnknown && match.status === 'unknown') || (showFail && match.status === 'fail')) {
                        rows.push(row);
                    }
                } else {
                    rows.push(row);
                }
            }
        } else {
            // opportunity behavior
            const keywords = oppty.keywords || [];
            if (!schoolHitsTarget(g, keywords)) continue;

            let transferRow = null;
            let nearRow = null;

            const directSciencePass = allRows.some(r => {
                const m = r._match || {};
                if (m.status !== 'pass') return false;
                const track = classifyRowTrack(r, g);
                if (track === 'science') return true;
                const rowMaj = collectMajorsForRow(g, r);
                return matchesKeywords(r.deptName, keywords) || rowMaj.some(x => matchesKeywords(x, keywords));
            });

            if (oppty.modeTransfer && !directSciencePass) {
                const candidates = [];
                for (const r of allRows) {
                    const m = r._match || {};
                    if (m.status !== 'pass' && !(includeUnknown && m.status === 'unknown')) continue;
                    const track = classifyRowTrack(r, g);
                    if (track === 'science') continue;
                    candidates.push({ r, m, track });
                }

                if (candidates.length) {
                    candidates.sort((a, b) => {
                        const as = a.m.status === 'pass' ? 2 : 1;
                        const bs = b.m.status === 'pass' ? 2 : 1;
                        if (bs !== as) return bs - as;
                        const af = (typeof a.m.fit === 'number') ? a.m.fit : -1;
                        const bf = (typeof b.m.fit === 'number') ? b.m.fit : -1;
                        return bf - af;
                    });

                    transferRow = candidates[0].r;
                    transferRow._opptyType = 'transfer';
                    transferRow._opptySignals = extractFlexSignals(g, transferRow);
                }
            }

            if (oppty.modeNearmiss) {
                const hotOk = !oppty.hotAreas || oppty.hotAreas.size === 0 || oppty.hotAreas.has(g.area);
                if (hotOk) {
                    const candidates = [];
                    for (const r of allRows) {
                        const m = r._match || {};
                        if (m.status !== 'fail') continue;
                        const track = classifyRowTrack(r, g);
                        const rowMaj = collectMajorsForRow(g, r);
                        const rowHit = (track === 'science') || matchesKeywords(r.deptName, keywords) || rowMaj.some(x => matchesKeywords(x, keywords));
                        if (!rowHit) continue;

                        const gap = evaluateRowGap(r.reqs, userScores, r.choiceGroups);
                        if (gap.status !== 'fail' || typeof gap.maxDeficit !== 'number') continue;
                        // "Near-miss" = at most one subject (or one OR-group) short
                        if (Array.isArray(gap.details) && gap.details.length > 1) continue;
                        if (gap.maxDeficit > oppty.gapLimit) continue;

                        candidates.push({
                            r,
                            gap,
                            gapText: formatGapDetails(gap),
                            signals: extractFlexSignals(g, r),
                        });
                    }

                    if (candidates.length) {
                        candidates.sort((a, b) => {
                            if (a.gap.maxDeficit !== b.gap.maxDeficit) return a.gap.maxDeficit - b.gap.maxDeficit;
                            const al = String(a.gapText || '').length;
                            const bl = String(b.gapText || '').length;
                            if (al !== bl) return al - bl;
                            return String(a.r.deptName || '').localeCompare(String(b.r.deptName || ''));
                        });

                        const best = candidates[0];
                        nearRow = best.r;
                        nearRow._opptyType = 'nearmiss';
                        nearRow._opptyGapText = best.gapText;
                        nearRow._opptyGapMax = best.gap.maxDeficit;
                        nearRow._opptySignals = best.signals;
                    }
                }
            }

            if (transferRow) {
                rows.push(transferRow);
                opptyTransferSchools += 1;
            }
            if (nearRow && nearRow !== transferRow) {
                rows.push(nearRow);
                opptyNearmissSchools += 1;
            }

            // recompute stats in opportunity mode based on selected rows
            for (const row of rows) {
                const match = row._match || {};
                if (match.status === 'pass') {
                    statPass += 1;
                    if (bestFit === null || (typeof match.fit === 'number' && match.fit < bestFit)) bestFit = match.fit;
                    groupStatusRank = Math.max(groupStatusRank, 3);
                } else if (match.status === 'unknown') {
                    statUnknown += 1;
                    groupStatusRank = Math.max(groupStatusRank, 2);
                } else {
                    statFail += 1;
                    groupStatusRank = Math.max(groupStatusRank, 1);
                }
            }
        }

        if (rows.length === 0) continue;

        const dt = parseDeadline(g.extraction.application_deadline);
        const opptyMeta = opptyActive ? computeOpptyGroupMeta(rows) : null;
        const group = {
            ...g,
            rows: rows.slice(),
            _scoreActive: scoreActive,
            _bestFit: bestFit,
            _statusRank: scoreActive ? groupStatusRank : 0,
            _deadlineDate: dt,
            _opptyScore: opptyMeta ? opptyMeta.score : null,
            _opptyBestGap: opptyMeta ? opptyMeta.bestGap : null,
            _opptyHasTransfer: opptyMeta ? opptyMeta.hasTransfer : false,
            _opptyHasNearmiss: opptyMeta ? opptyMeta.hasNearmiss : false,
        };

        // sort rows within group
        if (scoreActive) {
            group.rows.sort((a, b) => {
                const ar = a._match || {};
                const br = b._match || {};
                const as = ar.status === 'pass' ? 3 : ar.status === 'unknown' ? 2 : 1;
                const bs = br.status === 'pass' ? 3 : br.status === 'unknown' ? 2 : 1;
                if (bs !== as) return bs - as;

                const af = (typeof ar.fit === 'number') ? ar.fit : 10_000;
                const bf = (typeof br.fit === 'number') ? br.fit : 10_000;
                if (af !== bf) return af - bf;
                return String(a.deptName || '').localeCompare(String(b.deptName || ''));
            });
        } else {
            group.rows.sort((a, b) => String(a.deptName || '').localeCompare(String(b.deptName || '')));
        }

        totalRows += group.rows.length;
        filtered.push(group);
    }

    // group sorting
    const sortFn = (a, b) => {
        const aTier = tierRank(a.tier);
        const bTier = tierRank(b.tier);
        const aConf = confidenceRank(a.extraction.confidence);
        const bConf = confidenceRank(b.extraction.confidence);

        if (!a._scoreActive) {
            if (bTier !== aTier) return bTier - aTier;
            if (bConf !== aConf) return bConf - aConf;
        } else if (opptyActive) {
            // In opportunity mode, let the selected sort rule drive ordering.
            const aScore = (typeof a._opptyScore === 'number') ? a._opptyScore : 9e15;
            const bScore = (typeof b._opptyScore === 'number') ? b._opptyScore : 9e15;

            if (sortBy === 'fit') {
                if (aScore !== bScore) return aScore - bScore;
                if (bTier !== aTier) return bTier - aTier;
                if (bConf !== aConf) return bConf - aConf;
            } else if (sortBy === 'tier') {
                if (bTier !== aTier) return bTier - aTier;
                if (aScore !== bScore) return aScore - bScore;
                if (bConf !== aConf) return bConf - aConf;
            } else if (sortBy === 'deadline') {
                const ad = a._deadlineDate ? a._deadlineDate.getTime() : 9e15;
                const bd = b._deadlineDate ? b._deadlineDate.getTime() : 9e15;
                if (ad !== bd) return ad - bd;
                if (aScore !== bScore) return aScore - bScore;
                if (bTier !== aTier) return bTier - aTier;
            }
        } else {
            if (b._statusRank !== a._statusRank) return b._statusRank - a._statusRank;

            const aFit = (typeof a._bestFit === 'number') ? a._bestFit : 10_000;
            const bFit = (typeof b._bestFit === 'number') ? b._bestFit : 10_000;

            if (sortBy === 'fit') {
                if (aFit !== bFit) return aFit - bFit;
                if (bTier !== aTier) return bTier - aTier;
                if (bConf !== aConf) return bConf - aConf;
            } else if (sortBy === 'tier') {
                if (bTier !== aTier) return bTier - aTier;
                if (aFit !== bFit) return aFit - bFit;
                if (bConf !== aConf) return bConf - aConf;
            } else if (sortBy === 'deadline') {
                const ad = a._deadlineDate ? a._deadlineDate.getTime() : 9e15;
                const bd = b._deadlineDate ? b._deadlineDate.getTime() : 9e15;
                if (ad !== bd) return ad - bd;
                if (aFit !== bFit) return aFit - bFit;
                if (bTier !== aTier) return bTier - aTier;
            }
        }

        const ad = a._deadlineDate ? a._deadlineDate.getTime() : 9e15;
        const bd = b._deadlineDate ? b._deadlineDate.getTime() : 9e15;
        if (ad !== bd) return ad - bd;
        return String(a.schoolName || '').localeCompare(String(b.schoolName || ''));
    };

    filtered.sort(sortFn);

    return {
        groups: filtered,
        scoreActive,
        totalRows,
        statPass,
        statUnknown,
        statFail,
        oppty: {
            enabled: !!oppty.enabled,
            active: !!opptyActive,
            reason: opptyReason,
            transferSchools: opptyTransferSchools,
            nearmissSchools: opptyNearmissSchools,
            gapLimit: oppty.enabled ? (oppty.gapLimit || 1) : null,
            keywordsCount: oppty.enabled ? (oppty.keywords ? oppty.keywords.length : 0) : 0,
            hotAreas: oppty.enabled && oppty.hotAreas ? Array.from(oppty.hotAreas) : [],
        },
    };
}

function render() {
    // keep opportunity UI consistent with current scores/modes
    applyOpptyUiState();
    const base = applyFiltersAndMatch();

    // majors section should reflect current filters (before major selection)
    lastMajorAvailable = buildMajorOptionsFromGroups(base.groups);

    const majorRes = applyMajorFilterToGroups(base.groups);
    const groups = majorRes.groups;

    const stats = recountStats(groups, base.scoreActive);
    setText(elements.rowCount, String(stats.totalRows));

    const last = resultsMeta.last_updated ? `数据更新时间: ${resultsMeta.last_updated}` : '';
    setText(elements.dataMeta, last);

    let majorNote = '';
    if (selectedMajors.size > 0) {
        majorNote = `已按专业筛选：${selectedMajors.size} 项`;
        if (majorRes.majorUnmapped > 0) {
            majorNote += `；${majorRes.majorUnmapped} 所学校未能定位到具体分组，将展示该校全部分组`;
        }
    } else {
        majorNote = '点击专业可进一步筛选（可复选）';
    }
    lastMajorNoteText = majorNote;
    renderMajorChips(lastMajorAvailable, majorNote);

    const opptyInfo = base.oppty || { enabled: false, active: false, reason: '' };
    const opptyEnabled = !!opptyInfo.enabled;
    const opptyActive = !!opptyInfo.active;

    let opptyTransferCount = 0;
    let opptyNearCount = 0;
    if (opptyEnabled) {
        for (const g of groups) {
            const types = new Set((g.rows || []).map(r => r && r._opptyType).filter(Boolean));
            if (types.has('transfer')) opptyTransferCount += 1;
            if (types.has('nearmiss')) opptyNearCount += 1;
        }
    }

    if (opptyEnabled && opptyActive) {
        setText(elements.matchStats, `机会探索结果（当前筛选范围内）：转系候选 ${opptyTransferCount} 所 / 冲刺候选 ${opptyNearCount} 所；表格行数 ${stats.totalRows} 行。`);
    } else if (opptyEnabled && !opptyActive) {
        const why = opptyInfo.reason ? `（${opptyInfo.reason}）` : '';
        setText(elements.matchStats, `机会探索已开启但未生效${why}；当前仍显示普通筛选结果。`);
    } else if (!base.scoreActive) {
        setText(elements.matchStats, `已提取学校: ${groups.length} 所；表格行数（含分专业）: ${stats.totalRows} 行。填写成绩后可筛选可报学校。`);
    } else {
        setText(elements.matchStats, `匹配结果（当前筛选范围内）：可报 ${stats.statPass} 行 / 需核对 ${stats.statUnknown} 行 / 不符合 ${stats.statFail} 行。`);
    }

    if (groups.length === 0 || stats.totalRows === 0) {
        setHtml(elements.tableBody, '<tr><td colspan="12" class="px-4 py-8 text-center text-gray-500">无匹配结果</td></tr>');
        if (elements.cardsWrap) {
            setHtml(elements.cardsWrap, '<div class="px-4 py-8 text-center text-gray-500">无匹配结果</div>');
        }
        return;
    }

    visibleRowMap = new Map();

    const tierColors = {
        '985': 'bg-red-100 text-red-700',
        '211': 'bg-orange-100 text-orange-700',
        '双一流': 'bg-blue-100 text-blue-700',
        '非双一流': 'bg-gray-100 text-gray-600',
    };

    const renderCards = !!(elements.cardsWrap && window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    const renderTable = !!elements.tableBody && !renderCards;

    let html = '';
    let cardsHtml = '';
    for (const g of groups) {
        const rs = g.rows.length;
        const tier = g.tier || '非双一流';
        const tierClass = tierColors[tier] || tierColors['非双一流'];
        const conf = String(g.extraction.confidence || '?');
        const confClass = conf === 'high' ? 'bg-green-100 text-green-800' : conf === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';

        const deadline = g.extraction.application_deadline || '';
        const matchBadge = base.scoreActive
            ? (g._statusRank === 3 ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800 ml-2">可报</span>'
                : g._statusRank === 2 ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800 ml-2">需核对</span>'
                    : '<span class="inline-block px-2 py-0.5 text-xs rounded bg-rose-100 text-rose-800 ml-2">不符</span>')
            : '';

        const majorBadge = (selectedMajors.size > 0 && g._majorMappingUnknown)
            ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-700 ml-2">专业未定位</span>'
            : '';

        g.rows.forEach((row, idx) => {
            const rowKey = row.rowKey;
            visibleRowMap.set(rowKey, { group: g, row });

            const match = row._match || {};
            const rowClass = match.status === 'pass' ? 'hover:bg-emerald-50' : match.status === 'unknown' ? 'hover:bg-amber-50' : 'hover:bg-gray-50';

            let schoolCells = '';
            if (idx === 0) {
                const rsAttr = rs > 1 ? ` rowspan="${rs}"` : '';
                const link = g.sourceUrl
                    ? `<a href="${escapeHtml(g.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline" onclick="event.stopPropagation()">${escapeHtml(g.schoolName)}</a>`
                    : `${escapeHtml(g.schoolName)}`;

                const twBadge = g.taiwanRecognized
                    ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-green-100 text-green-700 ml-2">台湾承认</span>'
                    : '<span class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-500 ml-2">未承认</span>';

                schoolCells = `
                    <td class="px-2 md:px-3 py-2 border-b font-medium"${rsAttr}>
                        <div class="leading-snug">
                            ${link}${matchBadge}${majorBadge}
                        </div>
                        <div class="mt-1">
                            <span class="inline-block px-2 py-0.5 text-xs rounded ${tierClass}">${escapeHtml(tier)}</span>
                            ${twBadge}
                        </div>
                    </td>
                    <td class="px-2 md:px-3 py-2 border-b text-sm"${rsAttr}>${escapeHtml(g.area || '')}</td>
                `;
            }

            let tailCells = '';
            if (idx === 0) {
                const rsAttr = rs > 1 ? ` rowspan="${rs}"` : '';
                tailCells = `
                    <td class="px-2 md:px-3 py-2 border-b text-center text-sm"${rsAttr}>${escapeHtml(deadline)}</td>
                    <td class="px-2 md:px-3 py-2 border-b text-center"${rsAttr}><span class="inline-block px-2 py-0.5 text-xs rounded ${confClass}">${escapeHtml(conf)}</span></td>
                `;
            }

            const opType = String(row._opptyType || '');
            let opBadge = '';
            if (opType === 'transfer') {
                opBadge = ' <span class="inline-block px-2 py-0.5 text-xs rounded bg-indigo-100 text-indigo-800 ml-2">转系入口</span>';
            } else if (opType === 'nearmiss') {
                const n = (typeof row._opptyGapMax === 'number') ? row._opptyGapMax : null;
                opBadge = ` <span class="inline-block px-2 py-0.5 text-xs rounded bg-rose-100 text-rose-800 ml-2">冲刺${n ? ('差' + n) : ''}</span>`;
            }

            const opSubParts = [];
            if (opType === 'nearmiss' && row._opptyGapText) {
                opSubParts.push(`差距: ${row._opptyGapText}`);
            } else if (match.status === 'fail') {
                const cnt = (typeof row._gapCount === 'number') ? row._gapCount : null;
                const mx = (typeof row._gapMax === 'number') ? row._gapMax : null;
                if (row._gapText) {
                    const head = [];
                    if (cnt) head.push(`${cnt}科`);
                    if (mx) head.push(`最大差${mx}标`);
                    const prefix = head.length ? `${head.join(' / ')}：` : '';
                    opSubParts.push(`差距: ${prefix}${row._gapText}`);
                } else if (row._gapReason) {
                    opSubParts.push(`差距: ${row._gapReason}`);
                }
            }
            if (Array.isArray(row._opptySignals) && row._opptySignals.length) {
                opSubParts.push(`可咨询: ${row._opptySignals.slice(0, 2).join('、')}`);
            }
            const opSub = opSubParts.length
                ? `<div class="text-xs text-gray-500 mt-1">${escapeHtml(opSubParts.join(' · '))}</div>`
                : '';

            const deptCellHtml = `
                <td class="px-2 md:px-3 py-2 border-b text-center text-sm text-gray-700">
                    <div>${escapeHtml(row.deptName || '')}${opBadge}</div>
                    ${opSub}
                </td>
            `;

            const other = String(row.otherText || '');
            const otherShort = other.length > 120 ? other.slice(0, 120) + '…' : other;

            // Mobile cards
            if (renderCards) {
                const schoolLink = g.sourceUrl
                    ? `<a href="${escapeHtml(g.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline" onclick="event.stopPropagation()">${escapeHtml(g.schoolName)}</a>`
                    : `${escapeHtml(g.schoolName)}`;

                const rowBadge = base.scoreActive
                    ? (match.status === 'pass'
                        ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800">可报</span>'
                        : match.status === 'unknown'
                            ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800">需核对</span>'
                            : '<span class="inline-block px-2 py-0.5 text-xs rounded bg-rose-100 text-rose-800">不达标</span>')
                    : '';

                const twBadgeSmall = g.taiwanRecognized
                    ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-green-100 text-green-700">台湾承认</span>'
                    : '<span class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-500">未承认</span>';

                const sub = opSubParts.length
                    ? `<div class="mt-1 text-xs text-gray-600">${escapeHtml(opSubParts.join(' · '))}</div>`
                    : '';

                const reqGrid = SUBJECTS.map(({ key, label }) => {
                    return `
                        <div class="flex items-center justify-between bg-gray-50 rounded px-2 py-1">
                            <span class="text-gray-500">${escapeHtml(label)}</span>
                            <span class="font-medium text-gray-800">${escapeHtml(formatReq(row.reqs[key]))}</span>
                        </div>
                    `;
                }).join('');

                const otherShortCard = other.length > 90 ? other.slice(0, 90) + '…' : other;
                const otherHtml = otherShortCard
                    ? `<div class="mt-2 text-xs text-gray-700">${escapeHtml(otherShortCard)}</div>`
                    : '';

                cardsHtml += `
                    <div class="p-3 bg-white border-b cursor-pointer active:bg-gray-50" data-row-key="${escapeHtml(rowKey)}">
                        <div class="flex items-start justify-between gap-3">
                            <div class="font-semibold text-gray-900 leading-snug">${schoolLink}</div>
                            <div class="shrink-0">${rowBadge}</div>
                        </div>
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <span class="inline-block px-2 py-0.5 text-xs rounded ${tierClass}">${escapeHtml(tier)}</span>
                            <span class="text-xs text-gray-500">${escapeHtml(g.area || '')}</span>
                            ${twBadgeSmall}
                            <span class="inline-block px-2 py-0.5 text-xs rounded ${confClass}">${escapeHtml(conf)}</span>
                            <span class="text-xs text-gray-500">截止: ${escapeHtml(deadline || '-')}</span>
                        </div>
                        <div class="mt-2 text-sm text-gray-800">${escapeHtml(row.deptName || '')}${opBadge}</div>
                        ${sub}
                        <div class="mt-2 grid grid-cols-2 gap-2 text-xs">${reqGrid}</div>
                        ${otherHtml}
                    </div>
                `;
            }

            if (renderTable) {
                html += `
                    <tr class="${rowClass} cursor-pointer" data-row-key="${escapeHtml(rowKey)}">
                        ${schoolCells}
                        ${deptCellHtml}
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.chinese))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.english))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.math_a))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.math_b))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.social))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.science))}</td>
                        <td class="px-2 md:px-3 py-2 border-b text-sm text-gray-800" title="${escapeHtml(other)}">${escapeHtml(otherShort)}</td>
                        ${tailCells}
                    </tr>
                `;
            }
        });
    }

    if (renderTable) {
        setHtml(elements.tableBody, html);
    } else {
        setHtml(elements.tableBody, '');
    }
    if (elements.cardsWrap) {
        setHtml(elements.cardsWrap, renderCards ? cardsHtml : '');
    }
}

function openModal(rowKey) {
    const item = visibleRowMap.get(rowKey);
    if (!item) return;
    const g = item.group;
    const row = item.row;

    const title = row.deptName && row.deptName !== '全部'
        ? `${g.schoolName} · ${row.deptName}`
        : `${g.schoolName}`;

    const tier = g.tier || '非双一流';
    const tw = g.taiwanRecognized ? '台湾承认' : '未承认';
    const processedAt = g.processedAt ? `提取时间: ${g.processedAt}` : '';
    const match = row._match || {};
    const matchText = (match.status === 'pass')
        ? `匹配: 可报（适配余量 ${match.fit}）`
        : (match.status === 'unknown')
            ? `匹配: 需核对（${match.reason || '原因不明'}）`
            : (match.status === 'fail')
                ? `匹配: 不符合（${match.reason || '原因不明'}）`
                : '';

    let gapInfo = '';
    if (match.status === 'fail') {
        if (String(row._opptyType || '') === 'nearmiss' && row._opptyGapText) {
            gapInfo = String(row._opptyGapText);
        } else if (row._gapText) {
            const cnt = (typeof row._gapCount === 'number') ? row._gapCount : null;
            const mx = (typeof row._gapMax === 'number') ? row._gapMax : null;
            const head = [];
            if (cnt) head.push(`${cnt}科未达`);
            if (mx) head.push(`最大差${mx}标`);
            const prefix = head.length ? (head.join('，') + '；') : '';
            gapInfo = prefix + String(row._gapText);
        } else if (row._gapReason) {
            gapInfo = String(row._gapReason);
        }
    }
    const gapBlock = gapInfo
        ? `<div class="mt-4"><h3 class="font-medium mb-2">与当前成绩差距</h3><div class="text-sm text-gray-700">${escapeHtml(gapInfo)}</div></div>`
        : '';

    setText(elements.modalTitle, title);
    setText(elements.modalSubtitle, [g.area, tier, tw, matchText, processedAt].filter(Boolean).join(' · '));

    const reqRow = SUBJECTS.map(({ key, label }) => {
        const v = row.reqs[key];
        return `<th class="px-2 py-1 border text-center">${escapeHtml(label)}</th>`;
    }).join('');

    const reqVals = SUBJECTS.map(({ key }) => {
        return `<td class="px-2 py-1 border text-center">${escapeHtml(formatReq(row.reqs[key]))}</td>`;
    }).join('');

    const otherConditions = Array.isArray(g.extraction.other_conditions)
        ? g.extraction.other_conditions.filter(x => typeof x === 'string' && x.trim())
        : [];
    const notes = g.extraction.notes ? String(g.extraction.notes) : '';

    const majorsForRow = collectMajorsForRow(g, row);
    const majorsShort = majorsForRow.length > 80
        ? majorsForRow.slice(0, 80).join('、') + ` …（共${majorsForRow.length}个）`
        : majorsForRow.join('、');
    const majorsHtml = majorsForRow.length
        ? `<div class="text-sm text-gray-700 whitespace-pre-wrap" title="${escapeHtml(majorsForRow.join('、'))}">${escapeHtml(majorsShort)}</div>`
        : '<div class="text-sm text-gray-400">无</div>';

    const related = Array.isArray(g.result.related_links) ? g.result.related_links : [];
    const images = Array.isArray(g.result.image_links) ? g.result.image_links : [];

    const sourceLink = g.sourceUrl
        ? `<a class="text-blue-600 hover:underline" href="${escapeHtml(g.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开原文链接</a>`
        : '<span class="text-gray-400">无原文链接</span>';

    const relatedList = related.length
        ? `<ul class="list-disc list-inside text-sm text-gray-700">${related.slice(0, 10).map(l => {
            const url = l && l.url ? String(l.url) : '';
            const text = (l && l.text) ? String(l.text) : url;
            if (!url) return '';
            return `<li><a class="text-blue-600 hover:underline" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a></li>`;
        }).join('')}</ul>`
        : '<div class="text-sm text-gray-400">无</div>';

    const imageList = images.length
        ? `<ul class="list-disc list-inside text-sm text-gray-700">${images.slice(0, 10).map(u => {
            const url = String(u || '');
            if (!url) return '';
            return `<li><a class="text-blue-600 hover:underline" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></li>`;
        }).join('')}</ul>`
        : '<div class="text-sm text-gray-400">无</div>';

    const rawJson = {
        school: {
            id: g.schoolId,
            name: g.schoolName,
            area: g.area,
            tier: g.tier,
            taiwan_recognized: g.taiwanRecognized,
            source_url: g.sourceUrl,
        },
        extraction: g.extraction,
        selected_department: {
            department: row.deptName,
            subjects: row.reqs,
            notes: row.deptNotes,
            majors: majorsForRow,
        },
        related_links: related,
        image_links: images,
    };

    setHtml(elements.modalContent, `
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-sm">${sourceLink}</div>
            <div class="text-sm text-gray-600">截止日期: ${escapeHtml(g.extraction.application_deadline || '-')} · 信心度: ${escapeHtml(g.extraction.confidence || '-')}</div>
        </div>

        <div class="mt-4">
            <h3 class="font-medium mb-2">该行科目要求</h3>
            <table class="w-full text-sm border">
                <tr class="bg-gray-50">
                    ${reqRow}
                </tr>
                <tr>
                    ${reqVals}
                </tr>
            </table>
        </div>

        ${gapBlock}

        <div class="mt-4">
            <h3 class="font-medium mb-2">其他条件</h3>
            ${otherConditions.length ? `<ul class="list-disc list-inside text-sm text-gray-700">${otherConditions.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<div class="text-sm text-gray-400">无</div>'}
            ${row.deptNotes ? `<div class="mt-2 text-sm text-gray-700"><span class="font-medium">适用类别备注：</span>${escapeHtml(row.deptNotes)}</div>` : ''}
        </div>

        <div class="mt-4">
            <h3 class="font-medium mb-2">该分组包含专业</h3>
            ${majorsHtml}
        </div>

        ${notes ? `<div class="mt-4"><h3 class="font-medium mb-2">备注</h3><div class="text-sm text-gray-700 whitespace-pre-wrap">${escapeHtml(notes)}</div></div>` : ''}

        <div class="mt-4">
            <h3 class="font-medium mb-2">已追踪关联链接</h3>
            ${relatedList}
        </div>

        <div class="mt-4">
            <h3 class="font-medium mb-2">图片链接（如有）</h3>
            ${imageList}
        </div>

        <details class="mt-4">
            <summary class="cursor-pointer text-sm text-gray-700">查看原始JSON</summary>
            <pre class="text-xs bg-gray-50 p-3 border rounded overflow-x-auto mt-2">${escapeHtml(JSON.stringify(rawJson, null, 2))}</pre>
        </details>
    `);

    elements.modal.classList.remove('hidden');
}

function closeModal() {
    elements.modal.classList.add('hidden');
    setHtml(elements.modalContent, '');
}

// Events
elements.btnRefresh.addEventListener('click', fetchAllResults);
elements.btnReset.addEventListener('click', () => {
    for (const { key } of SUBJECTS) {
        if (elements.scoreSelects[key]) elements.scoreSelects[key].value = '';
    }
    clearUserScoresStorage();
    scheduleRender();
});

if (elements.majorSearch) {
    elements.majorSearch.addEventListener('input', () => {
        // only re-render chips for search; table stays
        renderMajorChips(lastMajorAvailable, lastMajorNoteText);
    });
}

if (elements.majorChips) {
    elements.majorChips.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-major]');
        if (!btn) return;
        const norm = normalizeMajorKey(btn.dataset.major);
        if (!norm) return;
        if (selectedMajors.has(norm)) {
            selectedMajors.delete(norm);
        } else {
            selectedMajors.add(norm);
            if (!majorLabelCache.has(norm)) majorLabelCache.set(norm, norm);
        }
        saveSelectedMajorsToStorage();
        scheduleRender();
    });
}

if (elements.btnClearMajors) {
    elements.btnClearMajors.addEventListener('click', () => {
        selectedMajors.clear();
        clearSelectedMajorsStorage();
        scheduleRender();
    });
}

function applyOpptyUiState() {
    if (!elements.opptyEnabled || !elements.opptyPanel || !elements.chkOnlyEligible) return;
    const on = !!elements.opptyEnabled.checked;
    elements.opptyPanel.classList.toggle('hidden', !on);

    if (on) {
        if (opptyOnlyEligibleSnapshot === null) {
            opptyOnlyEligibleSnapshot = !!elements.chkOnlyEligible.checked;
        }
        if (elements.chkShowFail && opptyShowFailSnapshot === null) {
            opptyShowFailSnapshot = !!elements.chkShowFail.checked;
        }
        // opportunity mode may include "fail" (near-miss), disable this switch to avoid confusion
        elements.chkOnlyEligible.checked = false;
        elements.chkOnlyEligible.disabled = true;
        if (elements.chkShowFail) {
            elements.chkShowFail.checked = false;
            elements.chkShowFail.disabled = true;
        }
    } else {
        elements.chkOnlyEligible.disabled = false;
        if (opptyOnlyEligibleSnapshot !== null) {
            elements.chkOnlyEligible.checked = !!opptyOnlyEligibleSnapshot;
        }
        opptyOnlyEligibleSnapshot = null;

        if (elements.chkShowFail) {
            elements.chkShowFail.disabled = false;
            if (opptyShowFailSnapshot !== null) {
                elements.chkShowFail.checked = !!opptyShowFailSnapshot;
            }
        }
        opptyShowFailSnapshot = null;
    }
}

// Opportunity mode events
if (elements.opptyEnabled) {
    elements.opptyEnabled.addEventListener('change', () => {
        applyOpptyUiState();
        saveOpptySettingsToStorage();
        scheduleRender();
    });
}

[elements.opptyModeTransfer, elements.opptyModeNearmiss, elements.opptyGap].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => {
        saveOpptySettingsToStorage();
        scheduleRender();
    });
});

if (elements.opptyTargets) {
    elements.opptyTargets.addEventListener('change', () => {
        saveOpptySettingsToStorage();
        scheduleRender();
    });
}

if (elements.opptyHotzones) {
    elements.opptyHotzones.addEventListener('change', () => {
        saveOpptySettingsToStorage();
        scheduleRender();
    });
}

if (elements.opptyKeywords) {
    elements.opptyKeywords.addEventListener('input', () => {
        saveOpptySettingsToStorage();
        scheduleRender();
    });
}

// Filters & score changes
[
    elements.filterTaiwan,
    elements.filterConfidence,
    elements.sortBy,
    elements.chkOnlyEligible,
    elements.chkIncludeUnknown,
    elements.chkShowFail,
].forEach(el => el && el.addEventListener('change', scheduleRender));

if (elements.filterSearch) {
    elements.filterSearch.addEventListener('input', scheduleRender);
}

Object.values(elements.scoreSelects).forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => {
        saveUserScoresToStorage();
        scheduleRender();
    });
});

// Area multi-select
if (elements.filterAreaBtn && elements.filterAreaPanel) {
    elements.filterAreaBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const open = elements.filterAreaPanel.classList.contains('hidden');
        // close the other panel
        if (elements.filterTierPanel) setPanelOpen(elements.filterTierPanel, false);
        setPanelOpen(elements.filterAreaPanel, open);
    });
}

if (elements.filterAreaOptions) {
    elements.filterAreaOptions.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-value]');
        if (!cb) return;
        const v = String(cb.dataset.value || '');
        if (!v) return;
        if (cb.checked) selectedAreas.add(v);
        else selectedAreas.delete(v);
        updateAreaFilterLabel();
        scheduleRender();
    });
}

if (elements.filterAreaClear) {
    elements.filterAreaClear.addEventListener('click', () => {
        selectedAreas.clear();
        if (elements.filterAreaOptions) {
            elements.filterAreaOptions.querySelectorAll('input[type="checkbox"][data-value]').forEach(cb => { cb.checked = false; });
        }
        updateAreaFilterLabel();
        scheduleRender();
    });
}

if (elements.filterAreaAll) {
    elements.filterAreaAll.addEventListener('click', () => {
        const values = [];
        if (elements.filterAreaOptions) {
            elements.filterAreaOptions.querySelectorAll('input[type="checkbox"][data-value]').forEach(cb => {
                const v = String(cb.dataset.value || '');
                if (!v) return;
                cb.checked = true;
                values.push(v);
            });
        }
        selectedAreas = new Set(values);
        updateAreaFilterLabel();
        scheduleRender();
    });
}

if (elements.filterAreaSearch) {
    elements.filterAreaSearch.addEventListener('input', applyAreaSearchFilter);
}

// Tier multi-select
if (elements.filterTierBtn && elements.filterTierPanel) {
    elements.filterTierBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const open = elements.filterTierPanel.classList.contains('hidden');
        if (elements.filterAreaPanel) setPanelOpen(elements.filterAreaPanel, false);
        setPanelOpen(elements.filterTierPanel, open);
    });
}

if (elements.filterTierOptions) {
    elements.filterTierOptions.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-value]');
        if (!cb) return;
        const v = String(cb.dataset.value || '');
        if (!v) return;
        if (cb.checked) selectedTiers.add(v);
        else selectedTiers.delete(v);
        updateTierFilterLabel();
        scheduleRender();
    });
}

if (elements.filterTierClear) {
    elements.filterTierClear.addEventListener('click', () => {
        selectedTiers.clear();
        if (elements.filterTierOptions) {
            elements.filterTierOptions.querySelectorAll('input[type="checkbox"][data-value]').forEach(cb => { cb.checked = false; });
        }
        updateTierFilterLabel();
        scheduleRender();
    });
}

if (elements.filterTierAll) {
    elements.filterTierAll.addEventListener('click', () => {
        const values = [];
        if (elements.filterTierOptions) {
            elements.filterTierOptions.querySelectorAll('input[type="checkbox"][data-value]').forEach(cb => {
                const v = String(cb.dataset.value || '');
                if (!v) return;
                cb.checked = true;
                values.push(v);
            });
        }
        selectedTiers = new Set(values);
        updateTierFilterLabel();
        scheduleRender();
    });
}

// Close panels on outside click
document.addEventListener('click', (e) => {
    const t = e.target;
    if (elements.filterAreaPanel && !t.closest('#filter-area-panel') && !t.closest('#filter-area-btn')) {
        setPanelOpen(elements.filterAreaPanel, false);
    }
    if (elements.filterTierPanel && !t.closest('#filter-tier-panel') && !t.closest('#filter-tier-btn')) {
        setPanelOpen(elements.filterTierPanel, false);
    }
});

elements.tableBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-row-key]');
    if (!tr) return;
    if (e.target.closest('a')) return;
    openModal(tr.dataset.rowKey);
});

if (elements.cardsWrap) {
    elements.cardsWrap.addEventListener('click', (e) => {
        const card = e.target.closest('[data-row-key]');
        if (!card) return;
        if (e.target.closest('a')) return;
        openModal(card.dataset.rowKey);
    });
}

elements.btnCloseModal.addEventListener('click', closeModal);
elements.modalBackdrop.addEventListener('click', closeModal);
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !elements.modal.classList.contains('hidden')) closeModal();
});

window.addEventListener('resize', scheduleRender);

function initSecretStarEntry() {
    let count = 0;
    let lastTs = 0;

    const isTypingTarget = (t) => {
        if (!t) return false;
        const tag = String(t.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
        if (t.isContentEditable) return true;
        return false;
    };

    window.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.repeat) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;

        const key = String(e.key || '').toLowerCase();
        if (key !== 'f') return;

        const now = Date.now();
        if (now - lastTs > 1200) count = 0;
        lastTs = now;
        count += 1;

        if (count >= 3) {
            count = 0;
            window.location.href = '/star';
        }
    });
}

// Init
(async function init() {
    initLangSwitch();
    applyLangToStaticDom();
    initSecretStarEntry();
    console.log(`[CollegeFinder] summary UI ${UI_VERSION} initializing...`);
    for (const el of Object.values(elements.scoreSelects)) {
        fillStandardOptions(el);
    }
    loadUserScoresFromStorage();
    loadSelectedMajorsFromStorage();
    applyOpptySettingsToUI(loadOpptySettingsFromStorage());
    applyOpptyUiState();
    initTierFilterOptions();
    API_BASE = await detectApiBase();
    await fetchAllResults();
})();
