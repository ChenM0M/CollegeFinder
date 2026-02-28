// CollegeFinder Summary Page
const UI_VERSION = '2026-02-27-1';
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
    rowCount: document.getElementById('row-count'),
    dataMeta: document.getElementById('data-meta'),
    tableBody: document.getElementById('summary-table-body'),
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
    selectEl.innerHTML = opts.map(v => {
        const label = v ? v : '未填写';
        return `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
    }).join('');
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
    elements.filterAreaLabel.textContent = n ? `已选 ${n} 项` : '全部地区';
}

function updateTierFilterLabel() {
    if (!elements.filterTierLabel) return;
    const n = selectedTiers.size;
    elements.filterTierLabel.textContent = n ? `已选 ${n} 项` : '全部类别';
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
    elements.filterAreaOptions.innerHTML = sorted.map(a => {
        const checked = selectedAreas.has(a);
        return `
            <label class="flex items-center gap-2 py-1" data-value="${escapeHtml(a)}">
                <input type="checkbox" class="w-4 h-4" data-value="${escapeHtml(a)}" ${checked ? 'checked' : ''}>
                <span>${escapeHtml(a)}</span>
            </label>
        `;
    }).join('');

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
    elements.filterTierOptions.innerHTML = tierOpts.map(t => {
        const checked = selectedTiers.has(t.value);
        return `
            <label class="flex items-center gap-2 py-1" data-value="${escapeHtml(t.value)}">
                <input type="checkbox" class="w-4 h-4" data-value="${escapeHtml(t.value)}" ${checked ? 'checked' : ''}>
                <span>${escapeHtml(t.label)}</span>
            </label>
        `;
    }).join('');

    updateTierFilterLabel();
}

async function fetchAllResults() {
    elements.loadIndicator.classList.remove('hidden');
    const oldText = elements.btnRefresh.textContent;
    elements.btnRefresh.disabled = true;
    elements.btnRefresh.textContent = '刷新中...';
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
        elements.matchStats.textContent = `加载失败：${e && e.message ? e.message : String(e)}`;
        elements.tableBody.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-red-600">加载数据失败，请检查后端是否启动</td></tr>';
    } finally {
        elements.loadIndicator.classList.add('hidden');
        elements.btnRefresh.disabled = false;
        elements.btnRefresh.textContent = oldText;
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

    if (elements.majorCount) elements.majorCount.textContent = String(all.length);
    if (elements.majorSelectedCount) elements.majorSelectedCount.textContent = String(selectedMajors.size);
    if (elements.majorNote) elements.majorNote.textContent = noteText || '';
    if (elements.btnClearMajors) elements.btnClearMajors.disabled = selectedMajors.size === 0;

    if (!elements.majorChips) return;
    if (chips.length === 0) {
        elements.majorChips.innerHTML = '<div class="text-sm text-gray-400">暂无专业数据（请在工作台勾选“强制刷新已有结果”后重跑提取以补全专业）</div>';
        return;
    }

    elements.majorChips.innerHTML = chips.map(c => {
        const selected = selectedMajors.has(c.norm);
        const base = 'text-xs px-2 py-1 rounded border';
        const cls = c.missing
            ? `${base} bg-rose-50 text-rose-800 border-rose-200`
            : selected
                ? `${base} bg-blue-600 text-white border-blue-600`
                : `${base} bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100`;
        const suffix = c.missing ? '（不在当前范围）' : '';
        return `<button type="button" class="${cls}" data-major="${escapeHtml(c.norm)}" aria-pressed="${selected ? 'true' : 'false'}">${escapeHtml(String(c.label || '') + suffix)}</button>`;
    }).join('');
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

        for (const row of g.rows) {
            let match = { status: 'n/a', fit: null, reason: null };
            if (scoreActive) {
                match = evaluateRow(row.reqs, userScores, row.choiceGroups, { includeUnknown });
            }

            row._match = match;

            if (!scoreActive) {
                rows.push(row);
                continue;
            }

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

            if (onlyEligible) {
                if (match.status === 'pass' || (includeUnknown && match.status === 'unknown')) {
                    rows.push(row);
                }
            } else {
                rows.push(row);
            }
        }

        if (rows.length === 0) continue;

        const dt = parseDeadline(g.extraction.application_deadline);
        const group = {
            ...g,
            rows: rows.slice(),
            _scoreActive: scoreActive,
            _bestFit: bestFit,
            _statusRank: scoreActive ? groupStatusRank : 0,
            _deadlineDate: dt,
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
    };
}

function render() {
    const base = applyFiltersAndMatch();

    // majors section should reflect current filters (before major selection)
    lastMajorAvailable = buildMajorOptionsFromGroups(base.groups);

    const majorRes = applyMajorFilterToGroups(base.groups);
    const groups = majorRes.groups;

    const stats = recountStats(groups, base.scoreActive);
    elements.rowCount.textContent = String(stats.totalRows);

    const last = resultsMeta.last_updated ? `数据更新时间: ${resultsMeta.last_updated}` : '';
    elements.dataMeta.textContent = last;

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

    if (!base.scoreActive) {
        elements.matchStats.textContent = `已提取学校: ${groups.length} 所；表格行数（含分专业）: ${stats.totalRows} 行。填写成绩后可筛选可报学校。`;
    } else {
        elements.matchStats.textContent = `匹配结果（当前筛选范围内）：可报 ${stats.statPass} 行 / 需核对 ${stats.statUnknown} 行 / 不符合 ${stats.statFail} 行。`;
    }

    if (groups.length === 0 || stats.totalRows === 0) {
        elements.tableBody.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-gray-500">无匹配结果</td></tr>';
        return;
    }

    visibleRowMap = new Map();

    const tierColors = {
        '985': 'bg-red-100 text-red-700',
        '211': 'bg-orange-100 text-orange-700',
        '双一流': 'bg-blue-100 text-blue-700',
        '非双一流': 'bg-gray-100 text-gray-600',
    };

    let html = '';
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
                    <td class="px-3 py-2 border-b font-medium"${rsAttr}>
                        <div class="leading-snug">
                            ${link}${matchBadge}${majorBadge}
                        </div>
                        <div class="mt-1">
                            <span class="inline-block px-2 py-0.5 text-xs rounded ${tierClass}">${escapeHtml(tier)}</span>
                            ${twBadge}
                        </div>
                    </td>
                    <td class="px-3 py-2 border-b text-sm"${rsAttr}>${escapeHtml(g.area || '')}</td>
                `;
            }

            let tailCells = '';
            if (idx === 0) {
                const rsAttr = rs > 1 ? ` rowspan="${rs}"` : '';
                tailCells = `
                    <td class="px-3 py-2 border-b text-center text-sm"${rsAttr}>${escapeHtml(deadline)}</td>
                    <td class="px-3 py-2 border-b text-center"${rsAttr}><span class="inline-block px-2 py-0.5 text-xs rounded ${confClass}">${escapeHtml(conf)}</span></td>
                `;
            }

            const other = String(row.otherText || '');
            const otherShort = other.length > 120 ? other.slice(0, 120) + '…' : other;

            html += `
                <tr class="${rowClass} cursor-pointer" data-row-key="${escapeHtml(rowKey)}">
                    ${schoolCells}
                    <td class="px-3 py-2 border-b text-center text-sm text-gray-700">${escapeHtml(row.deptName || '')}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.chinese))}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.english))}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.math_a))}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.math_b))}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.social))}</td>
                    <td class="px-3 py-2 border-b text-center text-sm">${escapeHtml(formatReq(row.reqs.science))}</td>
                    <td class="px-3 py-2 border-b text-sm text-gray-800" title="${escapeHtml(other)}">${escapeHtml(otherShort)}</td>
                    ${tailCells}
                </tr>
            `;
        });
    }

    elements.tableBody.innerHTML = html;
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

    elements.modalTitle.textContent = title;
    elements.modalSubtitle.textContent = [g.area, tier, tw, matchText, processedAt].filter(Boolean).join(' · ');

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

    elements.modalContent.innerHTML = `
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
    `;

    elements.modal.classList.remove('hidden');
}

function closeModal() {
    elements.modal.classList.add('hidden');
    elements.modalContent.innerHTML = '';
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

// Filters & score changes
[
    elements.filterTaiwan,
    elements.filterConfidence,
    elements.sortBy,
    elements.chkOnlyEligible,
    elements.chkIncludeUnknown,
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

elements.btnCloseModal.addEventListener('click', closeModal);
elements.modalBackdrop.addEventListener('click', closeModal);
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !elements.modal.classList.contains('hidden')) closeModal();
});

// Init
(async function init() {
    console.log(`[CollegeFinder] summary UI ${UI_VERSION} initializing...`);
    for (const el of Object.values(elements.scoreSelects)) {
        fillStandardOptions(el);
    }
    loadUserScoresFromStorage();
    loadSelectedMajorsFromStorage();
    initTierFilterOptions();
    API_BASE = await detectApiBase();
    await fetchAllResults();
})();
