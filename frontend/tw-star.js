/* global OpenCC */

const STORAGE_KEY_LANG = 'collegefinder.ui.lang.v1';
const STORAGE_KEY_TW_INPUT = 'collegefinder.tw_star.input.v1';

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

    document.querySelectorAll('[placeholder]').forEach(el => {
        const v = el.getAttribute('placeholder');
        if (v) el.setAttribute('placeholder', toUI(v));
    });
    document.querySelectorAll('[title]').forEach(el => {
        const v = el.getAttribute('title');
        if (v) el.setAttribute('title', toUI(v));
    });

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

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const STANDARD_RANK = {
    '底标': 1,
    '后标': 2,
    '均标': 3,
    '前标': 4,
    '顶标': 5,
};

function normStdWord(s) {
    const v = String(s ?? '').trim();
    if (!v || v === '--' || v === '-') return '';
    const map = {
        '頂標': '顶标',
        '前標': '前标',
        '均標': '均标',
        '後標': '后标',
        '底標': '底标',
        '顶标': '顶标',
        '前标': '前标',
        '均标': '均标',
        '后标': '后标',
        '底标': '底标',
    };
    return map[v] || v;
}

function isStdEmpty(v) {
    const s = String(v ?? '').trim();
    return !s || s === '--' || s === '-';
}

function subjectKeyFromName(name) {
    const s = String(name ?? '').trim();
    const map = {
        '国文': 'chinese',
        '國文': 'chinese',
        '英文': 'english',
        '英語': 'english',
        '英语': 'english',
        '數學A': 'math_a',
        '数学A': 'math_a',
        '數學B': 'math_b',
        '数学B': 'math_b',
        '社會': 'social',
        '社会': 'social',
        '自然': 'science',
        '英聽': 'listen',
        '英听': 'listen',
    };
    return map[s] || '';
}

function fmtReqMap(reqMap) {
    const out = [];
    const order = ['國文', '英文', '數學A', '數學B', '社會', '自然', '英聽'];
    order.forEach(k => {
        const v = (reqMap || {})[k];
        if (isStdEmpty(v)) return;
        out.push(`${k}${v ? ' ' + v : ''}`);
    });
    if (!out.length) return '无明确检定';
    return out.join('；');
}

function fmtApplyStage1(stage1) {
    const rows = Array.isArray(stage1) ? stage1 : [];
    const out = [];
    rows.forEach(r => {
        if (!r || typeof r !== 'object') return;
        const subj = String(r.subject || '').trim();
        const std = String(r.standard || '').trim();
        if (!subj) return;
        if (isStdEmpty(std)) return;
        out.push(`${subj} ${std}`);
    });
    if (!out.length) return '无明确检定';
    return out.join('；');
}

function median(nums) {
    const arr = (nums || []).filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    if (arr.length % 2 === 1) return arr[mid];
    return (arr[mid - 1] + arr[mid]) / 2;
}

function overallCutoff(entry) {
    const r1 = Array.isArray(entry && entry.round1) ? entry.round1 : [];
    const r2 = Array.isArray(entry && entry.round2) ? entry.round2 : [];
    const v1 = (typeof r1[0] === 'number') ? r1[0] : null;
    const v2 = (typeof r2[0] === 'number') ? r2[0] : null;
    if (v1 === null && v2 === null) return null;
    if (v1 === null) return v2;
    if (v2 === null) return v1;
    // More conservative (harder) cutoff: smaller school-rank percent is more selective.
    return Math.min(v1, v2);
}

function formatPercent(v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return '-';
    const s = (Math.round(v * 10) / 10).toString();
    return `${s}%`;
}

function loadInputState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_TW_INPUT);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
        return null;
    }
}

function saveInputState(obj) {
    try {
        localStorage.setItem(STORAGE_KEY_TW_INPUT, JSON.stringify(obj));
    } catch (e) {
        // ignore
    }
}

const elements = {
    loadIndicator: document.getElementById('load-indicator'),
    btnReset: document.getElementById('btn-reset'),
    sortBy: document.getElementById('sort-by'),
    filterSchool: document.getElementById('filter-school'),
    filterBucket: document.getElementById('filter-bucket'),
    filterGroupsWrap: document.getElementById('filter-groups'),
    filterSearch: document.getElementById('filter-search'),
    resultCount: document.getElementById('result-count'),
    resultNote: document.getElementById('result-note'),
    body: document.getElementById('result-body'),
    cards: document.getElementById('result-cards'),
    modal: document.getElementById('detail-modal'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalSubtitle: document.getElementById('modal-subtitle'),
    modalContent: document.getElementById('modal-content'),
    scores: {
        chinese: document.getElementById('score-chinese'),
        english: document.getElementById('score-english'),
        math_a: document.getElementById('score-math_a'),
        math_b: document.getElementById('score-math_b'),
        social: document.getElementById('score-social'),
        science: document.getElementById('score-science'),
        listen: document.getElementById('score-listen'),
    },
    stds: {
        chinese: document.getElementById('std-chinese'),
        english: document.getElementById('std-english'),
        math_a: document.getElementById('std-math_a'),
        math_b: document.getElementById('std-math_b'),
        social: document.getElementById('std-social'),
        science: document.getElementById('std-science'),
    },
    pcts: {
        overall: document.getElementById('pct-overall'),
        chinese: document.getElementById('pct-chinese'),
        english: document.getElementById('pct-english'),
        math: document.getElementById('pct-math'),
        social: document.getElementById('pct-social'),
        science: document.getElementById('pct-science'),
        history: document.getElementById('pct-history'),
        geo: document.getElementById('pct-geo'),
        civics: document.getElementById('pct-civics'),
    },
};

let DATASET = null;
let VISIBLE = [];
let SCHOOL_RANK = new Map();

function getSelectedGroups() {
    const wrap = elements.filterGroupsWrap;
    if (!wrap) return new Set([1, 2, 3, 5, 8]);
    const out = new Set();
    wrap.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
        if (cb.checked) {
            const n = Number(cb.value);
            if (Number.isFinite(n)) out.add(n);
        }
    });
    return out;
}

