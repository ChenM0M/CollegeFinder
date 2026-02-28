// CollegeFinder Frontend App
// 自动检测API地址：优先同源 /api，失败则探测本地端口
const UI_VERSION = '2026-02-26-4';
let API_BASE = '/api';

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
    // 如果是通过后端同源提供的页面，/api 一定可用
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

// State
let schools = [];
let results = {};
let selectedSchools = new Set();
let currentSchool = null;
let statusPollInterval = null;

// School list render cache (to avoid full re-render on filter changes)
let schoolItemEls = new Map();
let schoolListBound = false;
let schoolListEmptyEl = null;
let filterApplyRaf = null;
let searchDebounceTimer = null;

// DOM Elements
const elements = {
    btnRefreshSchools: document.getElementById('btn-refresh-schools'),
    btnSyncLabels: document.getElementById('btn-sync-labels'),
    btnStartAll: document.getElementById('btn-start-all'),
    btnStartSelected: document.getElementById('btn-start-selected'),
    btnStop: document.getElementById('btn-stop'),
    btnExport: document.getElementById('btn-export'),
    btnRetryFailed: document.getElementById('btn-retry-failed'),
    chkForceRefresh: document.getElementById('chk-force-refresh'),
    chkSelectAll: document.getElementById('chk-select-all'),
    progressSection: document.getElementById('progress-section'),
    progressText: document.getElementById('progress-text'),
    progressBar: document.getElementById('progress-bar'),
    statCompleted: document.getElementById('stat-completed'),
    statFailed: document.getElementById('stat-failed'),
    filterArea: document.getElementById('filter-area'),
    filterType: document.getElementById('filter-type'),
    filterTaiwan: document.getElementById('filter-taiwan'),
    filterStatus: document.getElementById('filter-status'),
    filterSearch: document.getElementById('filter-search'),
    schoolList: document.getElementById('school-list'),
    schoolCount: document.getElementById('school-count'),
    resultDetail: document.getElementById('result-detail'),
    resultsTableBody: document.getElementById('results-table-body')
};

// API Functions
async function fetchSchools() {
    try {
        const resp = await fetch(noCacheUrl(`${API_BASE}/schools`), { cache: 'no-store' });
        const data = await resp.json();
        schools = data.schools;
        populateAreaFilter();
        renderSchoolListFull();
        return schools;
    } catch (e) {
        alert('获取学校列表失败: ' + e.message);
    }
}

async function fetchResults() {
    try {
        const resp = await fetch(noCacheUrl(`${API_BASE}/results`), { cache: 'no-store' });
        const data = await resp.json();
        results = data.schools || {};
        updateSchoolListFromResults();
        scheduleApplySchoolFilters();
        renderResultsTable();
        return results;
    } catch (e) {
        console.error('获取结果失败:', e);
    }
}

async function fetchStatus() {
    try {
        const resp = await fetch(noCacheUrl(`${API_BASE}/status`), { cache: 'no-store' });
        return await resp.json();
    } catch (e) {
        console.error('获取状态失败:', e);
        return null;
    }
}

