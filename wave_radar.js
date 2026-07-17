// ============================================================
// 🌊 파도 레이더 — 벤치채널 파도 추적 + 소재게이트 v2 원클릭 판정
// ============================================================
// 목적(2026-07-17, 푸짐한 경제학 97편 전수진단에서 설계):
//   "오늘 뭘 만들어야 하나?"에 숫자로 답한다. 잘나가는 벤치채널들의 최근 14일
//   영상을 긁어 같은 소재끼리 '파도'로 묶고, 각 파도에 🔥지금타라/⚠️새각도/💀지났다
//   배지를 계산해 붙인다. 판정 기준은 전부 실측:
//   - 후발 페널티: 같은 소재 선발 36.3만 vs 후발 8.8천 (41배)
//   - 배수(outlier) = 조회수 ÷ 그 채널 평소 중앙값 (1of10/ViewStats 업계 표준 방식)
//   - 완결 스토리는 3일이면 소비 끝, 진행형 파도는 3~13일이면 '새 각도'만 생존
// 선점레이더(뉴스 VPH, 파도가 되기 전)와 상호보완 — 이건 "이미 검증된 파도" 탐지.
// API 비용: 스캔 1회 ≈ 채널 N개 × 2 + 2 units (search.list 안 씀 — N=5면 약 12 units)
// ※ preempt_radar.js와 동일 패턴: index.html엔 <script src> 한 줄만, 전역 의존:
//   fetchYouTubeAPI, _matchCardHtml, escapeHtml, formatNumber, switchProcess
(function () {
    'use strict';

    var WR_CH_KEY = 'wave_channels_v1';      // [{id,name}]
    var WR_CACHE_KEY = 'wave_scan_cache_v1'; // {at, items, clusters}
    var WR_SNAP_KEY = 'wave_snapshots_v1';   // [{at, waves:{label:sumVph}}] 최근 10개
    var WR_CACHE_TTL = 30 * 60 * 1000;
    var DAYS = 14;

    // 기본 추적 채널 (2026-07-17 API로 ID 검증 — 사용자가 자유롭게 추가/삭제)
    var WR_DEFAULTS = [
        { id: 'UCD69gLlIMcDAHG5AzNnp7Bg', name: '김재민TV' },
        { id: 'UC2JEVexKegalan4xSKjVQ0g', name: '얄궂은 경제학' },
        { id: 'UCMKNGcOiDjQkroDtuCdocuQ', name: '주린이경제학' },
        { id: 'UCJG9mwOwrHpNZRalbZjkk_g', name: '안경 경제학' },
        { id: 'UCR2242gJ23KCtXU3yEZeh2A', name: '골고루 경제학' }
    ];

    // 파도 묶기용: 제목에서 의미 없는 상투어는 클러스터 키에서 제외
    var WR_STOPWORDS = ['이유', '진짜', '충격', '충격적', '소름', '실체', '정체', '결국', '지금',
        '오늘', '사실', '논란', '공개', '최초', '세계', '전세계', '난리', '발칵', '뒤집힌', '뒤집힌',
        '이것', '그런데', '하지만', '못하는', '있는', '없는', '하는', '해버린', '만에', '이제',
        '진실', '비밀', '경고', '몰랐던', '숨겨진', '드디어', '역대급', '대박', '초유',
        // 2026-07-17 실데이터 테스트에서 추가 — 일반어가 파도 씨앗이 되면 무관 영상이 한 덩어리로 묶임
        '언론', '무너지', '몰락', '위기', '날린', '정부', '국민', '대통령', '회장', '기업',
        '상황', '사태', '경제', '속보', '발표', '시작', '벌어진', '벌어지', '사라진', '사라지',
        '만든', '만들', '받은', '받는', '모든', '때문', '결말', '최후', '현재', '반전', '근황',
        // 국가명 단독은 파도 이름이 못 됨(너무 넓음) — 축 태그(AXIS_*)에서만 사용
        '중국', '한국', '미국', '일본', '유럽', '인도', '러시아', '북한',
        '최악', '최고', '최대', '전부', '갑자기', '완전히', '그리고', '한국만', '중국이', '한국이',
        // 주식 토크방송 일반어 (2026-07-17 — 광각 그물 합류 후 [방송][폭락][하락] 쓰레기 파도 실측)
        '방송', '전체보기', '오전', '오후', '폭락', '하락', '상승', '급등', '급락',
        '전망', '주식', '코스피', '증시', '시장', '투자', '매수', '매도', '신호',
        // 잡탕 묶음 방지 2차 (2026-07-17 [나라] 실측 — 흔한 명사가 무관 영상 3개를 한 방에 묶음)
        '나라', '국가', '도시', '사람', '사람들', '국민들', '기업들', '회사',
        '문제', '사건', '내막', '전쟁', '흔들리고', '무너지는', '망해가는', '잘살던'];

    // 축 태그: 우리 채널에 맞는 두 축 (푸짐한 실측 — 한국역전극·중국위기만 산다)
    var AXIS_KR = ['한화', '삼성', 'LG', 'SK', '현대', '기아', 'K9', 'K2', '천무', '조선소',
        '방산', '잠수함', '반도체', '수주', '한국', 'HD현대', '한미', 'K팝', 'K-'];
    var AXIS_CN = ['중국', '시진핑', '위안', '헝다', 'BYD', '비야디', '샤오미', '홍콩',
        '대만', '알리', '테무', '일대일로', '베이징', '상하이'];

    // ---------- 저장 ----------
    function wrLoadChannels() {
        try {
            var v = JSON.parse(localStorage.getItem(WR_CH_KEY) || 'null');
            if (Array.isArray(v) && v.length) return v;
        } catch (e) {}
        return WR_DEFAULTS.slice();
    }
    function wrSaveChannels(list) { localStorage.setItem(WR_CH_KEY, JSON.stringify(list)); }

    // ---------- 유틸 ----------
    function median(arr) {
        if (!arr.length) return 0;
        var s = arr.slice().sort(function (a, b) { return a - b; });
        return s[Math.floor(s.length / 2)];
    }
    function ageDays(publishedAt) {
        return (Date.now() - new Date(publishedAt).getTime()) / 86400000;
    }
    function vph(item) {
        var h = Math.max(1, (Date.now() - new Date(item.publishedAt).getTime()) / 3600000);
        return item.viewCount / h;
    }
    function fmtN(n) {
        if (typeof formatNumber === 'function') return formatNumber(n);
        return n >= 10000 ? (n / 10000).toFixed(1) + '만' : String(n);
    }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s); }

    // ---------- 토큰화 · 파도 묶기 ----------
    function wrTokens(title) {
        var t = String(title || '').replace(/["'“”‘’…·,.?!()\[\]〈〉<>|]/g, ' ');
        return t.split(/\s+/).map(function (w) {
            return w.replace(/(이|가|은|는|을|를|의|도|에|에서|으로|로|와|과|까지|부터|보다|한테|에게)$/, '');
        }).filter(function (w) {
            if (w.length < 2) return false;
            if (WR_STOPWORDS.indexOf(w) >= 0) return false;
            if (/^\d+$/.test(w)) return false;
            if (/^\d+[년월일개대명번조억만원%배]/.test(w)) return false; // "30년"·"1000대" 같은 수사는 씨앗 부적격
            return true;
        });
    }

    // 같은 토큰을 서로 다른 채널 2곳+ 또는 영상 2개+가 공유하면 그 토큰이 파도의 씨앗
    function wrCluster(items) {
        var tokMap = {}; // token -> [itemIdx]
        items.forEach(function (it, i) {
            var seen = {};
            wrTokens(it.title).forEach(function (tk) {
                if (seen[tk]) return; seen[tk] = 1;
                (tokMap[tk] = tokMap[tk] || []).push(i);
            });
        });
        // 씨앗 자격: 2개+ 영상이 공유하되, 전체의 12%(최소 3개) 넘게 나오는 흔한 단어는 제외(IDF 필터)
        var tooCommon = Math.max(3, Math.ceil(items.length * 0.12));
        var keys = Object.keys(tokMap).filter(function (tk) {
            return tokMap[tk].length >= 2 && tokMap[tk].length <= tooCommon;
        });
        // 파도 후보를 합산 시속 순으로 — 센 파도가 영상을 먼저 가져감(중복 배정 방지)
        keys.sort(function (a, b) {
            var sa = tokMap[a].reduce(function (s, i) { return s + vph(items[i]); }, 0);
            var sb = tokMap[b].reduce(function (s, i) { return s + vph(items[i]); }, 0);
            return sb - sa;
        });
        var assigned = {}, clusters = [];
        keys.forEach(function (tk) {
            var members = tokMap[tk].filter(function (i) { return !assigned[i]; });
            if (members.length < 2) return;
            members.forEach(function (i) { assigned[i] = 1; });
            clusters.push({ label: tk, idx: members });
        });
        // 홀로 남았어도 폭발 중이면 단독 파도로 — 신규 파도 조기 감지 (3일 내)
        // ★2026-07-17 정정: 배수 5+ 기준만 쓰면 대형 채널의 대박을 놓침(김재민 조지아 14만 =
        //   평소의 2.6배라 탈락한 실측 — 사용자 발견). 대형 채널은 절대치+2배로도 인정.
        items.forEach(function (it, i) {
            if (assigned[i]) return;
            if (ageDays(it.publishedAt) > 3) return;
            if (it.mult >= 5 || (it.viewCount >= 100000 && it.mult >= 2)) {
                clusters.push({ label: wrTokens(it.title)[0] || it.channelTitle, idx: [i], solo: true });
            }
        });
        return clusters;
    }

    // ---------- 배지 판정 (소재게이트 v2와 같은 잣대) ----------
    function wrJudgeCluster(c, items) {
        var vids = c.idx.map(function (i) { return items[i]; });
        // 히트 기준(2026-07-17 정정): 조회수만 크고 그 채널 평소보다 못한 영상(삼프로 53만=평소의 0.2배)은
        // 히트가 아님 — 배수 3+ 이거나, 3만+이면서 최소 평소 이상(1.5배+)이어야 소재의 힘으로 인정
        var hits = vids.filter(function (v) { return v.mult >= 3 || (v.viewCount >= 30000 && v.mult >= 1.5); });
        var sumVph = vids.reduce(function (s, v) { return s + vph(v); }, 0);
        var newest = Math.min.apply(null, vids.map(function (v) { return ageDays(v.publishedAt); }));
        var badge, cls, why;
        if (!hits.length) {
            badge = '👀 관찰'; cls = 'wr-watch';
            why = '아직 터진 영상 없음(3만+/배수3+ 미달) — 오르면 알림판에 올라옴';
        } else {
            var firstHitAge = Math.max.apply(null, hits.map(function (v) { return ageDays(v.publishedAt); }));
            var copies = vids.length;
            if (firstHitAge > 13 || newest > 4) {
                badge = '💀 지났다'; cls = 'wr-dead';
                why = '첫 히트 ' + firstHitAge.toFixed(0) + '일 경과' + (newest > 4 ? ' · 최근 4일간 신규 없음' : '') + ' — 파도 끝';
            } else if (firstHitAge <= 3 && copies <= 3) {
                badge = '🔥 지금 타라'; cls = 'wr-hot';
                why = '첫 히트 ' + firstHitAge.toFixed(1) + '일 전 · 참전 ' + copies + '개뿐 — 48시간 내 제작하면 파도 위';
            } else {
                badge = '⚠️ 새각도 필수'; cls = 'wr-warm';
                why = '첫 히트 ' + firstHitAge.toFixed(0) + '일 · 참전 ' + copies + '개 — 같은 얘기 재탕은 사망, 원본에 없는 다음 궁금증만 생존';
            }
        }
        // 축 태그
        var text = vids.map(function (v) { return v.title; }).join(' ');
        var axis = '';
        if (AXIS_KR.some(function (w) { return text.indexOf(w) >= 0; })) axis = '🇰🇷 한국역전극';
        else if (AXIS_CN.some(function (w) { return text.indexOf(w) >= 0; })) axis = '🐉 중국위기';
        return { badge: badge, cls: cls, why: why, sumVph: sumVph, axis: axis };
    }

    // ---------- 스냅샷(상승/하락) ----------
    function wrArrow(label, sumVph) {
        try {
            var snaps = JSON.parse(localStorage.getItem(WR_SNAP_KEY) || '[]');
            // 6시간+ 지난 가장 최근 스냅샷과 비교 (같은 스캔끼리 비교 방지)
            var prev = null;
            for (var i = snaps.length - 1; i >= 0; i--) {
                if (Date.now() - snaps[i].at > 6 * 3600000) { prev = snaps[i]; break; }
            }
            if (!prev || !(label in prev.waves)) return '';
            var old = prev.waves[label];
            if (sumVph > old * 1.2) return ' <span style="color:#c92a2a;font-weight:800;">↑상승중</span>';
            if (sumVph < old * 0.7) return ' <span style="color:#868e96;">↓식는중</span>';
            return ' <span style="color:#888;">→유지</span>';
        } catch (e) { return ''; }
    }
    function wrSaveSnapshot(clusters, items) {
        try {
            var snaps = JSON.parse(localStorage.getItem(WR_SNAP_KEY) || '[]');
            var waves = {};
            clusters.forEach(function (c) {
                waves[c.label] = c.idx.reduce(function (s, i) { return s + vph(items[i]); }, 0);
            });
            snaps.push({ at: Date.now(), waves: waves });
            if (snaps.length > 10) snaps = snaps.slice(-10);
            localStorage.setItem(WR_SNAP_KEY, JSON.stringify(snaps));
        } catch (e) {}
    }

    // ---------- 수집 ----------
    window.runWaveRadar = async function () {
        var btn = document.getElementById('wrScanBtn');
        var st = document.getElementById('wrStatus');
        var channels = wrLoadChannels();
        if (typeof fetchYouTubeAPI !== 'function') { st.textContent = 'API 함수를 못 찾음 — 주제찾기 탭 먼저 열어주세요.'; return; }
        btn.disabled = true; btn.textContent = '스캔 중...';
        try {
            var allItems = [];
            var chMeta = {}; // id -> {subs, median}
            // 채널 통계 (구독자수) 일괄
            st.textContent = '채널 정보 수집 중...';
            var cids = channels.map(function (c) { return c.id; }).join(',');
            var cr = await fetchYouTubeAPI('channels', { part: 'statistics', id: cids, maxResults: 50 });
            (cr.items || []).forEach(function (c) {
                chMeta[c.id] = { subs: parseInt((c.statistics || {}).subscriberCount || '0') };
            });
            for (var ci = 0; ci < channels.length; ci++) {
                var ch = channels[ci];
                st.textContent = '(' + (ci + 1) + '/' + channels.length + ') ' + ch.name + ' 수집 중...';
                var pl = await fetchYouTubeAPI('playlistItems', {
                    part: 'contentDetails,snippet', playlistId: 'UU' + ch.id.slice(2), maxResults: 50
                });
                var vids = (pl.items || []).map(function (it) {
                    return {
                        videoId: it.contentDetails.videoId,
                        publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
                        title: it.snippet.title
                    };
                });
                var ids = vids.map(function (v) { return v.videoId; }).join(',');
                if (!ids) continue;
                var vr = await fetchYouTubeAPI('videos', { part: 'statistics,snippet,contentDetails', id: ids, maxResults: 50 });
                var stats = {};
                (vr.items || []).forEach(function (v) {
                    stats[v.id] = {
                        viewCount: parseInt((v.statistics || {}).viewCount || '0'),
                        likeCount: parseInt((v.statistics || {}).likeCount || '0'),
                        commentCount: parseInt((v.statistics || {}).commentCount || '0'),
                        thumbnail: (((v.snippet || {}).thumbnails || {}).medium || {}).url || ''
                    };
                });
                // 채널 평소 성적 = 3~90일 지난 영상들의 중앙값 (어린 영상은 아직 안 자라 제외)
                var matured = vids.filter(function (v) {
                    var a = ageDays(v.publishedAt);
                    return a >= 3 && a <= 90 && stats[v.videoId];
                }).map(function (v) { return stats[v.videoId].viewCount; });
                var med = median(matured.length >= 5 ? matured : vids.map(function (v) { return (stats[v.videoId] || {}).viewCount || 0; }));
                chMeta[ch.id] = chMeta[ch.id] || {};
                chMeta[ch.id].median = Math.max(1, med);
                vids.forEach(function (v) {
                    if (ageDays(v.publishedAt) > DAYS || !stats[v.videoId]) return;
                    var s = stats[v.videoId];
                    allItems.push({
                        videoId: v.videoId, title: v.title, publishedAt: v.publishedAt,
                        channelId: ch.id, channelTitle: ch.name,
                        viewCount: s.viewCount, likeCount: s.likeCount, commentCount: s.commentCount,
                        thumbnail: s.thumbnail,
                        subscriberCount: chMeta[ch.id].subs || 0,
                        efficiency: chMeta[ch.id].subs ? s.viewCount / chMeta[ch.id].subs : 0,
                        chMedian: chMeta[ch.id].median,
                        mult: s.viewCount / chMeta[ch.id].median
                    });
                });
            }
            // ★넓은 그물 합류: 아침브리핑(등록 채널 563개 전체를 서버가 매일 무료 스캔한 결과)의
            //   최근 24시간 급상승·떡상 상위를 파도 재료에 합침 — 추적 5~15개(정밀) + 563개(광각) 이중 레이더.
            st.textContent = '아침브리핑(전체 등록채널) 합류 중...';
            try {
                var br = await fetch('briefing.json?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.json(); });
                var cat = (br.categories || {})['경제'] || {};
                // ★14일 축적(2026-07-17): 브리핑은 24시간 창이라, 매 스캔마다 그날 수확 전량('videos',
                //   없으면 rising+viral)을 로컬에 쌓아 14일치 광각 그물을 만든다 — 업계 DB 방식의 경량판.
                var todays = (cat.videos && cat.videos.length) ? cat.videos : (cat.rising || []).concat(cat.viral || []);
                var hist = {};
                try { hist = JSON.parse(localStorage.getItem('wave_briefing_hist_v1') || '{}'); } catch (e2) {}
                todays.forEach(function (b) { if (b && b.videoId) hist[b.videoId] = b; });
                // 14일 지난 항목 청소 + 저장
                Object.keys(hist).forEach(function (k) {
                    if (ageDays(hist[k].publishedAt) > DAYS) delete hist[k];
                });
                try { localStorage.setItem('wave_briefing_hist_v1', JSON.stringify(hist)); } catch (e3) {}
                var seen = {};
                allItems.forEach(function (it) { seen[it.videoId] = 1; });
                Object.keys(hist).map(function (k) { return hist[k]; }).forEach(function (b) {
                    if (seen[b.videoId]) return; seen[b.videoId] = 1;
                    if (ageDays(b.publishedAt) > DAYS) return;
                    // 데일리 방송 녹화·라이브 재방은 소재가 아님 (삼프로 '오전 방송 전체보기' 류)
                    if (/전체보기|풀버전|다시보기|라이브|LIVE|생방송|모닝브리핑|마감시황|시황/i.test(b.title || '')) return;
                    allItems.push({
                        videoId: b.videoId, title: b.title, publishedAt: b.publishedAt,
                        channelId: b.channelId, channelTitle: b.channelTitle + ' ⚡',
                        viewCount: b.viewCount || 0, likeCount: 0, commentCount: 0,
                        thumbnail: b.thumbnail || '',
                        subscriberCount: b.subscriberCount || 0,
                        efficiency: b.efficiency || 0,
                        chMedian: 0,
                        // 브리핑 채널은 평소 중앙값을 모름 → 효율(조회÷구독)을 배수 근사치로 사용
                        mult: b.efficiency || 1
                    });
                });
            } catch (e) { /* 브리핑 없으면 추적 채널만으로 진행 */ }
            var clusters = wrCluster(allItems);
            localStorage.setItem(WR_CACHE_KEY, JSON.stringify({ at: Date.now(), items: allItems, clusters: clusters }));
            wrRender(allItems, clusters);
            wrSaveSnapshot(clusters, allItems);
            wrTopicTeaser();
            st.textContent = '스캔 완료 — 영상 ' + allItems.length + '개 · 파도 ' + clusters.length + '개 (' + new Date().toLocaleTimeString() + ')';
        } catch (e) {
            st.textContent = '오류: ' + e.message;
        } finally {
            btn.disabled = false; btn.textContent = '🌊 파도 스캔';
        }
    };

    // ---------- 게이트 v2 원클릭 판정 ----------
    window.wrGateJudge = function (ci) {
        var cache = wrCache(); if (!cache) return;
        var c = cache.clusters[ci];
        var vids = c.idx.map(function (i) { return cache.items[i]; });
        var lead = vids.slice().sort(function (a, b) { return b.viewCount - a.viewCount; })[0];
        var sumVphNow = Math.round(vids.reduce(function (s, v) { return s + vph(v); }, 0));
        var el = Math.floor(ageDays(lead.publishedAt));
        var eff = lead.subscriberCount ? (lead.viewCount / lead.subscriberCount) : 0;
        var copies = vids.length;
        var lines = [];
        var verdict;
        var demandOk = lead.mult >= 3 || (lead.viewCount >= 30000 && lead.mult >= 1.5);
        if (!demandOk) {
            verdict = '⛔ 폐기 권고';
            lines.push('수요 미증명 — 조회 ' + fmtN(lead.viewCount) + ' · 평소의 ' + lead.mult.toFixed(1) + '배. 배수 3+ 또는 3만+이면서 평소 이상(1.5배+)이어야 소재의 힘 증명. 조회수만 크고 그 채널 평소만 못하면 채널빨이지 소재빨이 아님.');
        } else if (el >= 14) {
            verdict = '⛔ 폐기 권고';
            lines.push('선점 실기 — 리드 영상이 ' + el + '일 경과(2주+). 파도가 지나감.');
        } else if (el >= 3 || copies >= 4) {
            verdict = '⚠️ 새각도 조건부 진행';
            lines.push('첫 히트 ' + el + '일 경과 · 참전 ' + copies + '개 — 같은 얘기 재탕은 후발 사망(선발 36.3만 vs 후발 8.8천 실측).');
            lines.push('원본에 없는 "다음 궁금증"을 잡아야 함 (얄궂은 한화 2연타: 각도가 다르면 둘 다 터짐).');
        } else {
            verdict = '✅ 진행 (48시간 내)';
            lines.push('첫 히트 ' + el + '일 · 조회 ' + fmtN(lead.viewCount) + ' · 배수 ' + lead.mult.toFixed(1) + '배 · 참전 ' + copies + '개 — 파도 초입.');
        }
        var judged = {
            "실측": {
                "레퍼런스_업로드일": lead.publishedAt.slice(0, 10),
                "레퍼런스_조회수": lead.viewCount,
                "레퍼런스_구독자수": lead.subscriberCount,
                "판정일": new Date().toISOString().slice(0, 10)
            },
            "시의성": { "판정": "진행형", "근거": "파도 레이더 실측 — 참전 " + copies + "개, 합산 시속 " + sumVphNow + "회", "새각도": "" }
        };
        var box = document.getElementById('wrJudge_' + ci);
        if (box) {
            box.style.display = '';
            box.innerHTML = '<div style="font-weight:800;margin-bottom:6px;">' + verdict + '</div>'
                + lines.map(function (l) { return '<div style="font-size:0.85rem;color:#555;margin-bottom:4px;">· ' + esc(l) + '</div>'; }).join('')
                + '<div style="margin-top:8px;display:flex;gap:8px;">'
                + '<button onclick="wrCopyJudge(' + ci + ')" style="padding:6px 14px;background:#1971c2;color:white;border:none;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;">📋 실측 JSON 복사 (00_소재판정용)</button>'
                + '<a href="https://www.youtube.com/watch?v=' + lead.videoId + '" target="_blank" style="padding:6px 14px;background:#f1f3f5;color:#333;border-radius:8px;font-size:0.82rem;font-weight:700;text-decoration:none;">▶ 리드 영상 보기</a>'
                + '</div>';
            box.dataset.judged = JSON.stringify(judged, null, 2);
        }
    };
    window.wrCopyJudge = function (ci) {
        var box = document.getElementById('wrJudge_' + ci);
        if (!box || !box.dataset.judged) return;
        navigator.clipboard.writeText(box.dataset.judged).then(function () {
            alert('복사됨 — 00_소재판정.json에 붙여넣고 시의성 근거·새각도만 채우면 게이트 통과 준비 끝');
        });
    };

    // ---------- 렌더 ----------
    function wrCache() {
        try {
            var c = JSON.parse(localStorage.getItem(WR_CACHE_KEY) || 'null');
            return (c && c.items) ? c : null;
        } catch (e) { return null; }
    }

    function wrCardHtml(v) {
        // 큼지막·한눈에 (2026-07-17 사용자 요청: 썸네일·글자 확대, 공백 압축, 배수=색깔 알약)
        var a = ageDays(v.publishedAt);
        var ageTxt = a < 1 ? Math.round(a * 24) + '시간 전' : Math.round(a) + '일 전';
        var multCls = v.mult >= 10 ? 'wrm-hot' : (v.mult >= 3 ? 'wrm-warm' : 'wrm-cold');
        var multTxt = v.mult >= 10 ? Math.round(v.mult) : v.mult.toFixed(1);
        return '<div class="wr-card" onclick="window.open(\'https://www.youtube.com/watch?v=' + v.videoId + '\')">'
            + (v.thumbnail ? '<img class="wr-thumb" src="' + v.thumbnail + '" loading="lazy">' : '<div class="wr-thumb"></div>')
            + '<div class="wr-body">'
            + '<div class="wr-title">' + esc(v.title) + '</div>'
            + '<div class="wr-meta"><span class="wr-ch">' + esc(v.channelTitle) + '</span><span>' + ageTxt + '</span>'
            + '<b class="wr-views">' + fmtN(v.viewCount) + '회</b></div>'
            + '<div class="wr-pills"><span class="wr-mult ' + multCls + '">평소의 ' + multTxt + '배</span>'
            + '<span class="wr-vph">시속 ' + fmtN(Math.round(vph(v))) + '</span></div>'
            + '</div></div>';
    }

    function wrRender(items, clusters) {
        var listEl = document.getElementById('wrList');
        if (!listEl) return;
        if (!clusters.length) { listEl.innerHTML = '<p style="color:#888;">최근 14일 파도 없음 — 채널을 추가하거나 다시 스캔하세요.</p>'; return; }
        var scored = clusters.map(function (c, i) {
            var j = wrJudgeCluster(c, items);
            c.sumVphView = j.sumVph;
            return { c: c, j: j, i: i };
        });
        // 정렬: 🔥 먼저, 그 안에서 합산 시속 순
        var order = { 'wr-hot': 0, 'wr-warm': 1, 'wr-watch': 2, 'wr-dead': 3 };
        scored.sort(function (a, b) {
            if (order[a.j.cls] !== order[b.j.cls]) return order[a.j.cls] - order[b.j.cls];
            return b.j.sumVph - a.j.sumVph;
        });
        var axisFilter = (document.getElementById('wrAxisFilter') || {}).value || '';
        listEl.innerHTML = scored.filter(function (s) {
            if (!axisFilter) return true;
            return s.j.axis.indexOf(axisFilter) >= 0;
        }).slice(0, 15).map(function (s) {
            var c = s.c, j = s.j;
            var vids = c.idx.map(function (i) { return items[i]; })
                .sort(function (a, b) { return b.viewCount - a.viewCount; });
            return '<div class="wr-wave ' + j.cls + '-wave">'
                + '<div class="wr-wave-head">'
                + '<span class="wr-badge ' + j.cls + '">' + j.badge + '</span>'
                + '<span class="wr-label">' + esc(c.label) + '</span>'
                + (j.axis ? '<span class="wr-axis">' + j.axis + '</span>' : '')
                + '<span class="wr-sum">합산 시속 <b>' + fmtN(Math.round(j.sumVph)) + '</b>' + wrArrow(c.label, j.sumVph) + '</span>'
                + '<button class="wr-judge-btn" onclick="wrGateJudge(' + s.i + ')">⚖️ 게이트 판정</button>'
                + '</div>'
                + '<div class="wr-why">' + esc(j.why) + '</div>'
                + '<div id="wrJudge_' + s.i + '" class="wr-judgebox" style="display:none;"></div>'
                + '<div class="wr-grid">' + vids.map(wrCardHtml).join('') + '</div>'
                + '</div>';
        }).join('');
    }

    // ---------- 채널 관리 UI ----------
    window.wrRenderChannels = function () {
        var el = document.getElementById('wrChips');
        if (!el) return;
        var chs = wrLoadChannels();
        el.innerHTML = chs.map(function (c, i) {
            return '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:#e7f0fb;border-radius:16px;font-size:0.82rem;font-weight:600;">'
                + esc(c.name)
                + '<span onclick="wrRemoveChannel(' + i + ')" style="cursor:pointer;color:#c92a2a;font-weight:800;">×</span></span>';
        }).join('');
    };
    window.wrRemoveChannel = function (i) {
        var chs = wrLoadChannels(); chs.splice(i, 1); wrSaveChannels(chs); wrRenderChannels();
    };
    window.wrAddChannel = async function () {
        var inp = document.getElementById('wrAddInput');
        var q = (inp.value || '').trim();
        if (!q) return;
        var st = document.getElementById('wrStatus');
        st.textContent = '채널 검색 중...';
        try {
            var sr = await fetchYouTubeAPI('search', { part: 'snippet', q: q, type: 'channel', maxResults: 3 });
            var it = (sr.items || [])[0];
            if (!it) { st.textContent = '채널을 못 찾음: ' + q; return; }
            var chs = wrLoadChannels();
            if (chs.some(function (c) { return c.id === it.snippet.channelId; })) { st.textContent = '이미 등록됨'; return; }
            chs.push({ id: it.snippet.channelId, name: it.snippet.title });
            wrSaveChannels(chs); wrRenderChannels();
            inp.value = '';
            st.textContent = '추가됨: ' + it.snippet.title;
        } catch (e) { st.textContent = '오류: ' + e.message; }
    };

    // ---------- 주제찾기 상단 한 줄 ----------
    function wrTopicTeaser() {
        var cache = wrCache();
        if (!cache || Date.now() - cache.at > 12 * 3600000) return;
        var host = document.getElementById('briefingSection');
        if (!host) return;
        var scored = cache.clusters.map(function (c) { return { c: c, j: wrJudgeCluster(c, cache.items) }; })
            .filter(function (s) { return s.j.cls === 'wr-hot' || s.j.cls === 'wr-warm'; })
            .sort(function (a, b) { return b.j.sumVph - a.j.sumVph; }).slice(0, 3);
        if (!scored.length) return;
        var old = document.getElementById('wrTeaser');
        if (old) old.remove();
        var div = document.createElement('div');
        div.id = 'wrTeaser';
        div.style.cssText = 'padding:10px 14px;background:linear-gradient(90deg,#e7f5ff,#fff);border:1px solid #d0ebff;border-radius:10px;margin-bottom:10px;cursor:pointer;font-size:0.88rem;';
        div.innerHTML = '🌊 <b>오늘의 파도:</b> ' + scored.map(function (s) {
            return (s.j.cls === 'wr-hot' ? '🔥' : '⚠️') + ' ' + esc(s.c.label);
        }).join(' · ') + ' <span style="color:#1971c2;font-weight:700;">→ 파도 레이더 열기</span>';
        div.onclick = function () { switchProcess('radar'); };
        host.parentNode.insertBefore(div, host);
    }

    // 큼지막·깔끔 카드 스타일 (2026-07-17 — 흰 카드+옅은 그림자, 2열 그리드, 공백 압축)
    var WR_CSS = ''
        + '.wr-wave{background:white;border:1px solid #ececec;border-radius:16px;padding:16px 18px;margin-bottom:16px;box-shadow:0 2px 10px rgba(0,0,0,.05);}'
        + '.wr-wave.wr-hot-wave{border-left:5px solid #fa5252;}'
        + '.wr-wave.wr-warm-wave{border-left:5px solid #ff922b;}'
        + '.wr-wave.wr-watch-wave{border-left:5px solid #4dabf7;}'
        + '.wr-wave.wr-dead-wave{border-left:5px solid #ced4da;opacity:.75;}'
        + '.wr-wave-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
        + '.wr-badge{padding:6px 14px;border-radius:10px;font-weight:800;font-size:0.95rem;white-space:nowrap;}'
        + '.wr-badge.wr-hot{background:#ffe3e3;color:#c92a2a;}'
        + '.wr-badge.wr-warm{background:#fff3e0;color:#e8590c;}'
        + '.wr-badge.wr-watch{background:#e7f0fb;color:#1971c2;}'
        + '.wr-badge.wr-dead{background:#f1f3f5;color:#868e96;}'
        + '.wr-label{font-weight:900;font-size:1.35rem;letter-spacing:-0.5px;}'
        + '.wr-axis{font-size:0.82rem;font-weight:700;padding:4px 10px;background:#f3f0ff;color:#5f3dc4;border-radius:8px;}'
        + '.wr-sum{font-size:0.88rem;color:#666;}'
        + '.wr-sum b{color:#1971c2;font-size:1rem;}'
        + '.wr-judge-btn{margin-left:auto;padding:8px 18px;background:#0ca678;color:white;border:none;border-radius:10px;font-size:0.9rem;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(12,166,120,.25);}'
        + '.wr-judge-btn:hover{background:#099268;}'
        + '.wr-why{font-size:0.86rem;color:#868e96;margin:6px 0 12px;}'
        + '.wr-judgebox{background:#f0faf5;border:1px solid #c3e6d4;border-radius:12px;padding:14px;margin-bottom:12px;font-size:0.95rem;}'
        + '.wr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:10px;}'
        + '@media(max-width:1000px){.wr-grid{grid-template-columns:1fr;}}'
        + '.wr-card{display:flex;gap:14px;padding:12px;border:1px solid #f0f0f0;border-radius:14px;background:white;cursor:pointer;transition:all .15s;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.04);}'
        + '.wr-card:hover{border-color:#1971c2;box-shadow:0 4px 14px rgba(25,113,194,.15);transform:translateY(-1px);}'
        + '.wr-thumb{width:210px;height:118px;object-fit:cover;border-radius:10px;flex-shrink:0;background:#f1f3f5;}'
        + '.wr-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;}'
        + '.wr-title{font-weight:800;font-size:1.05rem;line-height:1.4;color:#212529;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
        + '.wr-meta{display:flex;gap:10px;align-items:center;font-size:0.88rem;color:#868e96;flex-wrap:wrap;}'
        + '.wr-ch{font-weight:700;color:#495057;}'
        + '.wr-views{color:#212529;font-size:0.95rem;}'
        + '.wr-pills{display:flex;gap:8px;align-items:center;}'
        + '.wr-mult{padding:5px 12px;border-radius:9px;font-weight:800;font-size:0.92rem;}'
        + '.wr-mult.wrm-hot{background:#fa5252;color:white;}'
        + '.wr-mult.wrm-warm{background:#fff3e0;color:#e8590c;}'
        + '.wr-mult.wrm-cold{background:#f1f3f5;color:#868e96;}'
        + '.wr-vph{font-size:0.85rem;color:#1971c2;font-weight:700;}';

    // ---------- 탭 등록 (index.html 무수정 — 몽키패치 패턴) ----------
    function setup() {
        if (document.getElementById('process-radar')) return;
        var st0 = document.createElement('style');
        st0.textContent = WR_CSS;
        document.head.appendChild(st0);
        // 사이드바 버튼 (제작 흐름 그룹, 트렌드 다음)
        var trendBtn = document.getElementById('procBtn_trend');
        if (trendBtn) {
            var btn = document.createElement('button');
            btn.className = 'process-btn inactive';
            btn.id = 'procBtn_radar';
            btn.innerHTML = '🌊 파도 레이더';
            btn.onclick = function () { switchProcess('radar'); };
            trendBtn.insertAdjacentElement('afterend', btn);
        }
        // 콘텐츠 div
        var container = document.querySelector('.container');
        if (!container) return;
        var div = document.createElement('div');
        div.id = 'process-radar';
        div.style.display = 'none';
        div.innerHTML = ''
            + '<div class="section">'
            + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
            + '    <span>🌊 파도 레이더 — 오늘 뭘 만들어야 하나</span>'
            + '    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
            + '      <select id="wrAxisFilter" onchange="wrRerender()" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
            + '        <option value="">전체 축</option>'
            + '        <option value="한국역전극">🇰🇷 한국역전극만</option>'
            + '        <option value="중국위기">🐉 중국위기만</option>'
            + '      </select>'
            + '      <button id="wrScanBtn" onclick="runWaveRadar()" style="padding:6px 16px;background:#1971c2;color:white;border:none;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;">🌊 파도 스캔</button>'
            + '    </div>'
            + '  </div>'
            + '  <div class="section-content">'
            + '    <p style="font-size:0.85rem;color:#888;margin-bottom:10px;">'
            + '      벤치채널들의 최근 14일 영상을 같은 소재끼리 <b>파도</b>로 묶고, 배지로 판정합니다:'
            + '      🔥지금 타라(3일 내 히트·참전 적음) / ⚠️새각도 필수(재탕은 사망) / 💀지났다.'
            + '      <b>배수</b> = 그 채널 평소 중앙값 대비 몇 배(업계 표준 outlier 방식). 스캔 1회 ≈ 12 units.'
            + '    </p>'
            + '    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap;">'
            + '      <div id="wrChips" style="display:flex;gap:6px;flex-wrap:wrap;"></div>'
            + '      <input type="text" id="wrAddInput" placeholder="추적 채널 추가 (채널명)" style="padding:7px 10px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.82rem;width:180px;" onkeydown="if(event.key===\'Enter\')wrAddChannel()">'
            + '      <button onclick="wrAddChannel()" style="padding:7px 12px;background:#f1f3f5;border:1px solid #dee2e6;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;">+ 추가</button>'
            + '    </div>'
            + '    <div id="wrStatus" style="font-size:0.85rem;color:#1971c2;font-weight:600;margin-bottom:10px;"></div>'
            + '    <div id="wrList"></div>'
            + '  </div>'
            + '</div>';
        container.appendChild(div);
        // switchProcess 몽키패치 (preempt_radar.js와 동일 패턴)
        var orig = window.switchProcess;
        if (typeof orig === 'function' && !orig._wrPatched) {
            var patched = function (p) {
                var r = orig.apply(this, arguments);
                try {
                    var el = document.getElementById('process-radar');
                    if (el) el.style.display = (p === 'radar') ? '' : 'none';
                    var b = document.getElementById('procBtn_radar');
                    if (b) b.classList.toggle('inactive', p !== 'radar');
                    if (p === 'radar') { wrRenderChannels(); wrRerenderFromCache(); }
                } catch (e) {}
                return r;
            };
            patched._wrPatched = true;
            window.switchProcess = patched;
        }
        wrRenderChannels();
        // 주제찾기 상단 한 줄 (캐시 있으면)
        setTimeout(wrTopicTeaser, 1500);
    }

    window.wrRerender = function () { wrRerenderFromCache(); };
    function wrRerenderFromCache() {
        var cache = wrCache();
        if (!cache) return;
        var st = document.getElementById('wrStatus');
        if (st && Date.now() - cache.at < WR_CACHE_TTL) {
            st.textContent = '캐시 표시 중 (' + Math.round((Date.now() - cache.at) / 60000) + '분 전 스캔) — 새로 보려면 파도 스캔';
        }
        wrRender(cache.items, cache.clusters);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