function fillSelectOptions() {
    const scoreOpts = [''].concat(Array.from({ length: 15 }, (_, i) => String(i + 1)));
    Object.values(elements.scores).forEach(sel => {
        if (!sel) return;
        if (sel === elements.scores.listen) return;
        setHtml(sel, scoreOpts.map(v => {
            const lb = v ? v : '未填写';
            return `<option value="${escapeHtml(v)}">${escapeHtml(toUI(lb))}</option>`;
        }).join(''));
    });

    const stdOpts = [''].concat(Object.keys(STANDARD_RANK));
    Object.values(elements.stds).forEach(sel => {
        if (!sel) return;
        setHtml(sel, stdOpts.map(v => {
            const lb = v ? v : '未填写';
            return `<option value="${escapeHtml(v)}">${escapeHtml(toUI(lb))}</option>`;
        }).join(''));
    });
}

function computeSchoolRankMap(programsDict) {
    const bySchool = new Map();
    const all = Object.values(programsDict || {});
    all.forEach(p => {
        if (!p || typeof p !== 'object') return;
        const school = String(p.school_name || '').trim();
        if (!school) return;
        const cut = computeStarCutoffStats(p);
        const med = (typeof cut.median === 'number' && !Number.isNaN(cut.median)) ? cut.median : null;
        if (med === null) return;
        if (!bySchool.has(school)) bySchool.set(school, []);
        bySchool.get(school).push(med);
    });

    const scored = [];
    bySchool.forEach((vals, school) => {
        const arr = (vals || []).filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
        if (!arr.length) return;
        const k = Math.max(3, Math.min(10, arr.length));
        const score = median(arr.slice(0, k)); // lower % => more selective
        if (typeof score === 'number' && !Number.isNaN(score)) {
            scored.push({ school, score });
        }
    });

    scored.sort((a, b) => a.score - b.score);
    const rank = new Map();
    scored.forEach((s, idx) => {
        rank.set(s.school, idx + 1);
    });
    return rank;
}

function fillSchoolOptions() {
    const sel = elements.filterSchool;
    if (!sel || !DATASET || !DATASET.programs) return;
    const schools = new Map();
    Object.values(DATASET.programs).forEach(p => {
        if (!p || typeof p !== 'object') return;
        const name = String(p.school_name || '').trim();
        if (!name) return;
        schools.set(name, true);
    });

    const list = Array.from(schools.keys());
    list.sort((a, b) => {
        const ra = SCHOOL_RANK.get(a) || 1e9;
        const rb = SCHOOL_RANK.get(b) || 1e9;
        if (ra !== rb) return ra - rb;
        return a.localeCompare(b, (UI_LANG === 'zh-TW') ? 'zh-Hant-TW' : 'zh-Hans-CN');
    });

    const cur = String(sel.value || '');
    setHtml(sel, ['<option value="">全部学校</option>'].concat(list.map(s => {
        const r = SCHOOL_RANK.get(s);
        const label = r ? `${s}（#${r}）` : s;
        return `<option value="${escapeHtml(s)}">${escapeHtml(toUI(label))}</option>`;
    })).join(''));
    sel.value = cur;
}

function readUserInput() {
    const scores = {
        chinese: String(elements.scores.chinese ? (elements.scores.chinese.value || '') : ''),
        english: String(elements.scores.english ? (elements.scores.english.value || '') : ''),
        math_a: String(elements.scores.math_a ? (elements.scores.math_a.value || '') : ''),
        math_b: String(elements.scores.math_b ? (elements.scores.math_b.value || '') : ''),
        social: String(elements.scores.social ? (elements.scores.social.value || '') : ''),
        science: String(elements.scores.science ? (elements.scores.science.value || '') : ''),
        listen: String(elements.scores.listen ? (elements.scores.listen.value || '') : ''),
    };

    const stds = {
        chinese: String(elements.stds.chinese ? (elements.stds.chinese.value || '') : ''),
        english: String(elements.stds.english ? (elements.stds.english.value || '') : ''),
        math_a: String(elements.stds.math_a ? (elements.stds.math_a.value || '') : ''),
        math_b: String(elements.stds.math_b ? (elements.stds.math_b.value || '') : ''),
        social: String(elements.stds.social ? (elements.stds.social.value || '') : ''),
        science: String(elements.stds.science ? (elements.stds.science.value || '') : ''),
    };

    const pct = {};
    Object.entries(elements.pcts).forEach(([k, el]) => {
        const raw = String(el ? (el.value || '') : '').trim();
        pct[k] = raw;
    });

    const filters = {
        school: String(elements.filterSchool ? (elements.filterSchool.value || '') : ''),
        groups: Array.from(getSelectedGroups()),
        bucket: String(elements.filterBucket ? (elements.filterBucket.value || 'all') : 'all'),
        sortBy: String(elements.sortBy ? (elements.sortBy.value || 'schoolBest') : 'schoolBest'),
        search: String(elements.filterSearch ? (elements.filterSearch.value || '') : '').trim(),
    };

    return { scores, stds, pct, filters };
}

