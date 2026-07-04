// ============================================================
// 🎯 선점 레이더 (빈 바다 탐지기) — 특종 선발주자용
// ============================================================
// 핫한 뉴스마다 "최근 48시간 유튜브 롱폼이 몇 개인가"를 자동 확인:
//   🟢 0~1개 = 빈 바다(선점 기회)  🟡 2~4개 = 경쟁 시작  🔴 5개+ = 레드오션(어군탐지기 영역)
// 뉴스 소스 = news.json(이슈 레이더와 동일, GitHub Actions 자동 갱신).
// API 비용: 뉴스 1건당 search.list 100 + videos.list 1 ≈ 101 units.
//   15건 스캔 ≈ 1,515 units → 하루 5~6회 한도. 버튼 눌렀을 때만 실행, 30분 캐시.
// ※ index.html과의 충돌 최소화를 위해 별도 파일 — index.html에는 <script src> 한 줄만.
//   전역 의존: fetchYouTubeAPI, parseIsoDuration, formatViewCount, formatRelativeTime, loadApiKeys

(function () {
    'use strict';

    var PR_CACHE_TTL = 30 * 60 * 1000;
    var PR_CATS = {
        all:    '전체',
        econ:   '📊 경제 전반',
        stock:  '💹 주식/증시',
        real:   '🏢 부동산',
        global: '🌍 글로벌',
        policy: '🏛️ 금융정책',
        crypto: '🪙 암호화폐'
    };

    var PR_CSS = ''
        + '.pr-item{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #eee;border-radius:10px;margin-bottom:8px;background:white;transition:all .2s;}'
        + '.pr-item:hover{border-color:#0ca678;box-shadow:0 2px 8px rgba(12,166,120,.12);}'
        + '.pr-badge{flex-shrink:0;padding:4px 10px;border-radius:8px;font-size:0.8rem;font-weight:800;white-space:nowrap;}'
        + '.pr-empty{background:#e6f7ee;color:#0ca678;}'
        + '.pr-race{background:#fff3e0;color:#e8590c;}'
        + '.pr-red{background:#ffe3e3;color:#c92a2a;}'
        + '.pr-title{font-weight:700;font-size:0.95rem;line-height:1.4;cursor:pointer;color:#222;}'
        + '.pr-title:hover{color:#0ca678;text-decoration:underline;}'
        + '.pr-meta{font-size:0.8rem;color:#888;margin-top:4px;}'
        + '.pr-comp{font-size:0.8rem;color:#666;margin-top:4px;background:#f8f9fa;border-radius:6px;padding:6px 8px;}'
        + '.pr-comp a{color:#4285f4;text-decoration:none;}'
        + '.pr-link{font-size:0.78rem;color:#888;text-decoration:none;margin-right:10px;}'
        + '.pr-link:hover{color:#0ca678;}';

    var PR_HTML = ''
        + '<div class="section" id="prSection">'
        + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
        + '    <span>🎯 선점 레이더 — 빈 바다 탐지 (특종)</span>'
        + '    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
        + '      <select id="prCategory" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;"></select>'
        + '      <select id="prCount" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
        + '        <option value="10">뉴스 10건</option>'
        + '        <option value="15" selected>뉴스 15건</option>'
        + '        <option value="20">뉴스 20건</option>'
        + '      </select>'
        + '      <button id="prScanBtn" onclick="runPreemptRadar()" style="padding:6px 16px;background:#1971c2;color:white;border:none;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">🎯 스캔</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="section-content">'
        + '    <p style="font-size:0.85rem;color:#888;margin-bottom:12px;">'
        + '      핫한 뉴스마다 <b>최근 48시간 유튜브 롱폼 개수</b>를 자동 확인 — 뉴스는 뜨거운데 영상이 없으면 그게 특종입니다.'
        + '      <span class="pr-badge pr-empty" style="padding:2px 8px;">🟢 빈 바다 0~1개</span> 지금 만들면 선발.'
        + '      <span class="pr-badge pr-race" style="padding:2px 8px;">🟡 경쟁 시작 2~4개</span> 서두르면 승산.'
        + '      <span class="pr-badge pr-red" style="padding:2px 8px;">🔴 레드오션 5개+</span> 어군탐지기로 곁가지 선점.'
        + '      <br>스캔 1회 ≈ 뉴스 15건 × 101 units ≈ 1,500 units(하루 5~6회) · 결과 30분 캐시 · 뉴스 제목 클릭 = 유튜브 최신순 확인.'
        + '    </p>'
        + '    <div id="prStatus" style="font-size:0.85rem;color:#1971c2;font-weight:600;margin-bottom:8px;"></div>'
        + '    <div id="prError" style="display:none;padding:16px;background:#fff5f5;border:1px solid #ffe0e0;border-radius:10px;color:#dc3545;font-size:0.9rem;line-height:1.6;margin-bottom:8px;"></div>'
        + '    <div id="prList"></div>'
        + '    <p id="prTime" style="font-size:0.8rem;color:#aaa;margin-top:8px;text-align:right;"></p>'
        + '  </div>'
        + '</div>';

    function prCacheKey() {
        var cat = (document.getElementById('prCategory') || {}).value || 'all';
        return 'pr_cache_' + cat;
    }

    // 뉴스 제목 → 유튜브 검색어 (괄호·따옴표 제거 후 핵심 토큰 5개)
    function prQuery(title) {
        var t = String(title || '')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/[“”"'‘’…·|↑↓]/g, ' ')
            .replace(/[()]/g, ' ')
            .replace(/종합\s*$/, ' ');
        var tokens = t.split(/\s+/).filter(function (w) {
            return w.replace(/[^0-9A-Za-z가-힣%]/g, '').length >= 2;
        });
        return tokens.slice(0, 5).join(' ');
    }

    // 검색결과가 진짜 이 뉴스 관련인지: 검색 토큰 중 1개 이상이 영상 제목에 포함
    function prRelevant(queryTokens, videoTitle) {
        var vt = String(videoTitle || '');
        for (var i = 0; i < queryTokens.length; i++) {
            var core = queryTokens[i].replace(/[^0-9A-Za-z가-힣]/g, '');
            if (core.length >= 2 && vt.indexOf(core) !== -1) return true;
        }
        return false;
    }

    async function prLoadNews(cat, count) {
        var res = await fetch('news.json?t=' + Date.now());
        if (!res.ok) throw new Error('news.json 로드 실패 (' + res.status + ')');
        var data = await res.json();
        var cats = data.categories || {};
        var pool = [];
        var seen = new Set();
        var keys = cat === 'all' ? Object.keys(cats) : [cat];
        keys.forEach(function (k) {
            ((cats[k] || {}).news || []).forEach(function (n) {
                var sig = (n.title || '').slice(0, 30);
                if (!n.title || seen.has(sig)) return;
                seen.add(sig);
                pool.push(n);
            });
        });
        pool.sort(function (a, b) { return (b.pubTimestamp || 0) - (a.pubTimestamp || 0); });
        return pool.slice(0, count);
    }

    window.runPreemptRadar = async function () {
        var btn = document.getElementById('prScanBtn');
        var statusEl = document.getElementById('prStatus');
        var errorEl = document.getElementById('prError');
        var listEl = document.getElementById('prList');
        errorEl.style.display = 'none';

        var allKeys = (typeof loadApiKeys === 'function' ? loadApiKeys() : []).filter(Boolean);
        if (!allKeys.length) {
            errorEl.style.display = '';
            errorEl.innerHTML = 'YouTube API 키가 없어요. 주제찾기 탭의 API 키 설정에서 먼저 등록해주세요.';
            return;
        }

        var cat = document.getElementById('prCategory').value;
        var count = parseInt(document.getElementById('prCount').value);

        btn.disabled = true; btn.textContent = '스캔 중...';
        listEl.innerHTML = '';
        statusEl.textContent = '뉴스 로드 중...';

        try {
            var newsList = await prLoadNews(cat, count);
            if (!newsList.length) {
                statusEl.textContent = '';
                listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">뉴스가 없어요. 잠시 후 다시 시도해주세요.</p>';
                return;
            }

            var publishedAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
            var results = [];
            var done = 0;

            // 동시 3개 — 뉴스당 search 100u + videos 1u
            var idx = 0;
            async function worker() {
                while (idx < newsList.length) {
                    var i = idx++;
                    var n = newsList[i];
                    try {
                        var q = prQuery(n.title);
                        if (!q) { done++; continue; }
                        var qTokens = q.split(' ');
                        var sr = await fetchYouTubeAPI('search', {
                            part: 'snippet', q: q, type: 'video',
                            regionCode: 'KR', relevanceLanguage: 'ko',
                            publishedAfter: publishedAfter,
                            order: 'relevance', maxResults: 10
                        });
                        var ids = (sr.items || []).map(function (it) { return it.id && it.id.videoId; }).filter(Boolean);
                        var longforms = [];
                        if (ids.length) {
                            var vr = await fetchYouTubeAPI('videos', {
                                part: 'snippet,statistics,contentDetails', id: ids.join(',')
                            });
                            (vr.items || []).forEach(function (v) {
                                var dur = parseIsoDuration(v.contentDetails && v.contentDetails.duration);
                                if (dur >= 180 && prRelevant(qTokens, v.snippet.title)) {
                                    longforms.push({
                                        id: v.id, title: v.snippet.title,
                                        channelTitle: v.snippet.channelTitle,
                                        views: parseInt((v.statistics || {}).viewCount || '0')
                                    });
                                }
                            });
                        }
                        longforms.sort(function (a, b) { return b.views - a.views; });
                        results.push({
                            title: n.title, link: n.link, sourceName: n.sourceName,
                            pubTimestamp: n.pubTimestamp, query: q,
                            longformCount: longforms.length,
                            topComp: longforms[0] || null
                        });
                    } catch (e) {
                        console.warn('[PreemptRadar]', e.message);
                        if (/할당량/.test(e.message)) throw e;
                    }
                    done++;
                    statusEl.textContent = '유튜브 대조 중... (' + done + '/' + newsList.length + ')';
                }
            }
            var workers = [];
            for (var w = 0; w < Math.min(3, newsList.length); w++) workers.push(worker());
            await Promise.all(workers);

            var payload = { time: Date.now(), cat: cat, results: results };
            try { localStorage.setItem('pr_cache_' + cat, JSON.stringify(payload)); } catch (e) {}
            statusEl.textContent = '';
            prRender(payload);
        } catch (e) {
            statusEl.textContent = '';
            errorEl.style.display = '';
            errorEl.innerHTML = '스캔 오류: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = '🎯 스캔';
        }
    };

    function prVerdict(c) {
        if (c <= 1) return { cls: 'pr-empty', label: '🟢 빈 바다 ' + c + '개', rank: 0 };
        if (c <= 4) return { cls: 'pr-race', label: '🟡 경쟁 ' + c + '개', rank: 1 };
        return { cls: 'pr-red', label: '🔴 레드오션 ' + c + '개', rank: 2 };
    }

    function prRender(payload) {
        var listEl = document.getElementById('prList');
        var timeEl = document.getElementById('prTime');
        if (!listEl || !payload || !payload.results) return;
        var items = payload.results.slice();
        items.sort(function (a, b) {
            var ra = prVerdict(a.longformCount).rank, rb = prVerdict(b.longformCount).rank;
            if (ra !== rb) return ra - rb;
            return (b.pubTimestamp || 0) - (a.pubTimestamp || 0);
        });
        if (!items.length) {
            listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">결과가 없어요.</p>';
        } else {
            listEl.innerHTML = items.map(function (r) {
                var v = prVerdict(r.longformCount);
                var ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(r.query) + '&sp=CAISAhAB';
                var ago = (typeof formatRelativeTime === 'function' && r.pubTimestamp) ? formatRelativeTime(r.pubTimestamp) : '';
                var comp = '';
                if (r.topComp) {
                    comp = '<div class="pr-comp">최대 경쟁: <a href="https://www.youtube.com/watch?v=' + r.topComp.id + '" target="_blank">'
                        + r.topComp.title + '</a> · ' + r.topComp.channelTitle
                        + ' · 조회 ' + (typeof formatViewCount === 'function' ? formatViewCount(r.topComp.views) : r.topComp.views) + '</div>';
                } else {
                    comp = '<div class="pr-comp" style="background:#e6f7ee;color:#0ca678;font-weight:700;">경쟁 롱폼 없음 — 지금 만들면 첫 번째입니다</div>';
                }
                return '<div class="pr-item">'
                    + '<span class="pr-badge ' + v.cls + '">' + v.label + '</span>'
                    + '<div style="flex:1;min-width:0;">'
                    + '<div class="pr-title" onclick="window.open(\'' + ytUrl.replace(/'/g, "\\'") + '\',\'_blank\')">' + r.title + '</div>'
                    + '<div class="pr-meta">' + (r.sourceName || '뉴스') + (ago ? ' · ' + ago : '') + ' · 검색어: ' + r.query + '</div>'
                    + comp
                    + '<div style="margin-top:6px;"><a class="pr-link" href="' + (r.link || '#') + '" target="_blank">🔗 기사 원문</a>'
                    + '<a class="pr-link" href="' + ytUrl + '" target="_blank">▶️ 유튜브 최신순 확인</a></div>'
                    + '</div></div>';
            }).join('');
        }
        if (timeEl && payload.time) {
            var d = new Date(payload.time);
            var stale = (Date.now() - payload.time) > PR_CACHE_TTL ? ' · 오래된 결과 — 재스캔 권장' : '';
            timeEl.textContent = '스캔: ' + d.getHours() + '시 ' + String(d.getMinutes()).padStart(2, '0') + '분 · '
                + (PR_CATS[payload.cat] || payload.cat) + ' · ' + items.length + '건 (빈 바다 우선)' + stale;
        }
    }

    window.prRenderCache = function () {
        try {
            var c = JSON.parse(localStorage.getItem(prCacheKey()) || 'null');
            if (c && c.results) prRender(c);
        } catch (e) {}
    };

    function setup() {
        var host = document.getElementById('process-trend');
        if (!host || document.getElementById('prSection')) return;
        var style = document.createElement('style');
        style.textContent = PR_CSS;
        document.head.appendChild(style);
        host.insertAdjacentHTML('afterbegin', PR_HTML);
        var catSel = document.getElementById('prCategory');
        catSel.innerHTML = Object.keys(PR_CATS).map(function (k) {
            return '<option value="' + k + '">' + PR_CATS[k] + '</option>';
        }).join('');
        catSel.onchange = window.prRenderCache;
        // 트렌드 탭 진입 시 캐시 렌더 (switchProcess 몽키패치 — index.html 무수정)
        var orig = window.switchProcess;
        if (typeof orig === 'function' && !orig._prPatched) {
            var patched = function (p) {
                var r = orig.apply(this, arguments);
                try { if (p === 'trend') window.prRenderCache(); } catch (e) {}
                return r;
            };
            patched._prPatched = true;
            window.switchProcess = patched;
        }
        window.prRenderCache();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
