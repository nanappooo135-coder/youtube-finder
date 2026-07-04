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
        + '.pr-thumb{width:150px;height:84px;border-radius:6px;flex-shrink:0;object-fit:cover;cursor:pointer;background:#f1f3f5;}'
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
        + '        <option value="econ" selected>경제 냄새만</option>'
        + '        <option value="all">전체 뉴스</option>'
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

    // 연예·스포츠 상시 차단 (전체 모드에서도) — 경제 채널 소재 아님
    var BLOCK_HINTS = ['야구', '축구', '농구', '배구', '골프', '테니스', '수영', '육상', 'KBO', 'MLB', 'NBA', 'EPL', 'UFC',
        '올림픽', '월드컵', '챔피언스리그', 'K리그', '프로야구', '국가대표팀', '하이라이트', '선발라인업', '감독 선임',
        '손흥민', '이강인', '김민재', '김하성', '경기 결과', '결승전', '준결승',
        'H.L', '홈런', '이닝', '역전승', '끝내기', '결승골', '득점', '연승', '연패 탈출',
        '아이돌', '컴백', '뮤직비디오', '뮤비', 'MV', '신곡', '음원', '콘서트', '팬미팅', '팬덤',
        '드라마', '예능', '배우', '여배우', '걸그룹', '보이그룹', '열애', '결별', '전 연인',
        '영화 개봉', '시사회', 'OST', '시청률', '넷플릭스 공개'];

    function prIsBlocked(title) {
        var t = String(title || '');
        for (var i = 0; i < BLOCK_HINTS.length; i++) {
            if (t.indexOf(BLOCK_HINTS[i]) !== -1) return true;
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
            if (prIsBlocked(v.title)) return false; // 연예·스포츠는 모드 무관 상시 제외
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
                    + '<img class="pr-thumb" src="' + (v.thumb || '') + '" loading="lazy" onclick="window.open(\'' + videoUrl + '\',\'_blank\')" alt="">'
                    + '<div style="flex:1;min-width:0;">'
                    + '<div class="pr-title" onclick="window.open(\'' + videoUrl + '\',\'_blank\')">' + prVphBadge(v.vph) + ' ' + v.title + '</div>'
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


// ============================================================
// 🧭 검증된 동선 (에버그린 재활용) — 뉴스 조용한 날의 안전 타율
// ============================================================
// 오래됐지만(6개월+) 큰 조회수가 검증된 주제 = 시청 수요가 시간을 타지 않는 소재.
// search.list(publishedBefore) 1회 ≈ 102 units.
(function () {
    'use strict';

    var EG_HTML = ''
        + '<div class="section" id="egSection">'
        + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
        + '    <span>🧭 검증된 동선 — 에버그린 재활용</span>'
        + '    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
        + '      <select id="egAge" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
        + '        <option value="6" selected>6개월+ 지난 것</option>'
        + '        <option value="12">1년+ 지난 것</option>'
        + '        <option value="24">2년+ 지난 것</option>'
        + '      </select>'
        + '      <select id="egMinViews" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
        + '        <option value="100000">10만뷰+</option>'
        + '        <option value="500000" selected>50만뷰+</option>'
        + '        <option value="1000000">100만뷰+</option>'
        + '      </select>'
        + '      <button id="egSearchBtn" onclick="runEvergreen()" style="padding:6px 16px;background:#5f3dc4;color:white;border:none;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">🧭 발굴</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="section-content">'
        + '    <p style="font-size:0.85rem;color:#888;margin-bottom:10px;">'
        + '      오래됐지만 크게 터진 <b>검증된 주제</b>를 찾아 재해석 기회를 봅니다 — 뉴스가 조용한 날의 안전 타율. 발굴 1회 ≈ 102 units.'
        + '    </p>'
        + '    <div style="display:flex;gap:8px;margin-bottom:8px;">'
        + '      <input type="text" id="egKeyword" placeholder="소재 키워드 (예: 몰락, 파산, 반도체 전쟁)" style="flex:1;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.9rem;" onkeydown="if(event.key===&quot;Enter&quot;)runEvergreen()">'
        + '    </div>'
        + '    <div id="egChips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;"></div>'
        + '    <div id="egStatus" style="font-size:0.85rem;color:#5f3dc4;font-weight:600;margin-bottom:8px;"></div>'
        + '    <div id="egError" style="display:none;padding:14px;background:#fff5f5;border:1px solid #ffe0e0;border-radius:10px;color:#dc3545;font-size:0.9rem;margin-bottom:8px;"></div>'
        + '    <div id="egList"></div>'
        + '    <p id="egTime" style="font-size:0.8rem;color:#aaa;margin-top:8px;text-align:right;"></p>'
        + '  </div>'
        + '</div>';

    var EG_CHIPS = ['기업 몰락', '파산', '반도체 전쟁', '부동산 붕괴', '환율 위기', '재벌 비화', '국민연금', '은행 부실', '일본 경제', '중국 경제'];

    window.runEvergreen = async function () {
        var btn = document.getElementById('egSearchBtn');
        var statusEl = document.getElementById('egStatus');
        var errorEl = document.getElementById('egError');
        var listEl = document.getElementById('egList');
        var timeEl = document.getElementById('egTime');
        errorEl.style.display = 'none';

        var kw = (document.getElementById('egKeyword').value || '').trim();
        if (!kw) { errorEl.style.display = ''; errorEl.textContent = '소재 키워드를 입력하거나 아래 칩을 눌러주세요.'; return; }
        var allKeys = (typeof loadApiKeys === 'function' ? loadApiKeys() : []).filter(Boolean);
        if (!allKeys.length) { errorEl.style.display = ''; errorEl.textContent = 'YouTube API 키가 없어요. 주제찾기 탭에서 먼저 등록해주세요.'; return; }

        var ageMonths = parseInt(document.getElementById('egAge').value);
        var minViews = parseInt(document.getElementById('egMinViews').value);
        var before = new Date(); before.setMonth(before.getMonth() - ageMonths);

        btn.disabled = true; btn.textContent = '발굴 중...';
        listEl.innerHTML = '';
        statusEl.textContent = '오래된 대박 영상 검색 중...';
        try {
            var sr = await fetchYouTubeAPI('search', {
                part: 'snippet', q: kw, type: 'video',
                regionCode: 'KR', relevanceLanguage: 'ko',
                publishedBefore: before.toISOString(),
                order: 'viewCount', maxResults: 50
            });
            var ids = (sr.items || []).map(function (it) { return it.id && it.id.videoId; }).filter(Boolean);
            if (!ids.length) { statusEl.textContent = ''; listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">결과가 없어요. 키워드를 바꿔보세요.</p>'; return; }

            statusEl.textContent = '통계 수집 중...';
            var vr = await fetchYouTubeAPI('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') });
            var vids = [];
            var chIds = {};
            (vr.items || []).forEach(function (v) {
                var views = parseInt((v.statistics || {}).viewCount || '0');
                var dur = parseIsoDuration(v.contentDetails && v.contentDetails.duration);
                var isNews = /뉴스|news/i.test(v.snippet.channelTitle || '');
                if (views >= minViews && dur >= 180 && dur < 3 * 3600 && !isNews) {
                    chIds[v.snippet.channelId] = true;
                    vids.push({
                        id: v.id, title: v.snippet.title,
                        channelId: v.snippet.channelId, channelTitle: v.snippet.channelTitle,
                        thumb: (v.snippet.thumbnails || {}).medium ? v.snippet.thumbnails.medium.url : '',
                        publishedAt: v.snippet.publishedAt, viewCount: views, duration: dur
                    });
                }
            });
            var subs = {};
            var chList = Object.keys(chIds);
            if (chList.length) {
                var cr = await fetchYouTubeAPI('channels', { part: 'statistics', id: chList.slice(0, 50).join(',') });
                (cr.items || []).forEach(function (c) { subs[c.id] = parseInt((c.statistics || {}).subscriberCount || '0'); });
            }
            vids.forEach(function (v) { v.subs = subs[v.channelId] || 0; v.eff = v.subs > 0 ? v.viewCount / v.subs : 0; });
            vids.sort(function (a, b) { return b.viewCount - a.viewCount; });

            statusEl.textContent = '';
            if (!vids.length) {
                listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">조건(조회수·롱폼·뉴스 제외)에 맞는 영상이 없어요. 조회수 기준을 낮춰보세요.</p>';
            } else {
                listEl.innerHTML = vids.map(function (v) {
                    var url = 'https://www.youtube.com/watch?v=' + v.id;
                    var age = formatRelativeTime(new Date(v.publishedAt).getTime());
                    var effBadge = v.eff >= 1 ? '<span class="pr-badge pr-empty">효율 ' + v.eff.toFixed(1) + '배</span> ' : '';
                    return '<div class="pr-item">'
                        + '<img class="pr-thumb" src="' + v.thumb + '" loading="lazy" onclick="window.open(&quot;' + url + '&quot;,&quot;_blank&quot;)" alt="">'
                        + '<div style="flex:1;min-width:0;">'
                        + '<div class="pr-title" onclick="window.open(&quot;' + url + '&quot;,&quot;_blank&quot;)">' + v.title + '</div>'
                        + '<div class="pr-meta">' + v.channelTitle + (v.subs ? ' (구독 ' + formatViewCount(v.subs) + ')' : '') + ' · <b style="color:#5f3dc4;">조회 ' + formatViewCount(v.viewCount) + '</b> · ' + age + ' · ' + formatDuration(v.duration) + '</div>'
                        + '<div style="margin-top:4px;">' + effBadge + '<span style="font-size:0.78rem;color:#888;">오래됐지만 검증된 주제 — 최신 데이터·새 각도로 재해석</span></div>'
                        + '</div></div>';
                }).join('');
            }
            timeEl.textContent = '"' + kw + '" · ' + ageMonths + '개월+ 전 · ' + formatViewCount(minViews) + '뷰+ · ' + vids.length + '건 (조회수순, 뉴스채널 제외)';
        } catch (e) {
            statusEl.textContent = '';
            errorEl.style.display = ''; errorEl.textContent = '발굴 오류: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = '🧭 발굴';
        }
    };

    function setup() {
        var anchor = document.getElementById('prSection');
        if (!anchor || document.getElementById('egSection')) return;
        anchor.insertAdjacentHTML('afterend', EG_HTML);
        var chips = document.getElementById('egChips');
        chips.innerHTML = EG_CHIPS.map(function (c) {
            return '<button onclick="document.getElementById(&quot;egKeyword&quot;).value=&quot;' + c + '&quot;;runEvergreen()" style="padding:5px 12px;background:#f3f0ff;color:#5f3dc4;border:1px solid #e5dbff;border-radius:20px;font-size:0.8rem;font-weight:600;cursor:pointer;">' + c + '</button>';
        }).join('');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(setup, 0); });
    else setTimeout(setup, 0);
})();