function applyInputToUI(state) {
    if (!state || typeof state !== 'object') return;
    const { scores, stds, pct, filters } = state;
    if (scores && typeof scores === 'object') {
        Object.entries(elements.scores).forEach(([k, el]) => {
            if (!el) return;
            const v = String(scores[k] || '');
            el.value = v;
        });
    }
    if (stds && typeof stds === 'object') {
        Object.entries(elements.stds).forEach(([k, el]) => {
            if (!el) return;
            const v = String(stds[k] || '');
            el.value = v;
        });
    }
    if (pct && typeof pct === 'object') {
        Object.entries(elements.pcts).forEach(([k, el]) => {
            if (!el) return;
            const v = String(pct[k] || '');
            el.value = v;
        });
    }
    if (filters && typeof filters === 'object') {
        if (elements.filterSchool && typeof filters.school === 'string') elements.filterSchool.value = filters.school;
        if (elements.filterBucket && typeof filters.bucket === 'string') elements.filterBucket.value = filters.bucket;
        if (elements.sortBy && typeof filters.sortBy === 'string') elements.sortBy.value = filters.sortBy;
        if (elements.filterSearch && typeof filters.search === 'string') elements.filterSearch.value = filters.search;

        // groups
        if (elements.filterGroupsWrap && Array.isArray(filters.groups)) {
            const set = new Set(filters.groups.map(x => Number(x)).filter(n => Number.isFinite(n)));
            elements.filterGroupsWrap.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
                const n = Number(cb.value);
                if (!Number.isFinite(n)) return;
                cb.checked = set.has(n);
            });
        }
    }
}

function parsePct(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 100) return null;
    return n;
}

function evaluateStdRequirement(reqStd, userStd, userScore) {
    const r = normStdWord(reqStd);
    if (!r) return { ok: true, unknown: false, reason: null };

    // numeric requirement (rare)
    const m = String(reqStd || '').match(/(\d{1,2})/);
    if (m) {
        const need = Number(m[1]);
        const us = Number(userScore || '');
        if (!Number.isFinite(need)) return { ok: true, unknown: true, reason: '要求解析失败' };
        if (!Number.isFinite(us)) return { ok: false, unknown: true, reason: '缺少级分' };
        return { ok: us >= need, unknown: false, reason: us >= need ? null : `级分不足(${us}<${need})` };
    }

    const rr = STANDARD_RANK[r];
    if (!rr) return { ok: true, unknown: true, reason: '要求解析失败' };
    const u = normStdWord(userStd);
    const ur = STANDARD_RANK[u];
    if (!ur) return { ok: false, unknown: true, reason: '缺少五标' };
    if (ur < rr) return { ok: false, unknown: false, reason: `未达标(${u}<${r})` };
    return { ok: true, unknown: false, reason: null };
}

function evalStarPass(prog, input) {
    const reqs = ((prog || {}).star_current || {}).requirements || {};
    const scores = (input || {}).scores || {};
    const stds = (input || {}).stds || {};

    let anyUnknown = false;
    for (const [subjName, reqStd] of Object.entries(reqs)) {
        const key = subjectKeyFromName(subjName);
        if (!key) continue;
        const userStd = stds[key] || '';
        const userScore = scores[key] || '';
        const res = evaluateStdRequirement(reqStd, userStd, userScore);
        if (!res.ok) {
            return { status: 'fail', reason: `${subjName}${res.reason ? '：' + res.reason : ''}` };
        }
        if (res.unknown) anyUnknown = true;
    }
    return anyUnknown ? { status: 'unknown', reason: '部分科目缺少五标/级分' } : { status: 'pass', reason: null };
}

function evalApplyPass(prog, input) {
    const stage1 = ((prog || {}).apply_current || {}).stage1 || [];
    const scores = (input || {}).scores || {};
    const stds = (input || {}).stds || {};
    let anyUnknown = false;

    (Array.isArray(stage1) ? stage1 : []).forEach(row => {
        // no-op; we will early-return via exceptions? keep simple below
    });

    for (const row of (Array.isArray(stage1) ? stage1 : [])) {
        if (!row || typeof row !== 'object') continue;
        const subjName = String(row.subject || '').trim();
        const reqStd = row.standard;
        const key = subjectKeyFromName(subjName);
        if (!key) continue;
        const res = evaluateStdRequirement(reqStd, stds[key] || '', scores[key] || '');
        if (!res.ok) {
            return { status: 'fail', reason: `${subjName}${res.reason ? '：' + res.reason : ''}` };
        }
        if (res.unknown) anyUnknown = true;
    }

    return anyUnknown ? { status: 'unknown', reason: '部分科目缺少五标/级分' } : { status: 'pass', reason: null };
}

function computeStarCutoffStats(prog) {
    const hist = (prog || {}).star_history || {};
    const years = ['112', '113', '114'];
    const byYear = {};
    const nums = [];
    years.forEach(y => {
        const e = hist[y];
        if (!e) return;
        const v = overallCutoff(e);
        if (typeof v === 'number' && !Number.isNaN(v)) {
            byYear[y] = v;
            nums.push(v);
        }
    });
    const med = median(nums);
    const mx = nums.length ? Math.max(...nums) : null;
    return { byYear, median: med, max: mx, count: nums.length };
}

function normApplyExpr(expr) {
    let s = String(expr ?? '').trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '');
    s = s.replace(/（/g, '(').replace(/）/g, ')');
    s = s.replace(/[：:，,、。\.|]+/g, '');
    return s;
}