async function syncLabelsOnline() {
    try {
        const resp = await fetch(`${API_BASE}/sync-labels`, { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) {
            throw new Error(data.detail || '同步失败');
        }

        await fetchSchools();
        await fetchResults();

        const tierStats = data?.schools_stats?.tier_stats || {};
        const taiwanCount = data?.schools_stats?.taiwan_recognized;
        alert(
            `标签同步完成\n` +
            `985: ${tierStats['985'] || 0}\n` +
            `211: ${tierStats['211'] || 0}\n` +
            `双一流: ${tierStats['双一流'] || 0}\n` +
            `非双一流: ${tierStats['非双一流'] || 0}\n` +
            `台湾承认: ${taiwanCount ?? '-'} 所`
        );
    } catch (e) {
        alert('联网同步标签失败: ' + e.message);
    }
}

async function startTask(schoolIds = null, forceRefresh = false) {
    try {
        const resp = await fetch(`${API_BASE}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                school_ids: schoolIds,
                use_search_fallback: true,
                force_refresh: forceRefresh
            })
        });
        const data = await resp.json();
        if (resp.ok) {
            startStatusPolling();
        } else {
            alert(data.detail || '启动失败');
        }
    } catch (e) {
        alert('启动任务失败: ' + e.message);
    }
}

async function stopTask() {
    try {
        await fetch(`${API_BASE}/stop`, { method: 'POST' });
    } catch (e) {
        console.error('停止任务失败:', e);
    }
}

async function processSchool(schoolId) {
    try {
        const resp = await fetch(`${API_BASE}/process/${schoolId}`, { method: 'POST' });
        const data = await resp.json();
        results[schoolId] = data;
        updateSchoolListItem(String(schoolId));
        scheduleApplySchoolFilters();
        renderResultsTable();
        if (currentSchool && currentSchool.id == schoolId) {
            showSchoolDetail(currentSchool);
        }
        return data;
    } catch (e) {
        alert('处理失败: ' + e.message);
    }
}

async function retryFailedSchools() {
    // 收集所有 failed 和 not_found 的学校ID
    const retryIds = [];
    for (const [sid, r] of Object.entries(results)) {
        if (r.status === 'failed' || r.status === 'not_found') {
            retryIds.push(sid);
        }
    }
    if (retryIds.length === 0) {
        alert('没有需要重试的学校');
        return;
    }
    if (confirm(`将重新提取 ${retryIds.length} 所学校（${Object.values(results).filter(r => r.status === 'failed').length} 所失败 + ${Object.values(results).filter(r => r.status === 'not_found').length} 所未找到），确认？`)) {
        await startTask(retryIds, true);
    }
}

async function exportResults() {
    try {
        const resp = await fetch(`${API_BASE}/export`);
        const data = await resp.json();

        // 转换为 CSV — 使用新的统一表格格式
        const headers = ['学校', '地区', '类别', '台湾承认', '适用类别', '国文', '英文', '数学A', '数学B', '社会', '自然', '其他条件', '报名截止', '信心度', '来源'];
        const rows = [];

        data.data.forEach(item => {
            const req = item.general_requirements || {};
            const deptReqs = item.department_requirements || [];

            if (deptReqs.length > 0) {
                // 有分专业要求：每个专业一行
                deptReqs.forEach(dept => {
                    const subj = dept.subjects || {};
                    rows.push([
                        item.school_name,
                        item.area,
                        item.tier || '非双一流',
                        item.taiwan_recognized ? '是' : '否',
                        dept.department || '全部',
                        formatReq(subj.chinese || req.chinese),
                        formatReq(subj.english || req.english),
                        formatReq(subj.math_a || req.math_a),
                        formatReq(subj.math_b || req.math_b),
                        formatReq(subj.social || req.social),
                        formatReq(subj.science || req.science),
                        [dept.notes, ...(item.other_conditions || [])].filter(Boolean).join('; '),
                        item.application_deadline || '',
                        item.confidence || '',
                        item.source_url || ''
                    ]);
                });
            } else {
                // 仅有基本要求：一行
                rows.push([
                    item.school_name,
                    item.area,
                    item.tier || '非双一流',
                    item.taiwan_recognized ? '是' : '否',
                    '全部',
                    formatReq(req.chinese),
                    formatReq(req.english),
                    formatReq(req.math_a),
                    formatReq(req.math_b),
                    formatReq(req.social),
                    formatReq(req.science),
                    (item.other_conditions || []).join('; '),
                    item.application_deadline || '',
                    item.confidence || '',
                    item.source_url || ''
                ]);
            }
        });

        const csv = [headers, ...rows].map(row => row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n');

        // Download
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `college_requirements_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('导出失败: ' + e.message);
    }
}

function formatReq(req) {
    if (!req) return '-';
    let s = req.standard || '';
    if (req.min_score) s += `(${req.min_score}级)`;
    return s || '-';
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

// Status Polling
function startStatusPolling() {
    elements.progressSection.classList.remove('hidden');
    elements.btnStop.disabled = false;
    elements.btnSyncLabels.disabled = true;
    elements.btnStartAll.disabled = true;
    elements.btnStartSelected.disabled = true;
    elements.btnRetryFailed.disabled = true;

    statusPollInterval = setInterval(async () => {
        const status = await fetchStatus();
        if (!status) return;

        updateProgress(status);

        if (!status.running) {
            stopStatusPolling();
            await fetchResults();
        }
    }, 2000);
}

function stopStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
    }
    elements.progressSection.classList.add('hidden');
    elements.btnStop.disabled = true;
    elements.btnSyncLabels.disabled = false;
    elements.btnStartAll.disabled = false;
    elements.btnStartSelected.disabled = false;
    elements.btnRetryFailed.disabled = false;
}

function updateProgress(status) {
    const percent = status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressText.textContent = status.current_school
        ? `正在处理: ${status.current_school} (${status.progress}/${status.total})`
        : `进度: ${status.progress}/${status.total}`;
    elements.statCompleted.textContent = status.completed.length;
    elements.statFailed.textContent = status.failed.length;
}

// UI Functions
function populateAreaFilter() {
    const areas = [...new Set(schools.map(s => s.area))].sort();
    elements.filterArea.innerHTML = '<option value="">全部地区</option>' +
        areas.map(a => `<option value="${a}">${a}</option>`).join('');
}

function getFilteredSchools() {
    const area = elements.filterArea.value;
    const type = elements.filterType.value;  // 现在是 tier 值: 985/211/双一流/非双一流
    const taiwan = elements.filterTaiwan.value;
    const status = elements.filterStatus.value;
    const search = elements.filterSearch.value.toLowerCase();

    return schools.filter(s => {
        if (area && s.area !== area) return false;
        // type 筛选现在直接匹配 tier 字段
        if (type && s.tier !== type) return false;
        if (taiwan === 'yes' && !s.taiwan_recognized) return false;
        if (taiwan === 'no' && s.taiwan_recognized) return false;
        if (search && !s.name.toLowerCase().includes(search)) return false;

        const result = results[s.id];
        const schoolStatus = result ? result.status : 'pending';
        if (status && schoolStatus !== status) return false;

        return true;
    });
}

function bindSchoolListDelegation() {
    if (schoolListBound) return;
    schoolListBound = true;

    elements.schoolList.addEventListener('change', (e) => {
        const cb = e.target.closest('.school-checkbox');
        if (!cb) return;
        const id = cb.dataset.id;
        if (!id) return;

        if (cb.checked) {
            selectedSchools.add(id);
        } else {
            selectedSchools.delete(id);
        }
    });

    elements.schoolList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="process"]');
        if (btn) {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (id) processSchool(id);
            return;
        }

        // Ignore direct checkbox clicks
        if (e.target.closest('.school-checkbox')) return;

        const item = e.target.closest('.school-item');
        if (!item) return;
        const id = item.dataset.id;
        if (id) selectSchool(id);
    });
}