// ============================================================
// ♻️ 시그니처 변형 양산 — 터진 제목 1개 → 패턴 10개 (Gemini)
// ============================================================
(function () {
    'use strict';

    var SV_HTML = ''
        + '<div class="section" id="svSection">'
        + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
        + '    <span>♻️ 제목 변형 양산 — 터진 제목 1개 → 10개</span>'
        + '    <button id="svBtn" onclick="runVariants()" style="padding:6px 16px;background:#e8590c;color:white;border:none;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">♻️ 10개 생성</button>'
        + '  </div>'
        + '  <div class="section-content">'
        + '    <p style="font-size:0.85rem;color:#888;margin-bottom:10px;">'
        + '      잘 터진 제목의 <b>패턴(구조·후킹 장치)</b>을 분석해 같은 공식으로 10개를 뽑습니다 — 같은 소재 각도 연타 기획용. Gemini 키 사용(기존 설정 재활용).'
        + '    </p>'
        + '    <input type="text" id="svTitle" placeholder="기준 제목 (예: 손대는 사업마다 무너졌다 — 정몽규가 거쳐간 기업들의 최후)" style="width:100%;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.9rem;margin-bottom:8px;box-sizing:border-box;">'
        + '    <input type="text" id="svTopic" placeholder="(선택) 새 소재 키워드 — 넣으면 5개는 이 소재로 변형 (예: 홍명보, 포르쉐)" style="width:100%;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.9rem;margin-bottom:8px;box-sizing:border-box;" onkeydown="if(event.key===&quot;Enter&quot;)runVariants()">'
        + '    <div id="svStatus" style="font-size:0.85rem;color:#e8590c;font-weight:600;margin-bottom:8px;"></div>'
        + '    <div id="svError" style="display:none;padding:14px;background:#fff5f5;border:1px solid #ffe0e0;border-radius:10px;color:#dc3545;font-size:0.9rem;margin-bottom:8px;"></div>'
        + '    <div id="svPattern" style="display:none;padding:10px 12px;background:#fff9f5;border:1px solid #ffe8d9;border-radius:8px;font-size:0.85rem;color:#c05621;margin-bottom:8px;"></div>'
        + '    <div id="svList"></div>'
        + '  </div>'
        + '</div>';

    window.runVariants = async function () {
        var btn = document.getElementById('svBtn');
        var statusEl = document.getElementById('svStatus');
        var errorEl = document.getElementById('svError');
        var listEl = document.getElementById('svList');
        var patEl = document.getElementById('svPattern');
        errorEl.style.display = 'none'; patEl.style.display = 'none';

        var title = (document.getElementById('svTitle').value || '').trim();
        var topic = (document.getElementById('svTopic').value || '').trim();
        if (!title) { errorEl.style.display = ''; errorEl.textContent = '기준 제목을 입력해주세요.'; return; }
        if (typeof callGemini !== 'function' || typeof getGeminiKey !== 'function' || !getGeminiKey()) {
            errorEl.style.display = ''; errorEl.innerHTML = 'Gemini API 키가 없어요. <b>주제찾기 탭의 Gemini 키 설정</b>에서 먼저 등록해주세요.';
            return;
        }

        btn.disabled = true; btn.textContent = '생성 중...';
        listEl.innerHTML = ''; statusEl.textContent = '패턴 분석 + 변형 생성 중... (10~20초)';
        try {
            var mix = topic
                ? '5개는 원래 소재의 다른 각도, 5개는 새 소재 "' + topic + '"에 같은 패턴 적용'
                : '6개는 원래 소재의 다른 각도, 4개는 인접 소재로 확장';
            var prompt = '당신은 40~60대 대상 한국 경제 유튜브 채널의 20년차 카피라이터입니다.\n'
                + '기준 제목: "' + title + '"\n\n'
                + '작업:\n'
                + '1) 이 제목이 클릭을 부르는 패턴을 한 줄로 분석 (구조·후킹 장치·숫자/실명 배치).\n'
                + '2) 같은 패턴으로 제목 10개 생성 — ' + mix + '.\n'
                + '규칙: 40자 이내, 숫자·실명 우선, 물음표 남발 금지, 내용이 감당 못 할 낚시 금지, 몰락·반전·은폐 앵글 우선.\n'
                + '출력은 반드시 아래 JSON만:\n'
                + '{"pattern": "패턴 분석 한 줄", "titles": ["제목1", "...", "제목10"]}';
            var res = await callGemini(prompt, { temperature: 0.8 });
            var text = typeof res === 'string' ? res : JSON.stringify(res);
            var m = text.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('AI 응답 파싱 실패 — 다시 시도해주세요');
            var data = JSON.parse(m[0]);
            statusEl.textContent = '';
            if (data.pattern) { patEl.style.display = ''; patEl.innerHTML = '<b>패턴:</b> ' + data.pattern; }
            listEl.innerHTML = (data.titles || []).map(function (t, i) {
                var safe = String(t).replace(/"/g, '&quot;');
                return '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #eee;border-radius:8px;margin-bottom:6px;background:white;">'
                    + '<span style="color:#aaa;font-size:0.8rem;font-weight:700;flex-shrink:0;">' + (i + 1) + '</span>'
                    + '<span style="flex:1;font-size:0.92rem;font-weight:600;">' + t + '</span>'
                    + '<button data-title="' + safe + '" onclick="navigator.clipboard.writeText(this.dataset.title);this.textContent=&quot;✓ 복사됨&quot;;var b=this;setTimeout(function(){b.textContent=&quot;복사&quot;},1200)" style="padding:4px 12px;background:#f1f3f5;border:1px solid #dee2e6;border-radius:6px;font-size:0.78rem;cursor:pointer;flex-shrink:0;">복사</button>'
                    + '</div>';
            }).join('');
        } catch (e) {
            statusEl.textContent = '';
            errorEl.style.display = ''; errorEl.textContent = '생성 오류: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = '♻️ 10개 생성';
        }
    };

    function setup() {
        var anchor = document.getElementById('egSection') || document.getElementById('prSection');
        if (!anchor || document.getElementById('svSection')) return;
        anchor.insertAdjacentHTML('afterend', SV_HTML);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(setup, 10); });
    else setTimeout(setup, 10);
})();