function getUserValueForApplyExpr(expr, input) {
    const s0 = normApplyExpr(expr);
    if (!s0) return null;
    const s = s0.toUpperCase();
    if (s.includes('APCS')) return null;

    const scores = (input || {}).scores || {};
    const getScore = (k) => {
        const n = Number(String(scores[k] || '').trim());
        return Number.isFinite(n) ? n : null;
    };

    const parts = [];

    const hasMathA = s.includes('數學A') || s.includes('数学A') || s.includes('數A') || s.includes('数A');
    const hasMathB = s.includes('數學B') || s.includes('数学B') || s.includes('數B') || s.includes('数B');

    const hasEnglish = (s.includes('英文') || s.includes('英语') || s.includes('英語') || s.includes('英'));
    if (hasEnglish) parts.push('english');

    // Chinese (國文) OCR may drop '國' and keep only '文'
    const hasChinese = (s.includes('國文') || s.includes('国文') || s.includes('國') || s.includes('国') || (s.includes('文') && !hasEnglish));
    if (hasChinese) parts.push('chinese');
    if (hasMathA) parts.push('math_a');
    if (hasMathB) parts.push('math_b');
    if (s.includes('社會') || s.includes('社会') || s.includes('社')) parts.push('social');
    if (s.includes('自然') || s.includes('自')) parts.push('science');

    // If only generic math is present (rare/older formats), fall back to max(math_a, math_b)
    const hasGenericMath = (s.includes('數學') || s.includes('数学') || s.includes('數') || s.includes('数')) && !hasMathA && !hasMathB;
    if (hasGenericMath) parts.push('math');

    // Deduplicate while preserving order
    const seen = new Set();
    const keys = [];
    for (const k of parts) {
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
    }

    if (!keys.length) return null;

    if (keys.length === 1 && keys[0] === 'math') {
        const a = getScore('math_a');
        const b = getScore('math_b');
        if (a === null && b === null) return null;
        if (a === null) return b;
        if (b === null) return a;
        return Math.max(a, b);
    }

    let sum = 0;
    for (const k of keys) {
        if (k === 'math') {
            const a = getScore('math_a');
            const b = getScore('math_b');
            if (a === null && b === null) return null;
            sum += (a === null) ? b : (b === null ? a : Math.max(a, b));
            continue;
        }
        const v = getScore(k);
        if (v === null) return null;
        sum += v;
    }

    return sum;
}

function compareUserToApplySieve(minOrders, input) {
    const rows = Array.isArray(minOrders) ? minOrders.slice() : [];
    rows.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    if (!rows.length) return { status: 'unknown', reason: '无筛选最低级分' };

    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const expr = String(r.expr || r.raw || '').trim();
        const need = Number(r.min_score);
        if (!expr || !Number.isFinite(need)) continue;
        const u = getUserValueForApplyExpr(expr, input);
        if (u === null) return { status: 'unknown', reason: `缺少个申比对项：${expr}` };
        if (u > need) return { status: 'pass', reason: `优于个申筛选边界：${expr}` };
        if (u < need) return { status: 'fail', reason: `低于个申筛选边界：${expr}` };
        // equal: compare next order
    }

    return { status: 'unknown', reason: '与个申边界持平（不确定）' };
}

function computeApplySieveStats(prog, input) {
    const hist = (prog || {}).apply_sieve_history || {};
    const years = ['112', '113', '114'];
    const byYear = {};
    let pass = 0;
    let fail = 0;
    let unknown = 0;

    years.forEach(y => {
        const e = hist[y];
        const minOrders = (e && Array.isArray(e.min_orders)) ? e.min_orders : [];
        const cmp = compareUserToApplySieve(minOrders, input);
        byYear[y] = { cmp, minOrders };
        if (cmp.status === 'pass') pass++;
        else if (cmp.status === 'fail') fail++;
        else unknown++;
    });

    return {
        byYear,
        passCount: pass,
        failCount: fail,
        unknownCount: unknown,
        likelyFail: fail >= 2,
        likelyPass: pass >= 2,
    };
}

function getUserValueForTieItem(item, input) {
    const s = String(item || '').trim();
    const pct = (input || {}).pct || {};
    const scores = (input || {}).scores || {};
    const listen = String(scores.listen || '').trim();

    // overall school ranking percent
    if (s.includes('在校學業成績') && s.includes('全校排名百分比')) {
        return parsePct(pct.overall);
    }

    // subject average percent, e.g. "英語文學業成績總平均全校排名百分比"
    if (s.includes('學業成績') && s.includes('總平均') && s.includes('全校排名百分比')) {
        const m = s.match(/^(.+?)學業成績/);
        const subj = m ? m[1] : '';
        const keyMap = {
            '國語文': 'chinese',
            '語文': 'chinese',
            '英語文': 'english',
            '數學': 'math',
            '社會': 'social',
            '自然': 'science',
            '歷史': 'history',
            '地理': 'geo',
            '公民': 'civics',
        };
        const k = keyMap[String(subj || '').trim()] || '';
        if (!k) return null;
        return parsePct(pct[k]);
    }

    // GSAT subject score
    if (s.includes('學測') && s.includes('級分')) {
        const m = s.match(/學測(.+?)級分/);
        const subj = m ? m[1] : '';
        const k = subjectKeyFromName(subj);
        if (!k) return null;
        const n = Number(String(scores[k] || '').trim());
        return Number.isFinite(n) ? n : null;
    }

    // sum of scores
    if (s.includes('級分總和')) {
        const keys = [];
        if (s.includes('國文')) keys.push('chinese');
        if (s.includes('英文')) keys.push('english');
        if (s.includes('社會') || s.includes('社会')) keys.push('social');
        if (s.includes('數學A') || s.includes('数学A')) keys.push('math_a');
        if (s.includes('數學B') || s.includes('数学B')) keys.push('math_b');
        if (s.includes('自然')) keys.push('science');
        let sum = 0;
        let ok = true;
        keys.forEach(k => {
            const n = Number(String(scores[k] || '').trim());
            if (!Number.isFinite(n)) ok = false;
            else sum += n;
        });
        return ok ? sum : null;
    }

    if (s.includes('英聽') && s.includes('等級')) {
        return listen || null;
    }

    return null;
}

