// ============================================================
// 🚀 트렌드 레이더 — 구글 급상승 검색어 × 경제 앵글 분석
// ============================================================
// 목적(2026-07-25): "지금 대한민국이 검색하는 키워드" 중 경제 대본으로 쓸 수 있는
// 것을 누구보다 빨리 잡는다. 데이터는 GitHub Actions(fetch_trends.py)가 10분마다
// 구글트렌드 RSS + 네이버뉴스를 수집해 trends.json으로 커밋 — 프론트는 공짜로 읽음.
//   - 검색량·급등 시작 시각·스냅샷 이력(스파크라인) = 실측
//   - 뜨는 이유 = 키워드별 최신 기사
//   - 🎬 앵글 분석(Gemini) = 왜 뜨나/적합성/대본 앵글 3개/타이밍/썸네일 문구
//   - 🔍 경쟁 확인(101u) = 유튜브 롱폼 선점 여부 (빈바다/경쟁시작/레드오션)
// ※ preempt_radar.js와 동일 패턴: index.html엔 mount div + <script src> 한 줄만.
//   전역 의존: callGemini, fetchYouTubeAPI, parseIsoDuration, formatViewCount, escapeHtml
(function () {
    'use strict';

    var TR_CACHE_TTL = 60 * 1000;          // trends.json 인메모리 캐시 60초
    var TR_ANGLE_TTL = 6 * 3600 * 1000;    // Gemini 앵글 분석 캐시 6시간
    var TR_ANGLE_KEY = 'tr_angle_cache_v1';
    var TR_FILTER_KEY = 'tr_filter_econ_v1';
    var TR_MINVOL_KEY = 'tr_filter_minvol_v1';
    var TR_MAX_CARDS = 80;                 // 렌더 상한 (전체 모드 성능 보호)

    var _data = null;
    var _fetchedAt = 0;

    var TR_CSS = ''
        + '.tr-card{border:1px solid #e9ecef;border-radius:12px;padding:14px 16px;margin-bottom:10px;background:white;transition:box-shadow .2s;}'
        + '.tr-card:hover{box-shadow:0 2px 10px rgba(0,0,0,.07);}'
        + '.tr-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
        + '.tr-rank{font-size:0.85rem;font-weight:800;color:#adb5bd;min-width:22px;}'
        + '.tr-kw{font-size:1.15rem;font-weight:800;color:#212529;cursor:pointer;}'
        + '.tr-kw:hover{color:#e8590c;text-decoration:underline;}'
        + '.tr-traffic{padding:3px 10px;border-radius:8px;background:#fff0e6;color:#e8590c;font-weight:800;font-size:0.88rem;white-space:nowrap;}'
        + '.tr-time{font-size:0.8rem;color:#868e96;white-space:nowrap;}'
        + '.tr-econ{padding:3px 9px;border-radius:8px;font-size:0.78rem;font-weight:800;white-space:nowrap;}'
        + '.tr-econ-high{background:#e6f7ee;color:#0ca678;}'
        + '.tr-econ-mid{background:#fff9db;color:#b08b00;}'
        + '.tr-econ-low{background:#f1f3f5;color:#adb5bd;}'
        + '.tr-spark{margin-left:auto;flex-shrink:0;}'
        + '.tr-hits{font-size:0.78rem;color:#0ca678;margin-top:4px;}'
        + '.tr-news{margin-top:8px;border-top:1px dashed #e9ecef;padding-top:8px;}'
        + '.tr-news-item{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:0.88rem;}'
        + '.tr-news-src{flex-shrink:0;font-size:0.75rem;font-weight:700;color:#868e96;min-width:52px;}'
        + '.tr-news-title{color:#343a40;cursor:pointer;line-height:1.45;}'
        + '.tr-news-title:hover{color:#1971c2;text-decoration:underline;}'
        + '.tr-btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;}'
        + '.tr-btn{padding:6px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;border:1px solid #dee2e6;background:#f8f9fa;color:#495057;}'
        + '.tr-btn:hover{background:#e7f0fb;border-color:#1971c2;color:#1971c2;}'
        + '.tr-btn-angle{background:#7048e8;border-color:#7048e8;color:white;}'
        + '.tr-btn-angle:hover{background:#5f3dc4;border-color:#5f3dc4;color:white;}'
        + '.tr-angle-box{margin-top:10px;padding:12px 14px;background:#f8f6ff;border:1px solid #d0bfff;border-radius:10px;font-size:0.9rem;line-height:1.7;}'
        + '.tr-angle-box h4{margin:10px 0 4px;font-size:0.95rem;color:#5f3dc4;}'
        + '.tr-angle-box h4:first-child{margin-top:0;}'
        + '.tr-comp{font-size:0.82rem;color:#666;margin-top:8px;background:#f8f9fa;border-radius:8px;padding:8px 10px;}'
        + '.tr-comp a{color:#4285f4;text-decoration:none;}'
        + '.tr-badge{display:inline-block;padding:4px 10px;border-radius:8px;font-size:0.8rem;font-weight:800;}'
        + '.tr-empty{background:#e6f7ee;color:#0ca678;}'
        + '.tr-race{background:#fff3e0;color:#e8590c;}'
        + '.tr-red{background:#ffe3e3;color:#c92a2a;}'
        + '#process-trend .tr-kw{font-size:1.3rem !important;}'
        + '#process-trend .tr-news-item{font-size:1rem !important;}'
        + '#process-trend .tr-btn{font-size:0.92rem !important;padding:7px 14px !important;}'
        + '#process-trend .tr-angle-box{font-size:1rem !important;}';

    var TR_HTML = ''
        + '<div class="section" id="trSection">'
        + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '    🚀 트렌드 레이더 — 지금 대한민국이 검색하는 것'
        + '    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
        + '      <select id="trMinVol" onchange="trApplyFilter()" style="padding:5px 8px;border:1px solid #dee2e6;border-radius:8px;font-size:0.8rem;">'
        + '        <option value="1000" selected>검색량 1천+</option>'
        + '        <option value="5000">검색량 5천+</option>'
        + '        <option value="10000">검색량 1만+</option>'
        + '        <option value="0">전체 검색량</option>'
        + '      </select>'
        + '      <label style="font-size:0.82rem;font-weight:400;display:flex;align-items:center;gap:4px;cursor:pointer;">'
        + '        <input type="checkbox" id="trEconOnly" onchange="trApplyFilter()"> 💰 경제 관련만'
        + '      </label>'
        + '      <button class="tr-btn" onclick="trendRadarLoad(true)" style="background:#e8590c;border-color:#e8590c;color:white;">새로고침</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="section-content">'
        + '    <p style="font-size:0.82rem;color:#888;margin-bottom:10px;">'
        + '      구글 급상승 검색어(KR) <b>전체 ~200개</b> × <b>구글 공식 카테고리</b>(비즈니스/금융)로 경제 판별 · <b>10분마다 서버 자동 갱신</b> ·'
        + '      그래프=검색량 스냅샷 누적(48h) · <b>키워드 클릭</b>=유튜브 최신순 검색 · 🎬 <b>앵글 분석</b>=Gemini가 뜨는 이유·대본 앵글 3개·타이밍 판정'
        + '    </p>'
        + '    <div id="trLoading" style="display:none;text-align:center;padding:20px;color:#888;"><div class="trend-spinner"></div>불러오는 중...</div>'
        + '    <div id="trError" style="display:none;padding:14px;background:#fff5f5;border:1px solid #ffe0e0;border-radius:10px;color:#dc3545;font-size:0.9rem;"></div>'
        + '    <div id="trList"></div>'
        + '    <p id="trTime" style="font-size:0.8rem;color:#aaa;margin-top:8px;text-align:right;"></p>'
        + '  </div>'
        + '</div>';

    function esc(s) {
        if (typeof escapeHtml === 'function') return escapeHtml(String(s == null ? '' : s));
        var d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }

    function fmtTraffic(n, raw) {
        if (!n) return esc(raw || '?');
        if (n >= 10000) return (n / 10000) % 1 === 0 ? (n / 10000) + '만+' : (n / 10000).toFixed(1) + '만+';
        if (n >= 1000) return (n / 1000) % 1 === 0 ? (n / 1000) + '천+' : (n / 1000).toFixed(1) + '천+';
        return n + '+';
    }

    function fmtAgo(ms) {
        if (!ms) return '';
        var h = (Date.now() - ms) / 3600000;
        if (h < 1) return Math.max(1, Math.round(h * 60)) + '분 전 급등';
        if (h < 24) return Math.round(h) + '시간 전 급등';
        return Math.round(h / 24) + '일 전 급등';
    }

    function sparkline(hist) {
        if (!hist || hist.length < 2) {
            return '<span style="font-size:0.72rem;color:#ced4da;">그래프 수집 중</span>';
        }
        var w = 90, h = 26, pad = 2;
        var vals = hist.map(function (p) { return p.v || 0; });
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        var span = (max - min) || 1;
        var pts = hist.map(function (p, i) {
            var x = pad + (w - 2 * pad) * (i / (hist.length - 1));
            var y = h - pad - (h - 2 * pad) * ((p.v - min) / span);
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        return '<svg width="' + w + '" height="' + h + '" style="display:block;">'
            + '<polyline points="' + pts + '" fill="none" stroke="#e8590c" stroke-width="2" stroke-linejoin="round"/>'
            + '</svg>';
    }

    var ECON_LABEL = { high: '💰 경제 직결', mid: '💡 경제 연관', low: '기타' };

    function render() {
        var listEl = document.getElementById('trList');
        var timeEl = document.getElementById('trTime');
        if (!listEl || !_data) return;

        var econOnly = false, minVol = 1000;
        try {
            econOnly = localStorage.getItem(TR_FILTER_KEY) !== '0';
            var mv = localStorage.getItem(TR_MINVOL_KEY);
            if (mv !== null) minVol = parseInt(mv) || 0;
        } catch (e) {}
        var cb = document.getElementById('trEconOnly');
        if (cb) cb.checked = econOnly;
        var mvEl = document.getElementById('trMinVol');
        if (mvEl) mvEl.value = String(minVol);

        var all = (_data.trends || []);
        var trends = all.filter(function (t) { return t.trafficNum >= minVol; });
        if (econOnly) trends = trends.filter(function (t) { return t.econLevel !== 'low'; });
        var totalMatched = trends.length;
        trends = trends.slice(0, TR_MAX_CARDS);

        if (!trends.length) {
            listEl.innerHTML = '<p style="color:#888;text-align:center;padding:20px;">'
                + (econOnly ? '조건에 맞는 경제 키워드가 없어요. 검색량 하한을 낮추거나 "경제 관련만"을 해제해보세요.' : '트렌드 데이터가 없어요.')
                + '</p>';
        } else {
            listEl.innerHTML = trends.map(function (t, i) {
                var idx = (_data.trends || []).indexOf(t);
                var ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t.keyword) + '&sp=CAISAhAB';
                var gtUrl = 'https://trends.google.co.kr/trends/explore?q=' + encodeURIComponent(t.keyword) + '&geo=KR&date=now%207-d';
                var news = (t.news || []).concat(t.gnews || []).slice(0, 4);
                var newsHtml = news.length
                    ? '<div class="tr-news">' + news.map(function (n) {
                        var nyt = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(n.title) + '&sp=CAISAhAB';
                        var timeStr = (n.pubTimestamp && typeof formatRelativeTime === 'function') ? formatRelativeTime(n.pubTimestamp) : '';
                        return '<div class="tr-news-item">'
                            + '<span class="tr-news-src">' + esc((n.sourceName || '뉴스').substring(0, 7)) + '</span>'
                            + '<span class="tr-news-title" onclick="window.open(\'' + nyt.replace(/'/g, "\\'") + '\',\'_blank\')" title="클릭: 유튜브에서 이 제목 검색">' + esc(n.title) + '</span>'
                            + (timeStr ? '<span style="flex-shrink:0;font-size:0.72rem;color:#adb5bd;">' + timeStr + '</span>' : '')
                            + '<a href="' + esc(n.link) + '" target="_blank" style="flex-shrink:0;font-size:0.78rem;color:#868e96;text-decoration:none;">🔗</a>'
                            + '</div>';
                    }).join('') + '</div>'
                    : '<div class="tr-news" style="font-size:0.82rem;color:#adb5bd;">관련 기사 수집 안 됨 — 키워드 클릭으로 직접 확인</div>';

                return '<div class="tr-card" data-kw="' + esc(t.keyword) + '">'
                    + '<div class="tr-head">'
                    + '<span class="tr-rank">' + (i + 1) + '</span>'
                    + '<span class="tr-kw" onclick="window.open(\'' + ytUrl.replace(/'/g, "\\'") + '\',\'_blank\')" title="유튜브 최신순 검색 (선점 확인)">' + esc(t.keyword) + '</span>'
                    + '<span class="tr-traffic">🔍 ' + fmtTraffic(t.trafficNum, t.traffic) + '</span>'
                    + '<span class="tr-econ tr-econ-' + t.econLevel + '">' + ECON_LABEL[t.econLevel] + '</span>'
                    + (t.topics && t.topics.length ? '<span style="font-size:0.75rem;color:#adb5bd;">' + esc(t.topics.join('·')) + '</span>' : '')
                    + '<span class="tr-time">' + fmtAgo(t.startedMs) + '</span>'
                    + '<span class="tr-spark">' + sparkline(t.history) + '</span>'
                    + '</div>'
                    + (t.econHits && t.econHits.length ? '<div class="tr-hits">매칭: ' + esc(t.econHits.join(' · ')) + '</div>' : '')
                    + newsHtml
                    + '<div class="tr-btns">'
                    + '<button class="tr-btn tr-btn-angle" onclick="trAngle(this,' + idx + ')">🎬 앵글 분석 (Gemini)</button>'
                    + '<button class="tr-btn" onclick="trCompete(this,' + idx + ')">🔍 경쟁 확인 (101u)</button>'
                    + '<a class="tr-btn" style="text-decoration:none;" href="' + esc(gtUrl) + '" target="_blank">📈 트렌드 그래프</a>'
                    + '</div>'
                    + '<div class="tr-angle-slot"></div>'
                    + '<div class="tr-comp-slot"></div>'
                    + '</div>';
            }).join('');
        }

        if (timeEl && _data.generated_at) {
            var d = new Date(_data.generated_at);
            var nHigh = all.filter(function (t) { return t.econLevel === 'high'; }).length;
            var nMid = all.filter(function (t) { return t.econLevel === 'mid'; }).length;
            timeEl.textContent = '표시 ' + trends.length + '개' + (totalMatched > trends.length ? ' (조건일치 ' + totalMatched + '개 중)' : '')
                + ' · 전체 ' + all.length + '개 — 💰' + nHigh + ' 💡' + nMid
                + ' · 서버 갱신: ' + d.getHours() + '시 ' + String(d.getMinutes()).padStart(2, '0') + '분 (10분마다)';
        }
    }

    window.trApplyFilter = function () {
        var cb = document.getElementById('trEconOnly');
        var mvEl = document.getElementById('trMinVol');
        try {
            localStorage.setItem(TR_FILTER_KEY, cb && cb.checked ? '1' : '0');
            if (mvEl) localStorage.setItem(TR_MINVOL_KEY, mvEl.value);
        } catch (e) {}
        render();
    };

    window.trendRadarLoad = async function (force) {
        var loadingEl = document.getElementById('trLoading');
        var errorEl = document.getElementById('trError');
        if (!loadingEl) return;
        if (!force && _data && (Date.now() - _fetchedAt) < TR_CACHE_TTL) { render(); return; }

        loadingEl.style.display = '';
        errorEl.style.display = 'none';
        try {
            var res = await fetch('trends.json' + (force ? '?t=' + Date.now() : '?v=1'));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            _data = await res.json();
            _fetchedAt = Date.now();
            loadingEl.style.display = 'none';
            render();
        } catch (e) {
            loadingEl.style.display = 'none';
            errorEl.style.display = '';
            errorEl.innerHTML = '⚠️ trends.json을 못 불러왔어요 (' + esc(e.message) + ').<br>'
                + '<small>GitHub Actions 첫 실행 전이면 10분 뒤 다시 시도해주세요.</small>';
        }
    };

    // ── 🎬 Gemini 앵글 분석 ──
    function angleCacheGet(kw) {
        try {
            var c = JSON.parse(localStorage.getItem(TR_ANGLE_KEY) || '{}');
            var e = c[kw];
            if (e && (Date.now() - e.t) < TR_ANGLE_TTL) return e.md;
        } catch (e) {}
        return null;
    }
    function angleCachePut(kw, md) {
        try {
            var c = JSON.parse(localStorage.getItem(TR_ANGLE_KEY) || '{}');
            var keys = Object.keys(c);
            if (keys.length > 40) { keys.sort(function (a, b) { return c[a].t - c[b].t; }).slice(0, 20).forEach(function (k) { delete c[k]; }); }
            c[kw] = { t: Date.now(), md: md };
            localStorage.setItem(TR_ANGLE_KEY, JSON.stringify(c));
        } catch (e) {}
    }

    function mdToHtml(md) {
        var lines = String(md || '').split('\n');
        var out = [];
        lines.forEach(function (ln) {
            var s = esc(ln.trim());
            if (!s) return;
            s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
            if (/^#{1,4}\s/.test(ln.trim())) out.push('<h4>' + s.replace(/^#+\s*/, '') + '</h4>');
            else if (/^[-·•]\s/.test(ln.trim())) out.push('<div style="padding-left:12px;">· ' + s.replace(/^[-·•]\s*/, '') + '</div>');
            else out.push('<div>' + s + '</div>');
        });
        return out.join('');
    }

    window.trAngle = async function (btnEl, idx) {
        var t = _data && _data.trends && _data.trends[idx];
        if (!t) return;
        var card = btnEl.closest('.tr-card');
        var slot = card.querySelector('.tr-angle-slot');

        var cached = angleCacheGet(t.keyword);
        if (cached && !slot.querySelector('.tr-angle-box')) {
            // 첫 클릭: 캐시 표시 (재클릭하면 캐시 무시하고 새로 분석)
            slot.innerHTML = '<div class="tr-angle-box">' + mdToHtml(cached)
                + '<div style="margin-top:8px;font-size:0.75rem;color:#adb5bd;">캐시된 분석 · 다시 분석하려면 버튼 재클릭</div></div>';
            return;
        }

        if (typeof callGemini !== 'function') {
            alert('Gemini API를 사용할 수 없어요. 주제찾기 탭에서 Gemini 키를 먼저 등록해주세요.');
            return;
        }

        var news = (t.news || []).concat(t.gnews || []).slice(0, 6);
        var newsLines = news.map(function (n) { return '- ' + n.title + ' (' + (n.sourceName || '') + ')'; }).join('\n');
        var hours = t.startedMs ? Math.max(1, Math.round((Date.now() - t.startedMs) / 3600000)) : '?';

        var prompt = '너는 경제 스토리텔링 유튜브 채널의 소재 전략가다. 시청자는 한국 성인, 포맷은 8~15분 내레이션 롱폼.\n\n'
            + '지금 한국 구글 검색 급상승 키워드: "' + t.keyword + '"\n'
            + '검색량: ' + (t.traffic || '?') + ' · 급등 시작: 약 ' + hours + '시간 전\n'
            + '관련 최신 기사 제목:\n' + (newsLines || '(기사 없음)') + '\n\n'
            + '이 채널의 철칙: ①같은 소재는 선발이 후발보다 조회수 10~40배 (선점이 생명) ②완결형 뉴스는 3일이면 소비가 끝남, 진행형 이슈는 3~13일차엔 새 각도만 생존 ③앵글은 소재가 뒷받침하는 쪽으로 — 몰락/배신/은폐, 숨은 승자, 한국에 미칠 충격 등.\n\n'
            + '아래 형식(마크다운, 각 섹션 간결하게)으로만 답해라:\n'
            + '## 왜 뜨나\n(기사 근거로 급등 원인 1~2문장. 기사만으로 불명확하면 "불명확 — 직접 확인 필요"라고 써라)\n'
            + '## 경제 채널 적합성: 상/중/하\n(한 줄 이유. 경제 스토리로 풀 각이 없으면 솔직하게 "하")\n'
            + '## 대본 앵글 3개\n각각: **[제목형 한 줄]** — 핵심 반전(시청자가 몰랐을 사실) + 판돈(누가 뭘 잃고 얻나). 서로 다른 방향으로.\n'
            + '## 타이밍 판정\n(완결형인지 진행형인지 + 지금 만들면 선발인지 후발인지 + 권장 업로드 데드라인)\n'
            + '## 썸네일 문구 후보 2개\n(각각 2줄, 줄당 11자 이내)';

        btnEl.disabled = true;
        btnEl.textContent = '분석 중... (10~30초)';
        slot.innerHTML = '';
        try {
            var result = await callGemini(prompt, { maxTokens: 2048, temperature: 0.7 });
            angleCachePut(t.keyword, result);
            slot.innerHTML = '<div class="tr-angle-box">' + mdToHtml(result) + '</div>';
            btnEl.textContent = '🎬 앵글 분석 (Gemini)';
            btnEl.disabled = false;
        } catch (e) {
            btnEl.disabled = false;
            btnEl.textContent = '🎬 재시도 — ' + String(e.message || e).slice(0, 24);
        }
    };

    // ── 🔍 유튜브 경쟁 확인 (빈 바다 판정 — preempt_radar와 동일 기준) ──
    window.trCompete = async function (btnEl, idx) {
        var t = _data && _data.trends && _data.trends[idx];
        if (!t) return;
        if (typeof fetchYouTubeAPI !== 'function') { alert('YouTube API를 사용할 수 없어요.'); return; }
        var card = btnEl.closest('.tr-card');
        var slot = card.querySelector('.tr-comp-slot');
        btnEl.disabled = true;
        btnEl.textContent = '확인 중...';
        try {
            var publishedAfter = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
            var sr = await fetchYouTubeAPI('search', {
                part: 'snippet', q: t.keyword, type: 'video',
                regionCode: 'KR', relevanceLanguage: 'ko',
                publishedAfter: publishedAfter,
                order: 'relevance', maxResults: 10
            });
            var ids = (sr.items || []).map(function (it) { return it.id && it.id.videoId; }).filter(Boolean);
            var longforms = [];
            if (ids.length) {
                var vr = await fetchYouTubeAPI('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') });
                (vr.items || []).forEach(function (x) {
                    var dur = (typeof parseIsoDuration === 'function') ? parseIsoDuration(x.contentDetails && x.contentDetails.duration) : 0;
                    var isNews = /뉴스|news|TV|방송/i.test(x.snippet.channelTitle || '');
                    if (dur >= 120 && !isNews) {
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
            if (n <= 1) { badge = '<span class="tr-badge tr-empty">🟢 빈 바다 — 롱폼 ' + n + '개</span>'; note = '지금 만들면 선발주자'; }
            else if (n <= 4) { badge = '<span class="tr-badge tr-race">🟡 경쟁 시작 — 롱폼 ' + n + '개</span>'; note = '서두르면 승산 있음'; }
            else { badge = '<span class="tr-badge tr-red">🔴 레드오션 — 롱폼 ' + n + '개+</span>'; note = '곁가지 각도 필수'; }
            var compHtml = '';
            if (longforms[0]) {
                var fv = (typeof formatViewCount === 'function') ? formatViewCount(longforms[0].views) : String(longforms[0].views);
                compHtml = '<div style="margin-top:6px;">최대 경쟁: <a href="https://www.youtube.com/watch?v=' + esc(longforms[0].id) + '" target="_blank">'
                    + esc(longforms[0].title) + '</a> · ' + esc(longforms[0].channelTitle) + ' · 조회 ' + fv + '</div>';
            }
            slot.innerHTML = '<div class="tr-comp">' + badge + ' <span style="color:#666;">' + note + ' (최근 72시간 · 2분+ · 뉴스채널 제외)</span>' + compHtml + '</div>';
            btnEl.textContent = '🔍 경쟁 확인 (101u)';
            btnEl.disabled = false;
        } catch (e) {
            btnEl.disabled = false;
            btnEl.textContent = '🔍 재시도 — ' + String(e.message || e).slice(0, 24);
        }
    };

    function setup() {
        var mount = document.getElementById('trendRadarMount');
        if (!mount || document.getElementById('trSection')) return;
        var style = document.createElement('style');
        style.textContent = TR_CSS;
        document.head.appendChild(style);
        mount.insertAdjacentHTML('afterbegin', TR_HTML);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();