function renderSchoolListFull() {
    schoolItemEls = new Map();
    schoolListEmptyEl = null;

    if (!schools || schools.length === 0) {
        elements.schoolCount.textContent = '0';
        elements.schoolList.innerHTML = '<div class="p-4 text-gray-500 text-center">暂无学校数据</div>';
        return;
    }

    const itemsHtml = schools.map(school => {
        const sid = String(school.id);
        const result = results[school.id];
        const status = result ? result.status : 'pending';
        const statusClass = `status-${status}`;
        const isSelected = selectedSchools.has(sid);

        const tierBadge = `<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-700 ml-1">${school.tier || '非双一流'}</span>`;
        const typeBadge = `<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-700 ml-1">${school.type || '普通高校'}</span>`;
        const twBadge = school.taiwan_recognized
            ? '<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-green-100 text-green-700 ml-1">✅ 台湾承认</span>'
            : '<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-500 ml-1">⚪ 未承认</span>';

        return `
            <div class="school-item flex items-center gap-3 px-4 py-3 border-b hover:bg-gray-50 cursor-pointer ${statusClass}"
                 data-id="${sid}">
                <input type="checkbox" class="school-checkbox w-4 h-4" data-id="${sid}" ${isSelected ? 'checked' : ''}>
                <div class="flex-1">
                    <div class="font-medium">${school.name}
                        ${tierBadge}
                        ${typeBadge}
                        ${twBadge}
                    </div>
                    <div class="text-sm text-gray-500">${school.area}</div>
                </div>
                <button type="button" class="text-blue-500 hover:text-blue-700 text-sm" data-action="process" data-id="${sid}">
                    ${result ? '重新提取' : '提取'}
                </button>
            </div>
        `;
    }).join('') + '<div id="school-list-empty" class="p-4 text-gray-500 text-center hidden">无匹配学校</div>';

    elements.schoolList.innerHTML = itemsHtml;
    elements.schoolList.querySelectorAll('.school-item').forEach(el => {
        const id = el.dataset.id;
        if (id) schoolItemEls.set(id, el);
    });
    schoolListEmptyEl = document.getElementById('school-list-empty');

    bindSchoolListDelegation();
    scheduleApplySchoolFilters();
}