function compareUserToBoundary(items, input, boundaryVec) {
    const vec = Array.isArray(boundaryVec) ? boundaryVec : [];
    const last = vec.findIndex(v => v === null || typeof v === 'undefined');
    // Compare until first null (boundary didn't need further tie-break)
    const limit = last === -1 ? vec.length : last;
    if (limit === 0) return { status: 'unknown', reason: '无有效边界' };

    for (let i = 0; i < limit; i++) {
        const b = vec[i];
        if (b === null || typeof b === 'undefined') break;
        const item = items[i] || '';
        const u = getUserValueForTieItem(item, input);
        if (u === null || typeof u === 'undefined') {
            return { status: 'unknown', reason: `缺少比序项：${item}` };
        }

        const isPct = String(item).includes('百分比');
        const isScore = String(item).includes('級分') || String(item).includes('级分') || String(item).includes('總和') || String(item).includes('总和');
        const isListen = String(item).includes('英聽') || String(item).includes('英听');

        if (isPct && typeof b === 'number' && typeof u === 'number') {
            if (u < b) return { status: 'pass', reason: `优于边界：${item}` };
            if (u > b) return { status: 'fail', reason: `劣于边界：${item}` };
        } else if (isScore && typeof b === 'number' && typeof u === 'number') {
            if (u > b) return { status: 'pass', reason: `优于边界：${item}` };
            if (u < b) return { status: 'fail', reason: `劣于边界：${item}` };
        } else if (isListen) {
            const rank = { 'F': 1, 'C': 2, 'B': 3, 'A': 4 };
            const br = rank[String(b || '').toUpperCase()] || 0;
            const ur = rank[String(u || '').toUpperCase()] || 0;
            if (ur > br) return { status: 'pass', reason: `优于边界：${item}` };
            if (ur < br) return { status: 'fail', reason: `劣于边界：${item}` };
        } else {
            // Fallback: string compare as equal/unknown
            if (String(u) !== String(b)) {
                return { status: 'unknown', reason: `无法比较：${item}` };
            }
        }
    }

    return { status: 'unknown', reason: '与边界持平（不确定）' };
}