// ============================================================
// 🪗 트렌드 탭 아코디언 — 섹션 접기/펴기로 한눈에 (UI 정리)
// ============================================================
(function () {
    'use strict';
    var STATE_KEY = 'trend_accordion_state';

    var ACC_CSS = ''
        + '#process-trend .section{border:1px solid #ececec;border-radius:14px;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.05);margin-bottom:12px;overflow:hidden;}'
        + '#process-trend .section-title{cursor:pointer;user-select:none;padding:14px 16px;margin:0;font-size:1rem;}'
        + '#process-trend .section-title:hover{background:#fafafa;}'
        + '#process-trend .acc-chev{display:inline-block;margin-right:8px;color:#adb5bd;font-size:0.8rem;transition:transform .18s;transform:rotate(90deg);}'
        + '#process-trend .acc-closed .acc-chev{transform:rotate(0deg);}'
        + '#process-trend .acc-closed > *:not(.section-title){display:none !important;}'
        + '#process-trend .section-content{padding:4px 16px 16px;}';

    function keyOf(sec, idx) {
        return sec.id || 'idx_' + idx;
    }

    function initAccordion() {
        var host = document.getElementById('process-trend');
        if (!host || host._accInit) return;
        host._accInit = true;
        var style = document.createElement('style');
        style.textContent = ACC_CSS;
        document.head.appendChild(style);

        var state = {};
        try { state = JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (e) {}

        var sections = host.querySelectorAll('.section');
        sections.forEach(function (sec, idx) {
            var title = sec.querySelector('.section-title');
            if (!title || title._accBound) return;
            title._accBound = true;
            var chev = document.createElement('span');
            chev.className = 'acc-chev';
            chev.textContent = '▶';
            title.insertBefore(chev, title.firstChild);
            var k = keyOf(sec, idx);
            // 기본: 선점 레이더만 열림. 저장된 상태가 있으면 그걸 따름.
            var open = (k in state) ? !!state[k] : (sec.id === 'prSection');
            if (!open) sec.classList.add('acc-closed');
            title.addEventListener('click', function (e) {
                if (e.target.closest('button, select, input, label, a')) return;
                sec.classList.toggle('acc-closed');
                state[k] = !sec.classList.contains('acc-closed');
                try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e2) {}
            });
        });
    }

    // 다른 IIFE들의 섹션 주입(setTimeout 0/10) 이후에 실행
    function boot() { setTimeout(initAccordion, 80); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
