// ============================================================
// 🎯 선점 레이더 v2 (뉴스 급상승 탐지) — 특종 선발주자용
// ============================================================
// 원리(사용자 아이디어): 유튜브 뉴스 채널들의 최근 클립 중 "시속(조회수÷경과시간)"이
// 급상승 중인 것 = 대중 관심의 실측값. 뉴스 클립은 뜨는데 스토리텔링 롱폼이 아직
// 없으면 그게 특종(빈 바다) — 롱폼 존재 여부는 관심 가는 항목만 "🔍 롱폼 확인"
// 버튼으로 개별 확인(그때만 101 units 소모).
//
// API 비용: 전체 스캔 ≈ 뉴스채널 14개 × (uploads 1 + videos 1) + 채널통계 1 ≈ 30 units
//           (v1의 뉴스별 일괄 search 방식 1,500 units → 50배 절감)
// ※ index.html과의 충돌 최소화를 위해 별도 파일 — index.html에는 <script src> 한 줄만.
//   전역 의존: fetchYouTubeAPI, parseIsoDuration, formatViewCount, formatRelativeTime, loadApiKeys

(function () {
    'use strict';

    var PR_CACHE_TTL = 15 * 60 * 1000; // 뉴스는 빨리 식으니 15분
    var PR_CACHE_KEY = 'pr_news_cache_v2';

    // 내장 뉴스 채널 (2026-07-04 yt-dlp로 ID 검증)
    var NEWS_CHANNELS = [
        { id: 'UCTHCOPwqNfZ0uiKOvFyhGwg', name: '연합뉴스TV' },
        { id: 'UC6kZpTl39-_SqfBrF1-N2oQ', name: '연합뉴스경제TV' },
        { id: 'UChlgI3UHCOnwUGzWzbJ3H5w', name: 'YTN' },
        { id: 'UCcQTRi69dsVYHN3exePtZ1A', name: 'KBS News' },
        { id: 'UCF4Wxdo3inmxP-Y59wXDsFw', name: 'MBC NEWS' },
        { id: 'UCkinYTS9IHqOEwR1Sze2JTw', name: 'SBS 뉴스' },
        { id: 'UCsU-I-vHLiaMfV_ceaYz5rQ', name: 'JTBC News' },
        { id: 'UCfq4V1DAuaojnr2ryvWNysw', name: '채널A 뉴스' },
        { id: 'UCWlV3Lz_55UaX4JsMj-z__Q', name: '뉴스TVCHOSUN' },
        { id: 'UCG9aFJTZ-lMCHAiO1KJsirg', name: 'MBN News' },
        { id: 'UCF8AeLlUbEpKju6v1H6p8Eg', name: '한국경제TV' },
        { id: 'UCnfwIKyFYRuqZzzKBDt6JOA', name: '매일경제TV' },
        { id: 'UCbMjg2EvXs_RUGW-KrdM3pw', name: 'SBS Biz 뉴스' },
        { id: 'UClErHbdZKUnD1NyIUeQWvuQ', name: 'MTN 머니투데이방송' }
    ];

    var PR_CSS = ''
        + '.pr-item{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #eee;border-radius:10px;margin-bottom:8px;background:white;transition:all .2s;}'
        + '.pr-item:hover{border-color:#1971c2;box-shadow:0 2px 8px rgba(25,113,194,.12);}'
        + '.pr-badge{flex-shrink:0;padding:4px 10px;border-radius:8px;font-size:0.8rem;font-weight:800;white-space:nowrap;}'
        + '.pr-hot{background:#ffe3e3;color:#c92a2a;}'
        + '.pr-warm{background:#fff3e0;color:#e8590c;}'
        + '.pr-mid{background:#e7f0fb;color:#1971c2;}'
        + '.pr-cold{background:#f1f3f5;color:#868e96;}'
        + '.pr-empty{background:#e6f7ee;color:#0ca678;}'
        + '.pr-race{background:#fff3e0;color:#e8590c;}'
        + '.pr-red{background:#ffe3e3;color:#c92a2a;}'
        + '.pr-title{font-weight:700;font-size:0.95rem;line-height:1.4;cursor:pointer;color:#222;}'
        + '.pr-title:hover{color:#1971c2;text-decoration:underline;}'
        + '.pr-meta{font-size:0.8rem;color:#888;margin-top:4px;}'
        + '.pr-comp{font-size:0.8rem;color:#666;margin-top:6px;background:#f8f9fa;border-radius:6px;padding:6px 8px;}'
        + '.pr-comp a{color:#4285f4;text-decoration:none;}'
        + '.pr-check-btn{padding:4px 10px;background:#f1f3f5;color:#495057;border:1px solid #dee2e6;border-radius:6px;font-size:0.78rem;font-weight:700;cursor:pointer;}'
        + '.pr-check-btn:hover{background:#e7f0fb;color:#1971c2;border-color:#1971c2;}';

    var PR_HTML = ''
        + '<div class="section" id="prSection">'
        + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
        + '    <span>🎯 선점 레이더 — 뉴스 급상승 (특종) <span id="prChCount" style="font-size:0.78rem;font-weight:400;color:#888;"></span></span>'
        + '    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
        + '      <select id="prPeriod" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
        + '        <option value="12">최근 12시간</option>'
        + '        <option value="24" selected>최근 24시간</option>'
        + '        <option value="48">최근 48시간</option>'
        + '      </select>'
        + '      <select id="prTopic" onchange="prApplyFilters()" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
        + '        <option value="all" selected>전체 뉴스</option>'
        + '        <option value="econ">경제 냄새만</option>'
        + '      </select>'
        + '      <label style="font-size:0.8rem;color:#555;display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="prNoShorts" checked onchange="prApplyFilters()">쇼츠 제외</label>'
        + '      <button id="prScanBtn" onclick="runPreemptRadar()" style="padding:6px 16px;background:#1971c2;color:white;border:none;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">🎯 스캔</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="section-content">'
        + '    <p style="font-size:0.85rem;color:#888;margin-bottom:12px;">'
        + '      뉴스 채널 14곳의 최근 클립을 <b>시속(조회수÷경과시간)</b> 순으로 정렬 — 지금 대중이 몰려가는 이슈의 실측값입니다.'
        + '      뉴스 클립은 뜨는데 <b>일반 유튜버의 2분+ 영상</b>(뉴스채널 제외)이 없으면 그게 특종. 관심 항목만 <b>🔍 경쟁 확인</b>을 눌러 빈 바다인지 개별 확인하세요(확인 1건 ≈ 101 units).'
        + '      전체 스캔은 ≈ 30 units라 수시로 돌려도 부담 없음 · 결과 15분 캐시.'
        + '    </p>'
        + '    <div id="prStatus" style="font-size:0.85rem;color:#1971c2;font-weight:600;margin-bottom:8px;"></div>'
        + '    <div id="prError" style="display:none;padding:16px;background:#fff5f5;border:1px solid #ffe0e0;border-radius:10px;color:#dc3545;font-size:0.9rem;line-height:1.6;margin-bottom:8px;"></div>'
        + '    <div id="prList"></div>'
        + '    <p id="prTime" style="font-size:0.8rem;color:#aaa;margin-top:8px;text-align:right;"></p>'
        + '  </div>'
        + '</div>';

    // 경제 냄새 필터 (제목 키워드 — 대략적)
    // ※ '주가'는 "교주가" 같은 오탐이 나서 제외 — 주식/증시/코스피가 커버
    var ECON_HINTS = ['경제', '금리', '환율', '물가', '주식', '증시', '코스피', '코스닥', '부동산', '아파트', '집값', '전세',
        '수출', '수입', '무역', '관세', '반도체', '삼성', '하이닉스', 'LG', '현대', '기아', '한화', 'SK', '포스코', '롯데',
        '기업', '회장', '총수', '파산', '부도', '폐업', '적자', '흑자', '매출', '영업이익', '투자', '인수', '합병',
        '비트코인', '코인', '가상자산', '연준', '달러', '엔화', '위안', '유가', '국채', '채권', '세금', '소득', '연금',
        '고용', '실업', '임금', '최저임금', '자영업', '소상공인', '대출', '금융', '은행', '보험', '카드'];

    function prIsEcon(title) {
        var t = String(title || '');
        for (var i = 0; i < ECON_HINTS.length; i++) {
            if (t.indexOf(ECON_HINTS[i]) !== -1) return true;
        }
        return false;
    }

    // 영상 제목 → 롱폼 검색어 (괄호·따옴표·말줄임 제거 후 핵심 토큰 5개)
    function prQuery(title) {
        var t = String(title || '')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/[“”"'‘’…·|↑↓#]/g, ' ')
            .replace(/[()\/]/g, ' ');
        var tokens = t.split(/\s+/).filter(function (w) {
            return w.replace(/[^0-9A-Za-z가-힣%]/g, '').length >= 2;
        });
        return tokens.slice(0, 5).join(' ');
    }

    function prRelevant(qTokens, videoTitle) {
        var vt = String(videoTitle || '');
        for (var i = 0; i < qTokens.length; i++) {
            var core = qTokens[i].replace(/[^0-9A-Za-z가-힣]/g, '');
            if (core.length >= 2 && vt.indexOf(core) !== -1) return true;
        }
        return false;
    }

    // ── 전체 스캔: 뉴스 채널 uploads → 시속 정렬 ──
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

        var hours = parseInt(document.getElementById('prPeriod').value);
        var cutoff = Date.now() - hours * 3600 * 1000;

        btn.disabled = true; btn.textContent = '스캔 중...';
        listEl.innerHTML = '';

        try {
            // 1) 채널별 최근 업로드 (채널당 1 unit, 동시 6개)
            var candIds = [];
            var done = 0;
            var idx = 0;
            async function worker() {
                while (idx < NEWS_CHANNELS.length) {
                    var i = idx++;
                    var c = NEWS_CHANNELS[i];
                    try {
                        var data = await fetchYouTubeAPI('playlistItems', {
                            part: 'contentDetails',
                            playlistId: 'UU' + c.id.slice(2),
                            maxResults: 50
                        });
                        (data.items || []).forEach(function (it) {
                            var vid = it.contentDetails && it.contentDetails.videoId;
                            var pub = it.contentDetails && it.contentDetails.videoPublishedAt;
                            if (vid && pub && new Date(pub).getTime() >= cutoff) candIds.push(vid);
                        });
                    } catch (e) { console.warn('[PreemptRadar]', c.name, e.message); }
                    done++;
                    statusEl.textContent = '뉴스 채널 스캔 중... (' + done + '/' + NEWS_CHANNELS.length + ') · 후보 ' + candIds.length + '개';
                }
            }
            var workers = [];
            for (var w = 0; w < 6; w++) workers.push(worker());
            await Promise.all(workers);

            if (!candIds.length) {
                statusEl.textContent = '';
                listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">기간 내 새 클립이 없어요. 기간을 늘려보세요.</p>';
                return;
            }

            // 2) 영상 상세 → 시속 계산
            var videos = [];
            var now = Date.now();
            for (var i = 0; i < candIds.length; i += 50) {
                var vr = await fetchYouTubeAPI('videos', {
                    part: 'snippet,statistics,contentDetails',
                    id: candIds.slice(i, i + 50).join(',')
                });
                (vr.items || []).forEach(function (v) {
                    var views = parseInt((v.statistics || {}).viewCount || '0');
                    var ageH = Math.max((now - new Date(v.snippet.publishedAt).getTime()) / 3600000, 0.5);
                    videos.push({
                        id: v.id,
                        title: v.snippet.title,
                        channelTitle: v.snippet.channelTitle,
                        thumb: (v.snippet.thumbnails || {}).medium ? v.snippet.thumbnails.medium.url : '',
                        publishedAt: v.snippet.publishedAt,
                        viewCount: views,
                        duration: parseIsoDuration(v.contentDetails && v.contentDetails.duration),
                        vph: Math.round(views / ageH) // views per hour = 시속
                    });
                });
                statusEl.textContent = '시속 계산 중... (' + Math.min(i + 50, candIds.length) + '/' + candIds.length + ')';
            }

            videos.sort(function (a, b) { return b.vph - a.vph; });
            var payload = { time: Date.now(), hours: hours, videos: videos.slice(0, 400) };
            try { localStorage.setItem(PR_CACHE_KEY, JSON.stringify(payload)); } catch (e) {}
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

    function prVphBadge(vph) {
        var cls = 'pr-cold';
        if (vph >= 10000) cls = 'pr-hot';
        else if (vph >= 3000) cls = 'pr-warm';
        else if (vph >= 500) cls = 'pr-mid';
        var label = vph >= 10000 ? '🔥 ' : '';
        return '<span class="pr-badge ' + cls + '">' + label + '시속 ' + formatViewCount(vph) + '</span>';
    }

    function prRender(payload) {
        var listEl = document.getElementById('prList');
        var timeEl = document.getElementById('prTime');
        if (!listEl || !payload || !payload.videos) return;
        var noShorts = document.getElementById('prNoShorts').checked;
        var econOnly = document.getElementById('prTopic').value === 'econ';
        var items = payload.videos.filter(function (v) {
            if (v.duration >= 3 * 3600) return false; // 라이브 특보/재방송 스트림 제외 (클립만)
            if (noShorts && v.duration < 60) return false;
            if (econOnly && !prIsEcon(v.title)) return false;
            return true;
        });
        var total = items.length;
        items = items.slice(0, 40);
        if (!items.length) {
            listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">조건에 맞는 클립이 없어요. 필터를 풀거나 기간을 늘려보세요.</p>';
        } else {
            listEl.innerHTML = items.map(function (v, i) {
                var videoUrl = 'https://www.youtube.com/watch?v=' + v.id;
                var ago = formatRelativeTime(new Date(v.publishedAt).getTime());
                return '<div class="pr-item" data-vid="' + v.id + '">'
                    + prVphBadge(v.vph)
                    + '<div style="flex:1;min-width:0;">'
                    + '<div class="pr-title" onclick="window.open(\'' + videoUrl + '\',\'_blank\')">' + v.title + '</div>'
                    + '<div class="pr-meta">' + v.channelTitle + ' · 조회 ' + formatViewCount(v.viewCount) + ' · ' + ago + ' · ' + formatDuration(v.duration) + '</div>'
                    + '<div class="pr-comp-slot" style="margin-top:6px;">'
                    + '<button class="pr-check-btn" onclick="prCheckLongform(this, \'' + v.id + '\')">🔍 경쟁 확인 — 빈 바다인가? (101u)</button>'
                    + '</div>'
                    + '</div></div>';
            }).join('');
        }
        if (timeEl && payload.time) {
            var d = new Date(payload.time);
            var stale = (Date.now() - payload.time) > PR_CACHE_TTL ? ' · 오래된 결과 — 재스캔 권장' : '';
            timeEl.textContent = '스캔: ' + d.getHours() + '시 ' + String(d.getMinutes()).padStart(2, '0') + '분 · 최근 ' + (payload.hours || '?') + '시간 · 표시 ' + items.length + '/' + total + '개 (시속순)' + stale;
        }
    }

    // ── 개별 롱폼 확인 (빈 바다 판정) — 클릭한 항목만 101 units ──
    window.prCheckLongform = async function (btnEl, videoId) {
        var payload;
        try { payload = JSON.parse(localStorage.getItem(PR_CACHE_KEY) || 'null'); } catch (e) {}
        var v = payload && payload.videos ? payload.videos.find(function (x) { return x.id === videoId; }) : null;
        if (!v) return;
        var slot = btnEl.parentElement;
        btnEl.disabled = true; btnEl.textContent = '확인 중...';
        try {
            var q = prQuery(v.title);
            var qTokens = q.split(' ');
            var publishedAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
            var sr = await fetchYouTubeAPI('search', {
                part: 'snippet', q: q, type: 'video',
                regionCode: 'KR', relevanceLanguage: 'ko',
                publishedAfter: publishedAfter,
                order: 'relevance', maxResults: 10
            });
            var ids = (sr.items || []).map(function (it) { return it.id && it.id.videoId; })
                .filter(function (id) { return id && id !== videoId; });
            var longforms = [];
            var newsIds = {};
            NEWS_CHANNELS.forEach(function (c) { newsIds[c.id] = true; });
            if (ids.length) {
                var vr = await fetchYouTubeAPI('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') });
                (vr.items || []).forEach(function (x) {
                    var dur = parseIsoDuration(x.contentDetails && x.contentDetails.duration);
                    // 경쟁 = 뉴스채널이 아닌 일반 유튜버의 2분+ 영상 (뉴스 클립끼리는 경쟁 아님)
                    var isNews = newsIds[x.snippet.channelId] || /뉴스|news/i.test(x.snippet.channelTitle || '');
                    if (dur >= 120 && !isNews && prRelevant(qTokens, x.snippet.title)) {
                        longforms.push({
                            id: x.id, title: x.snippet.title,
                            channelTitle: x.snippet.channelTitle,
                            views: parseInt((x.statistics || {}).viewCount || '0')
                        });
                    }
                });
            }
            longforms.sort(function (a, b) { return b.views - a.views; });
            var n = longforms.length;
            var badge, note;
            if (n <= 1) { badge = '<span class="pr-badge pr-empty">🟢 빈 바다 — 경쟁영상 ' + n + '개</span>'; note = '지금 만들면 선발주자입니다'; }
            else if (n <= 4) { badge = '<span class="pr-badge pr-race">🟡 경쟁 시작 — 경쟁영상 ' + n + '개</span>'; note = '서두르면 승산 있음'; }
            else { badge = '<span class="pr-badge pr-red">🔴 레드오션 — 경쟁영상 ' + n + '개+</span>'; note = '곁가지 각도를 찾으세요'; }
            var ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=CAISAhAB';
            var compHtml = '';
            if (longforms[0]) {
                compHtml = '<div class="pr-comp">최대 경쟁: <a href="https://www.youtube.com/watch?v=' + longforms[0].id + '" target="_blank">'
                    + longforms[0].title + '</a> · ' + longforms[0].channelTitle + ' · 조회 ' + formatViewCount(longforms[0].views) + '</div>';
            }
            slot.innerHTML = badge + ' <span style="font-size:0.8rem;color:#666;">' + note
                + ' · <a href="' + ytUrl + '" target="_blank" style="color:#1971c2;">유튜브 확인 →</a></span>' + compHtml;
        } catch (e) {
            btnEl.disabled = false;
            btnEl.textContent = '🔍 경쟁 확인 — 재시도 (' + e.message.slice(0, 30) + ')';
        }
    };

    window.prApplyFilters = function () {
        try {
            var c = JSON.parse(localStorage.getItem(PR_CACHE_KEY) || 'null');
            if (c && c.videos) prRender(c);
        } catch (e) {}
    };

    window.prRenderCache = window.prApplyFilters;

    function setup() {
        var host = document.getElementById('process-trend');
        if (!host || document.getElementById('prSection')) return;
        var style = document.createElement('style');
        style.textContent = PR_CSS;
        document.head.appendChild(style);
        host.insertAdjacentHTML('afterbegin', PR_HTML);
        var cnt = document.getElementById('prChCount');
        if (cnt) cnt.textContent = '(뉴스채널 ' + NEWS_CHANNELS.length + '곳)';
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