function updateSchoolListItem(schoolId) {
    const sid = String(schoolId);
    const el = schoolItemEls.get(sid);
    if (!el) return;

    const result = results[sid] || results[Number(sid)];
    const status = result ? result.status : 'pending';

    el.classList.remove('status-success', 'status-failed', 'status-pending', 'status-not_found');
    el.classList.add(`status-${status}`);

    const btn = el.querySelector('button[data-action="process"]');
    if (btn) {
        btn.textContent = result ? '重新提取' : '提取';
    }

    const cb = el.querySelector('.school-checkbox');
    if (cb) {
        cb.checked = selectedSchools.has(sid);
    }
}

function updateSchoolListFromResults() {
    if (!schools || schools.length === 0) return;
    if (!schoolItemEls || schoolItemEls.size === 0) {
        renderSchoolListFull();
        return;
    }

    for (const s of schools) {
        updateSchoolListItem(String(s.id));
    }
}

function applySchoolFilters() {
    if (!schools || schools.length === 0 || !schoolItemEls || schoolItemEls.size === 0) {
        elements.schoolCount.textContent = '0';
        return;
    }

    const area = elements.filterArea.value;
    const type = elements.filterType.value;
    const taiwan = elements.filterTaiwan.value;
    const status = elements.filterStatus.value;
    const search = (elements.filterSearch.value || '').toLowerCase();

    let visible = 0;
    for (const s of schools) {
        const sid = String(s.id);
        const el = schoolItemEls.get(sid);
        if (!el) continue;

        let ok = true;
        if (area && s.area !== area) ok = false;
        if (type && s.tier !== type) ok = false;
        if (taiwan === 'yes' && !s.taiwan_recognized) ok = false;
        if (taiwan === 'no' && s.taiwan_recognized) ok = false;
        if (search && !String(s.name || '').toLowerCase().includes(search)) ok = false;

        const r = results[sid] || results[s.id];
        const schoolStatus = r ? r.status : 'pending';
        if (status && schoolStatus !== status) ok = false;

        el.classList.toggle('hidden', !ok);
        if (ok) visible += 1;
    }

    elements.schoolCount.textContent = String(visible);
    if (schoolListEmptyEl) {
        schoolListEmptyEl.classList.toggle('hidden', visible !== 0);
    }
}

function scheduleApplySchoolFilters() {
    if (filterApplyRaf) {
        cancelAnimationFrame(filterApplyRaf);
    }
    filterApplyRaf = requestAnimationFrame(() => {
        filterApplyRaf = null;
        applySchoolFilters();
    });
}

function selectSchool(id) {
    currentSchool = schools.find(s => s.id == id);
    if (currentSchool) {
        showSchoolDetail(currentSchool);
    }
}