function render() {
    if (!DATASET || !DATASET.programs) return;

    const input = readUserInput();
    saveInputState(input);

    const selectedGroups = new Set((input.filters && Array.isArray(input.filters.groups)) ? input.filters.groups.map(x => Number(x)) : []);
    const schoolFilter = String((input.filters || {}).school || '').trim();
    const bucketFilter = String((input.filters || {}).bucket || 'all').trim();

    const all = Object.values(DATASET.programs);
    const q = String(input.filters.search || '').toLowerCase();

    const enriched = [];
    const counts = { oppty: 0, star_good: 0, star_edge: 0, star_hard: 0, incomplete: 0 };
    for (const p of all) {
        if (!p || typeof p !== 'object') continue;
        const code = String(p.program_code || '');
        const school = String(p.school_name || '');
        const prog = String(p.program_name || '');

        if (schoolFilter && school !== schoolFilter) continue;
        if (selectedGroups.size && !selectedGroups.has(Number(p.star_group))) continue;

        if (q) {
            const hay = `${code} ${school} ${prog}`.toLowerCase();
            if (!hay.includes(q)) continue;
        }

        const starPass = evalStarPass(p, input);
        if (starPass.status === 'fail') continue; // 硬指标不符：直接排除

        const applyPass = evalApplyPass(p, input);
        const cut = computeStarCutoffStats(p);
        const userOverall = parsePct(input.pct.overall);
        const slack = (typeof cut.median === 'number' && typeof userOverall === 'number') ? (cut.median - userOverall) : null;

        let bucket = 'incomplete';
        if (starPass.status === 'pass' && typeof slack === 'number') {
            if (slack >= 0) bucket = 'star_good';
            else if (slack >= -1.0) bucket = 'star_edge';
            else bucket = 'star_hard';
        }

        const applySieve = computeApplySieveStats(p, input);
        const applyHard = (applyPass.status === 'fail') || !!applySieve.likelyFail;
        const oppty = (bucket === 'star_good') && applyHard;
        if (oppty) bucket = 'oppty';

        if (bucket in counts) counts[bucket] += 1;

        enriched.push({
            p,
            code,
            school,
            prog,
            starPass,
            applyPass,
            applySieve,
            cutoff: cut,
            slack,
            bucket,
            oppty,
        });
    }

    const passBucketFilter = (b) => {
        if (bucketFilter === 'all') return b !== 'incomplete';
        if (bucketFilter === 'oppty') return b === 'oppty';
        if (bucketFilter === 'star_good') return (b === 'star_good' || b === 'oppty');
        if (bucketFilter === 'star_edge') return b === 'star_edge';
        if (bucketFilter === 'star_hard') return b === 'star_hard';
        if (bucketFilter === 'incomplete') return b === 'incomplete';
        return true;
    };

    const shown = enriched.filter(x => passBucketFilter(x.bucket));

    const sortBy = input.filters.sortBy;
    const bucketRank = (b) => {
        if (b === 'oppty') return 0;
        if (b === 'star_good') return 1;
        if (b === 'star_edge') return 2;
        if (b === 'star_hard') return 3;
        return 4;
    };

    shown.sort((a, b) => {
        const brA = bucketRank(a.bucket);
        const brB = bucketRank(b.bucket);
        if (brA !== brB) return brA - brB;

        const locale = (UI_LANG === 'zh-TW') ? 'zh-Hant-TW' : 'zh-Hans-CN';

        const aSchoolRank = SCHOOL_RANK.get(a.school) || 1e9;
        const bSchoolRank = SCHOOL_RANK.get(b.school) || 1e9;

        const aSlack = (typeof a.slack === 'number') ? a.slack : -1e15;
        const bSlack = (typeof b.slack === 'number') ? b.slack : -1e15;

        const hardScore = (x) => {
            const sieve = x.applySieve || { failCount: 0, passCount: 0 };
            const base = (x.applyPass && x.applyPass.status === 'fail') ? 100 : 0;
            return base + (Number(sieve.failCount || 0) * 10) - Number(sieve.passCount || 0);
        };

        if (sortBy === 'schoolBest') {
            if (aSchoolRank !== bSchoolRank) return aSchoolRank - bSchoolRank;
            if (aSlack !== bSlack) return bSlack - aSlack;
        } else if (sortBy === 'starSlack') {
            if (aSlack !== bSlack) return bSlack - aSlack;
            if (aSchoolRank !== bSchoolRank) return aSchoolRank - bSchoolRank;
        } else if (sortBy === 'applyHard') {
            const ah = hardScore(a);
            const bh = hardScore(b);
            if (ah !== bh) return bh - ah;
            if (aSchoolRank !== bSchoolRank) return aSchoolRank - bSchoolRank;
        }

        const an = `${a.school} ${a.prog}`;
        const bn = `${b.school} ${b.prog}`;
        return an.localeCompare(bn, locale);
    });

    VISIBLE = shown;
    setText(elements.resultCount, String(shown.length));

    const noteParts = [];
    const userOverall2 = parsePct(input.pct.overall);
    if (userOverall2 !== null) noteParts.push(`当前校排: ${formatPercent(userOverall2)}`);
    noteParts.push(`高位机会: ${counts.oppty}`);
    noteParts.push(`可行: ${counts.star_good}`);
    noteParts.push(`边缘: ${counts.star_edge}`);
    noteParts.push(`偏难: ${counts.star_hard}`);
    noteParts.push(`无法判断: ${counts.incomplete}`);
    setText(elements.resultNote, noteParts.join('；'));

    if (!shown.length) {
        let msg = '无匹配结果';
        if (bucketFilter === 'all' && counts.incomplete > 0) {
            msg = '暂无可判断结果：请补全学测五标/级分 + 校排（总平均%），或切换分类为“资料不全/无法判断”查看';
        }
        setHtml(elements.body, `<tr><td colspan="6" class="px-4 py-10 text-center text-gray-500">${escapeHtml(toUI(msg))}</td></tr>`);
        setHtml(elements.cards, `<div class="px-4 py-10 text-center text-gray-500">${escapeHtml(toUI(msg))}</div>`);
        return;
    }

    const renderCards = !!(elements.cards && window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    let rowsHtml = '';
    let cardsHtml = '';

    shown.forEach(({ p, code, school, prog, starPass, applyPass, applySieve, cutoff, slack, bucket, oppty }) => {
        const group = p.star_group ? String(p.star_group) : '-';
        const starReq = fmtReqMap((p.star_current || {}).requirements || {});
        const applyReq = fmtApplyStage1((p.apply_current || {}).stage1 || []);
        const med = (typeof cutoff.median === 'number') ? cutoff.median : null;
        const cutoffTxt = med === null ? '-' : formatPercent(med);

        const bucketBadge = () => {
            if (bucket === 'oppty') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-indigo-100 text-indigo-800">繁星高位机会</span>';
            if (bucket === 'star_good') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800">繁星可行</span>';
            if (bucket === 'star_edge') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800">繁星边缘</span>';
            if (bucket === 'star_hard') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700">繁星偏难</span>';
            return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-500">资料不全</span>';
        };

        const slackTxt = (typeof slack === 'number') ? `${slack >= 0 ? '+' : ''}${(Math.round(slack * 10) / 10)}%` : '-';
        const sieveTxt = (applySieve && (applySieve.passCount + applySieve.failCount + applySieve.unknownCount) > 0)
            ? `个申近3年：${applySieve.passCount}通过/${applySieve.failCount}偏难/${applySieve.unknownCount}不明`
            : '个申近3年：无数据';

        const statusHtml = `${bucketBadge()} <span class="ml-2 text-xs text-gray-600">繁星余量 ${escapeHtml(slackTxt)}；${escapeHtml(sieveTxt)}</span>`;

        if (renderCards) {
            cardsHtml += `
                <div class="p-4 border-b cursor-pointer active:bg-gray-50" data-code="${escapeHtml(code)}">
                    <div class="flex items-start justify-between gap-3">
                        <div class="font-semibold text-gray-900 leading-snug">${escapeHtml(school)} · ${escapeHtml(prog)}</div>
                        <div class="shrink-0">${oppty ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-indigo-100 text-indigo-800">繁星机会</span>' : ''}</div>
                    </div>
                    <div class="mt-1 text-xs text-gray-500">代码 ${escapeHtml(code)} · 学群 ${escapeHtml(group)} · 近3年校排门槛(中位) ${escapeHtml(cutoffTxt)}</div>
                    <div class="mt-2 text-xs text-gray-700"><span class="font-medium">繁星检定：</span>${escapeHtml(starReq)}</div>
                    <div class="mt-1 text-xs text-gray-700"><span class="font-medium">个申检定：</span>${escapeHtml(applyReq)}</div>
                    <div class="mt-2">${statusHtml}</div>
                </div>
            `;
        } else {
            rowsHtml += `
                <tr class="hover:bg-gray-50 cursor-pointer" data-code="${escapeHtml(code)}">
                    <td class="px-3 py-3 border-b">
                        <div class="font-medium text-gray-900">${escapeHtml(school)} · ${escapeHtml(prog)}</div>
                        <div class="text-xs text-gray-500 mt-0.5">代码 ${escapeHtml(code)}</div>
                    </td>
                    <td class="px-3 py-3 border-b text-center">${escapeHtml(group)}</td>
                    <td class="px-3 py-3 border-b text-gray-800" title="${escapeHtml(starReq)}">${escapeHtml(starReq)}</td>
                    <td class="px-3 py-3 border-b text-gray-800" title="${escapeHtml(applyReq)}">${escapeHtml(applyReq)}</td>
                    <td class="px-3 py-3 border-b text-center">${escapeHtml(cutoffTxt)}</td>
                    <td class="px-3 py-3 border-b">${statusHtml}</td>
                </tr>
            `;
        }
    });

    setHtml(elements.body, rowsHtml);
    setHtml(elements.cards, renderCards ? cardsHtml : '');
}

function openModal(code) {
    const input = readUserInput();
    const prog = (DATASET && DATASET.programs) ? DATASET.programs[String(code)] : null;
    if (!prog) return;

    const school = String(prog.school_name || '');
    const name = String(prog.program_name || '');
    const group = prog.star_group ? String(prog.star_group) : '-';
    const starReq = fmtReqMap((prog.star_current || {}).requirements || {});
    const applyReq = fmtApplyStage1((prog.apply_current || {}).stage1 || []);

    setText(elements.modalTitle, `${school} · ${name}`);
    setText(elements.modalSubtitle, `代码 ${code} · 学群 ${group}`);

    const items = ((prog.star_current || {}).tie_break_items || []).slice();
    const years = ['112', '113', '114'];
    const hist = prog.star_history || {};
    const applyHist = prog.apply_history || {};
    const applySieveHist = prog.apply_sieve_history || {};

    const userLines = items.map(it => {
        const v = getUserValueForTieItem(it, input);
        const isPct = String(it).includes('百分比');
        const shown = (v === null || typeof v === 'undefined')
            ? '<span class="text-gray-400">未填写</span>'
            : (isPct && typeof v === 'number')
                ? escapeHtml(formatPercent(v))
                : escapeHtml(String(v));
        return `<tr><td class="border px-2 py-1">${escapeHtml(it)}</td><td class="border px-2 py-1">${shown}</td></tr>`;
    }).join('');

    function boundaryDesc(vec) {
        const v = Array.isArray(vec) ? vec : [];
        const used = [];
        for (let i = 0; i < v.length; i++) {
            if (v[i] === null || typeof v[i] === 'undefined') break;
            const it = items[i] || `#${i + 1}`;
            const isPct = String(it).includes('百分比');
            const shown = (typeof v[i] === 'number' && isPct) ? formatPercent(v[i]) : String(v[i]);
            used.push(`${it}: ${shown}`);
        }
        return used.length ? used.join('；') : '无（或未解析到）';
    }

    const yearBlocks = years.map(y => {
        const e = hist[y] || null;
        if (!e) {
            return `<div class="border rounded p-3"><div class="font-medium">${escapeHtml(y)} 学年</div><div class="text-sm text-gray-500 mt-1">无历史数据</div></div>`;
        }
        const r1 = e.round1;
        const r2 = e.round2;
        const c1 = compareUserToBoundary(items, input, r1);
        const c2 = compareUserToBoundary(items, input, r2);

        const badge = (st) => {
            if (st === 'pass') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800">可能更有利</span>';
            if (st === 'fail') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-rose-100 text-rose-800">可能偏难</span>';
            return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800">不确定</span>';
        };

        const applyMin = (applyHist[y] && applyHist[y].min_distribution) ? String(applyHist[y].min_distribution) : '-';

        const sieveEnt = applySieveHist ? applySieveHist[y] : null;
        const minOrders = (sieveEnt && Array.isArray(sieveEnt.min_orders)) ? sieveEnt.min_orders.slice() : [];
        minOrders.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
        const sieveDesc = minOrders.length
            ? minOrders.map(r => String(r.raw || `${r.expr || ''}${r.min_score || ''}`)).filter(Boolean).join('；')
            : '-';
        const sieveCmp = compareUserToApplySieve(minOrders, input);

        const sieveBadge = (st) => {
            if (st === 'pass') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-emerald-100 text-emerald-800">可能较有利</span>';
            if (st === 'fail') return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-rose-100 text-rose-800">可能偏难</span>';
            return '<span class="inline-block px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-800">不确定</span>';
        };

        return `
            <div class="border rounded p-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="font-medium">${escapeHtml(y)} 学年</div>
                    <div class="text-xs text-gray-500">个申最低分发: ${escapeHtml(applyMin)}</div>
                </div>
                <div class="mt-2 text-sm text-gray-700"><span class="font-medium">一轮边界：</span>${escapeHtml(boundaryDesc(r1))}</div>
                <div class="mt-1 text-sm text-gray-700"><span class="font-medium">二轮边界：</span>${escapeHtml(boundaryDesc(r2))}</div>
                <div class="mt-2 text-sm text-gray-700"><span class="font-medium">个申筛选最低级分：</span>${escapeHtml(sieveDesc)}</div>
                <div class="mt-2 text-xs">${badge(c1.status)} <span class="text-gray-400">一轮</span> <span class="text-gray-500 ml-2">${escapeHtml(c1.reason || '')}</span></div>
                <div class="mt-1 text-xs">${badge(c2.status)} <span class="text-gray-400">二轮</span> <span class="text-gray-500 ml-2">${escapeHtml(c2.reason || '')}</span></div>
                <div class="mt-1 text-xs">${sieveBadge(sieveCmp.status)} <span class="text-gray-400">个申</span> <span class="text-gray-500 ml-2">${escapeHtml(sieveCmp.reason || '')}</span></div>
            </div>
        `;
    }).join('');

    const starYear = DATASET.star_year;
    const applyYear = DATASET.apply_year;
    const starSys = DATASET.star_sys_dir;
    const applySys = DATASET.apply_sys_dir;
    const starUrl = (starSys && starYear) ? `https://www.cac.edu.tw/star${starYear}/system/${starSys}/html/${starYear}_${code}.htm?v=1.0` : `https://www.cac.edu.tw/star${starYear}/query.php`;
    const applyUrl = (applySys && applyYear) ? `https://www.cac.edu.tw/apply${applyYear}/system/${applySys}/html/${applyYear}_${code}2.htm?v=1.0` : `https://www.cac.edu.tw/apply${applyYear}/query.php`;

    const html = `
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-sm">
                <a class="text-blue-600 hover:underline" href="${escapeHtml(starUrl)}" target="_blank" rel="noopener noreferrer">打开繁星分则</a>
                <span class="mx-2 text-gray-300">|</span>
                <a class="text-blue-600 hover:underline" href="${escapeHtml(applyUrl)}" target="_blank" rel="noopener noreferrer">打开个申分则</a>
            </div>
            <div class="text-xs text-gray-500">数据源: CAC（繁星历史PDF + 个申历史分发标准）</div>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="border rounded p-3">
                <div class="font-medium">繁星检定（115）</div>
                <div class="text-sm text-gray-700 mt-1">${escapeHtml(starReq)}</div>
            </div>
            <div class="border rounded p-3">
                <div class="font-medium">个申检定（115）</div>
                <div class="text-sm text-gray-700 mt-1">${escapeHtml(applyReq)}</div>
            </div>
        </div>

        <div class="mt-4">
            <div class="font-medium">比序项（用户值）</div>
            <div class="mt-2 overflow-x-auto">
                <table class="w-full text-sm border">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="border px-2 py-1 text-left">比序项</th>
                            <th class="border px-2 py-1 text-left">用户值</th>
                        </tr>
                    </thead>
                    <tbody>${userLines}</tbody>
                </table>
            </div>
        </div>

        <div class="mt-4">
            <div class="font-medium">近三年边界对照（繁星）</div>
            <div class="mt-2 grid grid-cols-1 gap-3">${yearBlocks}</div>
        </div>
    `;

    setHtml(elements.modalContent, html);
    elements.modal.classList.remove('hidden');
}

function closeModal() {
    elements.modal.classList.add('hidden');
    setHtml(elements.modalContent, '');
}

async function init() {
    initLangSwitch();
    applyLangToStaticDom();
    fillSelectOptions();

    const saved = loadInputState();
    if (saved) applyInputToUI(saved);

    if (elements.loadIndicator) elements.loadIndicator.classList.remove('hidden');
    try {
        const resp = await fetch('/api/tw-star-dataset', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        DATASET = await resp.json();
    } catch (e) {
        console.error('dataset load failed', e);
        setHtml(elements.body, '<tr><td colspan="6" class="px-4 py-10 text-center text-red-600">加载数据失败：请先运行 backend/tw_star_apply_dataset.py 生成数据集</td></tr>');
        return;
    } finally {
        if (elements.loadIndicator) elements.loadIndicator.classList.add('hidden');
    }

    // Build derived UI helpers
    SCHOOL_RANK = computeSchoolRankMap(DATASET.programs);
    fillSchoolOptions();
    if (saved) applyInputToUI(saved);

    // wire events
    const rerender = () => render();
    [...Object.values(elements.scores), ...Object.values(elements.stds)].forEach(el => {
        if (!el) return;
        el.addEventListener('change', rerender);
    });
    Object.values(elements.pcts).forEach(el => {
        if (!el) return;
        el.addEventListener('input', rerender);
    });
    if (elements.filterSchool) elements.filterSchool.addEventListener('change', rerender);
    if (elements.filterBucket) elements.filterBucket.addEventListener('change', rerender);
    if (elements.filterGroupsWrap) {
        elements.filterGroupsWrap.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
            cb.addEventListener('change', rerender);
        });
    }
    if (elements.sortBy) elements.sortBy.addEventListener('change', rerender);
    if (elements.filterSearch) elements.filterSearch.addEventListener('input', rerender);

    if (elements.btnReset) {
        elements.btnReset.addEventListener('click', () => {
            Object.values(elements.scores).forEach(el => { if (el) el.value = ''; });
            Object.values(elements.stds).forEach(el => { if (el) el.value = ''; });
            Object.values(elements.pcts).forEach(el => { if (el) el.value = ''; });
            if (elements.filterSchool) elements.filterSchool.value = '';
            if (elements.filterBucket) elements.filterBucket.value = 'all';
            if (elements.filterGroupsWrap) {
                elements.filterGroupsWrap.querySelectorAll('input[type="checkbox"][value]').forEach(cb => {
                    cb.checked = true;
                });
            }
            if (elements.sortBy) elements.sortBy.value = 'schoolBest';
            if (elements.filterSearch) elements.filterSearch.value = '';
            try { localStorage.removeItem(STORAGE_KEY_TW_INPUT); } catch (e) { /* ignore */ }
            render();
        });
    }

    elements.body.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-code]');
        if (!tr) return;
        openModal(tr.dataset.code);
    });
    if (elements.cards) {
        elements.cards.addEventListener('click', (e) => {
            const card = e.target.closest('[data-code]');
            if (!card) return;
            openModal(card.dataset.code);
        });
    }

    if (elements.btnCloseModal) elements.btnCloseModal.addEventListener('click', closeModal);
    if (elements.modalBackdrop) elements.modalBackdrop.addEventListener('click', closeModal);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !elements.modal.classList.contains('hidden')) closeModal();
    });
    window.addEventListener('resize', render);

    render();
}

init();