function showSchoolDetail(school) {
    const result = results[school.id];

    const tierBadge = `<span class="inline-block px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700 mr-1">${school.tier || '非双一流'}</span>`;
    const typeBadge = `<span class="inline-block px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-700 mr-1">${school.type || '普通高校'}</span>`;
    const twBadge = school.taiwan_recognized
        ? '<span class="inline-block px-2 py-0.5 text-xs rounded bg-green-100 text-green-700">✅ 台湾教育部承认</span>'
        : '<span class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-500">⚪ 未被台湾教育部承认</span>';

    let html = `
        <div class="mb-4">
            <h3 class="text-lg font-semibold">${school.name}</h3>
            <p class="text-sm text-gray-500">${school.area}</p>
            <p class="text-sm mt-2">
                ${tierBadge}
                ${typeBadge}
                ${twBadge}
            </p>
            ${school.zsjz_url ? `<a href="${school.zsjz_url}" target="_blank" class="text-blue-500 text-sm hover:underline">官方链接</a>` : ''}
        </div>
    `;

    if (!result) {
        html += '<div class="text-gray-500">尚未提取，点击"提取"按钮开始</div>';
    } else if (result.status === 'failed') {
        html += `<div class="text-red-500">提取失败: ${result.error || '未知错误'}</div>`;
    } else if (result.status === 'not_found') {
        html += '<div class="text-yellow-600">未找到2026年台湾学测招生信息</div>';
    } else if (result.extraction) {
        const ext = result.extraction;

        html += `
            <div class="mb-4">
                <span class="inline-block px-2 py-1 text-xs rounded ${ext.confidence === 'high' ? 'bg-green-100 text-green-800' : ext.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}">
                    信心度: ${ext.confidence || '未知'}
                </span>
                ${ext.application_deadline ? `<span class="ml-2 text-sm">报名截止: ${ext.application_deadline}</span>` : ''}
            </div>
        `;

        // 统一的需求表格：将 general_requirements 和 department_requirements 合并
        html += renderUnifiedRequirementsTable(ext);

        // Other conditions
        if (ext.other_conditions && ext.other_conditions.length > 0) {
            html += `
                <div class="mb-4">
                    <h4 class="font-medium mb-2">其他条件</h4>
                    <ul class="list-disc list-inside text-sm">
                        ${ext.other_conditions.map(c => `<li>${c}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        // Notes
        if (ext.notes) {
            html += `
                <div class="mb-4">
                    <h4 class="font-medium mb-2">备注</h4>
                    <p class="text-sm text-gray-600">${ext.notes}</p>
                </div>
            `;
        }

        // Source
        const srcUrl = extractFirstUrl(result.source_url);
        if (srcUrl) {
            html += `
                <div class="mt-4 pt-4 border-t">
                    <a href="${srcUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-500 text-sm hover:underline">查看原文</a>
                    <span class="text-xs text-gray-400 ml-2">提取于 ${result.processed_at || ''}</span>
                </div>
            `;
        }

        if (result.related_links && result.related_links.length > 0) {
            html += `
                <div class="mt-3">
                    <h4 class="font-medium mb-1">已追踪关联链接</h4>
                    <ul class="list-disc list-inside text-sm text-gray-700">
                        ${result.related_links.slice(0, 4).map(l => `<li><a class="text-blue-500 hover:underline" href="${l.url}" target="_blank">${l.text || l.url}</a></li>`).join('')}
                    </ul>
                </div>
            `;
        }
    }

    elements.resultDetail.innerHTML = html;
}

/**
 * 统一需求表格：将基本要求和分专业要求合并到一张表中。
 * - 如果没有分专业要求，显示单行基本要求
 * - 如果有分专业要求，每个专业/类别一行，列出各科目要求
 * - 如果同时有基本要求和分专业要求，基本要求作为"全部/通用"行
 */
function renderUnifiedRequirementsTable(ext) {
    const gen = ext.general_requirements || {};
    const depts = ext.department_requirements || [];
    const subjects = ['chinese', 'english', 'math_a', 'math_b', 'social', 'science'];
    const subjectNames = { chinese: '国文', english: '英文', math_a: '数学A', math_b: '数学B', social: '社会', science: '自然' };

    // 判断基本要求是否有实质内容
    const hasGeneral = subjects.some(s => {
        const v = gen[s];
        return v && (v.standard || v.min_score);
    });
    const hasDept = depts.length > 0;

    if (!hasGeneral && !hasDept) {
        return '<div class="mb-4 text-amber-700 text-sm">未提取到具体科目要求（可能在图片/附件中），请查看原文与关联链接</div>';
    }

    // 收集所有行
    const rows = [];
    if (hasGeneral) {
        rows.push({ label: hasDept ? '通用要求' : '基本要求', subjects: gen, notes: null });
    }
    depts.forEach(dept => {
        // 对于分专业要求，如果某科目为null，尝试继承基本要求
        const merged = {};
        subjects.forEach(s => {
            const deptVal = dept.subjects ? dept.subjects[s] : null;
            if (deptVal && (deptVal.standard || deptVal.min_score)) {
                merged[s] = deptVal;
            } else if (hasGeneral && gen[s] && (gen[s].standard || gen[s].min_score)) {
                merged[s] = gen[s]; // 继承基本要求
            } else {
                merged[s] = deptVal || null;
            }
        });
        rows.push({ label: dept.department, subjects: merged, notes: dept.notes });
    });

    // 检查哪些科目列有数据（至少一行有值），动态决定显示哪些列
    const activeCols = subjects.filter(s =>
        rows.some(r => r.subjects[s] && (r.subjects[s].standard || r.subjects[s].min_score))
    );

    let html = `
        <div class="mb-4">
            <h4 class="font-medium mb-2">学测科目要求</h4>
            <table class="w-full text-sm border">
                <tr class="bg-gray-50">
                    <th class="px-2 py-1 border text-left">适用类别</th>
                    ${activeCols.map(s => `<th class="px-2 py-1 border text-center">${subjectNames[s]}</th>`).join('')}
                    ${rows.some(r => r.notes) ? '<th class="px-2 py-1 border text-left">备注</th>' : ''}
                </tr>
    `;

    rows.forEach(row => {
        html += `<tr>`;
        html += `<td class="px-2 py-1 border font-medium">${row.label}</td>`;
        activeCols.forEach(s => {
            const v = row.subjects[s];
            html += `<td class="px-2 py-1 border text-center">${formatReq(v)}</td>`;
        });
        if (rows.some(r => r.notes)) {
            html += `<td class="px-2 py-1 border text-sm text-gray-600">${row.notes || ''}</td>`;
        }
        html += `</tr>`;
    });

    html += `</table></div>`;
    return html;
}

function renderSubjectRow(name, data) {
    if (!data) return `<tr><td class="px-2 py-1 border">${name}</td><td class="px-2 py-1 border text-gray-400">-</td><td class="px-2 py-1 border text-gray-400">-</td></tr>`;
    return `
        <tr>
            <td class="px-2 py-1 border">${name}</td>
            <td class="px-2 py-1 border">${data.standard || '-'}</td>
            <td class="px-2 py-1 border">${data.min_score || '-'}</td>
        </tr>
    `;
}

function renderResultsTable() {
    const successResults = Object.entries(results)
        .filter(([id, r]) => r.status === 'success' && r.extraction?.found)
        .map(([id, r]) => r);

    if (successResults.length === 0) {
        elements.resultsTableBody.innerHTML = '<tr><td colspan="13" class="px-4 py-8 text-center text-gray-500">暂无数据</td></tr>';
        return;
    }

    // 展平所有行：有分专业要求的学校每个专业一行
    const allRows = [];
    successResults.forEach(r => {
        const ext = r.extraction;
        const gen = ext.general_requirements || {};
        const depts = ext.department_requirements || [];

        const tierColors = {
            '985': 'bg-red-100 text-red-700',
            '211': 'bg-orange-100 text-orange-700',
            '双一流': 'bg-blue-100 text-blue-700',
            '非双一流': 'bg-gray-100 text-gray-600'
        };
        const tier = r.tier || '非双一流';
        const tierClass = tierColors[tier] || tierColors['非双一流'];

        if (depts.length > 0) {
            depts.forEach((dept, idx) => {
                const subj = dept.subjects || {};
                allRows.push({
                    schoolId: r.school_id,
                    schoolName: r.school_name,
                    area: r.area || '',
                    tier,
                    tierClass,
                    deptName: dept.department || '全部',
                    chinese: formatReq(subj.chinese || gen.chinese),
                    english: formatReq(subj.english || gen.english),
                    math_a: formatReq(subj.math_a || gen.math_a),
                    math_b: formatReq(subj.math_b || gen.math_b),
                    social: formatReq(subj.social || gen.social),
                    science: formatReq(subj.science || gen.science),
                    otherConditions: idx === 0 ? [...(ext.other_conditions || []).slice(0, 2), dept.notes].filter(Boolean).join('; ') : (dept.notes || ''),
                    deadline: ext.application_deadline || '',
                    confidence: ext.confidence || '?',
                    rowSpan: idx === 0 ? depts.length : 0
                });
            });
        } else {
            allRows.push({
                schoolId: r.school_id,
                schoolName: r.school_name,
                area: r.area || '',
                tier,
                tierClass,
                deptName: '全部',
                chinese: formatReq(gen.chinese),
                english: formatReq(gen.english),
                math_a: formatReq(gen.math_a),
                math_b: formatReq(gen.math_b),
                social: formatReq(gen.social),
                science: formatReq(gen.science),
                otherConditions: (ext.other_conditions || []).slice(0, 2).join('; '),
                deadline: ext.application_deadline || '',
                confidence: ext.confidence || '?',
                rowSpan: 1
            });
        }
    });

    elements.resultsTableBody.innerHTML = allRows.map(row => {
        const confClass = row.confidence === 'high' ? 'bg-green-100 text-green-800' : row.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';

        // 对于多行学校，第一行用 rowspan 合并学校名/地区/类别/截止/信心度
        let schoolCells = '';
        if (row.rowSpan >= 1) {
            const rs = row.rowSpan > 1 ? ` rowspan="${row.rowSpan}"` : '';
            schoolCells = `
                <td class="px-3 py-2 border-b font-medium"${rs}>${row.schoolName}</td>
                <td class="px-3 py-2 border-b text-sm"${rs}>${row.area}</td>
                <td class="px-3 py-2 border-b text-center"${rs}><span class="inline-block px-1.5 py-0.5 text-xs rounded ${row.tierClass}">${row.tier}</span></td>
            `;
        }

        let tailCells = '';
        if (row.rowSpan >= 1) {
            const rs = row.rowSpan > 1 ? ` rowspan="${row.rowSpan}"` : '';
            tailCells = `
                <td class="px-3 py-2 border-b text-center text-sm"${rs}>${row.deadline}</td>
                <td class="px-3 py-2 border-b text-center"${rs}>
                    <span class="inline-block px-2 py-0.5 text-xs rounded ${confClass}">${row.confidence}</span>
                </td>
            `;
        }

        return `
            <tr class="hover:bg-gray-50 cursor-pointer" onclick="selectSchool('${row.schoolId}')">
                ${schoolCells}
                <td class="px-3 py-2 border-b text-center text-sm text-gray-600">${row.deptName}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.chinese}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.english}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.math_a}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.math_b}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.social}</td>
                <td class="px-3 py-2 border-b text-center text-sm">${row.science}</td>
                <td class="px-3 py-2 border-b text-sm">${row.otherConditions}</td>
                ${tailCells}
            </tr>
        `;
    }).join('');
}

// Event Listeners
elements.btnRefreshSchools.addEventListener('click', async () => {
    elements.btnRefreshSchools.disabled = true;
    elements.btnRefreshSchools.textContent = '加载中...';
    await fetchSchools();
    await fetchResults();
    elements.btnRefreshSchools.disabled = false;
    elements.btnRefreshSchools.textContent = '刷新学校列表';
});

elements.btnSyncLabels.addEventListener('click', async () => {
    if (!confirm('将联网核验并更新学校类别与台湾承认标签，是否继续？')) {
        return;
    }
    const oldText = elements.btnSyncLabels.textContent;
    elements.btnSyncLabels.disabled = true;
    elements.btnSyncLabels.textContent = '同步中...';
    await syncLabelsOnline();
    elements.btnSyncLabels.disabled = false;
    elements.btnSyncLabels.textContent = oldText;
});

elements.btnStartAll.addEventListener('click', () => {
    if (confirm('确定要开始提取所有学校的信息吗？这可能需要较长时间。')) {
        startTask(null, elements.chkForceRefresh.checked);
    }
});

elements.btnStartSelected.addEventListener('click', () => {
    const ids = Array.from(selectedSchools);
    if (ids.length === 0) {
        alert('请先选择要提取的学校');
        return;
    }
    startTask(ids, elements.chkForceRefresh.checked);
});

elements.btnStop.addEventListener('click', () => {
    stopTask();
    stopStatusPolling();
});

elements.btnExport.addEventListener('click', exportResults);
elements.btnRetryFailed.addEventListener('click', retryFailedSchools);

elements.chkSelectAll.addEventListener('change', (e) => {
    const filtered = getFilteredSchools();
    if (e.target.checked) {
        filtered.forEach(s => selectedSchools.add(String(s.id)));
    } else {
        filtered.forEach(s => selectedSchools.delete(String(s.id)));
    }

    // Sync checkbox UI without full re-render
    filtered.forEach(s => {
        const sid = String(s.id);
        const el = schoolItemEls.get(sid);
        const cb = el ? el.querySelector('.school-checkbox') : null;
        if (cb) cb.checked = e.target.checked;
    });
});

// Filter events — 注意：不再有 filterTier，已合并到 filterType
[elements.filterArea, elements.filterType, elements.filterTaiwan, elements.filterStatus].forEach(el => {
    el.addEventListener('change', () => {
        // Coalesce rapid changes to keep UI smooth
        scheduleApplySchoolFilters();
    });
});
elements.filterSearch.addEventListener('input', () => {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        scheduleApplySchoolFilters();
    }, 120);
});

// Initialize
(async function init() {
    console.log(`[CollegeFinder] UI ${UI_VERSION} initializing...`);
    API_BASE = await detectApiBase();

    // Check if there's a running task
    const status = await fetchStatus();
    if (status && status.running) {
        startStatusPolling();
    }

    // Try to load cached data
    await fetchSchools();
    await fetchResults();
})();
