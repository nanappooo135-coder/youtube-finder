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

    var WR_CACHE_TTL = 30 * 60 * 1000;
    var DAYS = 14;

    // ★장르 (2026-07-18 신설) — 같은 파도 엔진 위에서 경제 채널 파도 ⇄ 역사 채널 파도를 토글.
    //   근거: 역썰남(역사) 진단 — 대박작은 전부 '지금 뉴스를 역사로 푸는' 뉴스재킹형이었다.
    //   경제와 역사는 벤치 채널·소재 씨앗·축이 다르므로 장르로 config를 통째 갈아끼운다.
    //   localStorage는 장르별로 격리(역사는 '_h' 접미) — 경제 기존 데이터 보존.
    var WR_GENRE = (function () { try { return localStorage.getItem('wave_genre_v1') || '경제'; } catch (e) { return '경제'; } })();
    // 아래 6개는 wrApplyGenre()가 장르에 맞춰 재바인딩하는 가변 상태 (선언만)
    var WR_CH_KEY, WR_CACHE_KEY, WR_SNAP_KEY, WR_BLOCK_KEY, WR_BRIEF_KEY, WR_CAT;
    var WR_DEFAULTS, WR_STOPWORDS, WR_GENRE_BLOCK, AXIS_KR, AXIS_CN, WR_AXIS_LABELS;

    // ── 파도 묶기용 공통 상투어 (제목에서 씨앗 자격 박탈) — 장르 무관 ──
    var WR_STOP_COMMON = ['이유', '진짜', '충격', '충격적', '소름', '실체', '정체', '결국', '지금',
        '오늘', '사실', '논란', '공개', '최초', '세계', '전세계', '난리', '발칵', '뒤집힌',
        '이것', '그런데', '하지만', '못하는', '있는', '없는', '하는', '해버린', '만에', '이제',
        '진실', '비밀', '경고', '몰랐던', '숨겨진', '드디어', '역대급', '대박', '초유',
        '언론', '무너지', '몰락', '위기', '날린', '정부', '국민', '대통령', '회장',
        '상황', '사태', '속보', '발표', '시작', '벌어진', '벌어지', '사라진', '사라지',
        '만든', '만들', '받은', '받는', '모든', '때문', '결말', '최후', '현재', '반전', '근황',
        '중국', '한국', '미국', '일본', '유럽', '인도', '러시아', '북한',
        '최악', '최고', '최대', '전부', '갑자기', '완전히', '그리고', '한국만', '중국이', '한국이',
        '나라', '국가', '도시', '사람', '사람들', '국민들', '전쟁', '흔들리고', '무너지는', '망해가는',
        '있다', '없다', '한다', '된다', '간다', '왔다', '온다', '됐다', '했다', '먹었다',
        '알고', '보니', '먼저', '직접', '통째로', '하필',
        '교수', '박사', '대표', '소장', '위원', '기자', '앵커', '작가', '전문가',
        '1부', '2부', '3부', '인터뷰', '대담', '강연', '특집', '총정리', '몰아보기', '요약'];
    // 경제 전용 추가 상투어 (주식 토크방송 일반어 — [방송][폭락] 쓰레기 파도 실측)
    var WR_STOP_ECON = ['기업', '경제', '기업들', '회사', '문제', '사건', '내막', '잘살던',
        '방송', '전체보기', '오전', '오후', '폭락', '하락', '상승', '급등', '급락',
        '전망', '주식', '코스피', '증시', '시장', '투자', '매수', '매도', '신호',
        '공장', '산업', '제품', '가격', '돈', '수출', '수입', '누빈다'];
    // 역사 전용 추가 상투어 (2026-07-18 — 역사 채널 제목 상투어·수면채널 형식어)
    var WR_STOP_HIST = ['역사', '세계사', '한국사', '조선', '고려', '신라', '백제', '왕조',
        '이야기', '실화', '미스터리', '다큐', '비하인드', '재조명', '스토리', '전쟁사',
        '그날', '당시', '시대', '인물', '최강', '전설', '레전드', '위인', '영웅',
        '자면서', '잠들기', '잘때', '수면', '수면유도', '잠', '듣는', '읽어주는', 'asmr'];

    // 장르 차단 (2026-07-17 — [남자] 국제커플 브이로그 🔥 사고 → 채널이 아니라 장르로 거른다)
    var WR_BLOCK_LIFE = '결혼|연애|커플|데이트|썸|이혼|브이로그|vlog|일상|여행기|먹방|맛집|레시피|요리법|다이어트|운동법|루틴|언박싱|리뷰어|국제커플|한국 온|한국에 온|시댁|남편|아내|육아|출산|연예인|아이돌|열애|드라마|예능';
    // 역사 추가 차단: 수면유도·ASMR·낭독채널(신호 낮음) + 게임/롤플레이
    var WR_BLOCK_HIST_EXTRA = '자면서|잠들기|잠들 때|잘 때 듣|잘때 듣|잠 안 올|잠안올|잠 올 때|잠 잘|잠잘|잠자기|수면유도|숙면|백색소음|자장가|asmr|낭독|오디오북|롤플레이|게임';

    // ── 장르별 config (2026-07-18) ──
    var WR_CFG = {
        '경제': {
            cat: '경제',
            defaults: [
                { id: 'UCD69gLlIMcDAHG5AzNnp7Bg', name: '김재민TV' },
                { id: 'UC2JEVexKegalan4xSKjVQ0g', name: '얄궂은 경제학' },
                { id: 'UCMKNGcOiDjQkroDtuCdocuQ', name: '주린이경제학' },
                { id: 'UCJG9mwOwrHpNZRalbZjkk_g', name: '안경 경제학' },
                { id: 'UCR2242gJ23KCtXU3yEZeh2A', name: '골고루 경제학' }
            ],
            stopwords: WR_STOP_COMMON.concat(WR_STOP_ECON),
            block: new RegExp(WR_BLOCK_LIFE, 'i'),
            // 축: 한국역전극·중국위기 (푸짐한 실측)
            axisA: { label: '🇰🇷 한국역전극', key: '한국역전극', words: ['한화', '삼성', 'LG', 'SK', '현대', '기아', 'K9', 'K2', '천무', '조선소', '방산', '잠수함', '반도체', '수주', '한국', 'HD현대', '한미', 'K팝', 'K-'] },
            axisB: { label: '🐉 중국위기', key: '중국위기', words: ['중국', '시진핑', '위안', '헝다', 'BYD', '비야디', '샤오미', '홍콩', '대만', '알리', '테무', '일대일로', '베이징', '상하이'] }
        },
        '역사': {
            cat: '역사',
            // 역사 벤치 씨앗 (finder 등록채널에서 선별 — 사용자가 자유롭게 교체)
            defaults: [
                { id: 'UCYuiS1EYw54dEJVzseQSYXw', name: '별별역사' },
                { id: 'UC9cCBxBAQW2CzLYeT20q49A', name: '지식해적단' },
                { id: 'UCdop7AYwvReE6jK7M69MA2A', name: '함께하는 세계사' },
                { id: 'UCbgGRffxm74LGKMVXXUsOZQ', name: '전쟁의 신' },
                { id: 'UCPHQb5jYhC3pDVE5E3hb32w', name: '히스토리 라이브러리' }
            ],
            stopwords: WR_STOP_COMMON.concat(WR_STOP_HIST),
            block: new RegExp(WR_BLOCK_LIFE + '|' + WR_BLOCK_HIST_EXTRA, 'i'),
            // 축: 역썰남 실측 승리 레인 — 지정학·현대사(뉴스재킹) / 권력·몰락(서태후형)
            axisA: { label: '🌍 지정학·현대사', key: '지정학', words: ['전쟁', '이란', '이스라엘', '모사드', 'CIA', '스파이', '북한', '러시아', '우크라', '핵', '미사일', '쿠데타', '하마스', '헤즈볼라', '팔레스타인', '중동', '분쟁', '냉전', '테러', '독재', '학살'] },
            axisB: { label: '👑 권력·몰락', key: '권력몰락', words: ['왕', '황제', '황후', '여왕', '권력', '몰락', '배신', '처형', '반란', '음모', '멸망', '암살', '독살', '숙청', '쿠데타', '최후', '몰살'] }
        }
    };

    function wrApplyGenre(g) {
        WR_GENRE = (g === '역사') ? '역사' : '경제';
        try { localStorage.setItem('wave_genre_v1', WR_GENRE); } catch (e) {}
        var cfg = WR_CFG[WR_GENRE];
        var suf = (WR_GENRE === '역사') ? '_h' : ''; // 경제=기존 키(하위호환), 역사=격리
        WR_CH_KEY = 'wave_channels_v1' + suf;
        WR_CACHE_KEY = 'wave_scan_cache_v1' + suf;
        WR_SNAP_KEY = 'wave_snapshots_v1' + suf;
        WR_BLOCK_KEY = 'wave_blocked_channels_v1' + suf;
        WR_BRIEF_KEY = 'wave_briefing_hist_v1' + suf;
        WR_CAT = cfg.cat;
        WR_DEFAULTS = cfg.defaults;
        WR_STOPWORDS = cfg.stopwords;
        WR_GENRE_BLOCK = cfg.block;
        AXIS_KR = cfg.axisA.words; AXIS_CN = cfg.axisB.words;
        WR_AXIS_LABELS = { A: cfg.axisA, B: cfg.axisB };
    }
    wrApplyGenre(WR_GENRE);

    // ---------- 차단 채널 (2026-07-17 — 세력주분석 같은 결 안 맞는 채널 손수 제거) ----------
    // WR_BLOCK_KEY는 wrApplyGenre()가 장르별로 세팅(경제=..._v1, 역사=..._v1_h)
    function wrBlocked() {
        try { return JSON.parse(localStorage.getItem(WR_BLOCK_KEY) || '{}'); } catch (e) { return {}; }
    }
    window.wrBlockChannel = function (cid, name) {
        var b = wrBlocked(); b[cid] = name;
        localStorage.setItem(WR_BLOCK_KEY, JSON.stringify(b));
        var c = wrCache();
        if (c) { // 캐시에서 즉시 제거 + 파도 재계산 + 화면 갱신
            c.items = c.items.filter(function (v) { return v.channelId !== cid; });
            c.clusters = wrCluster(c.items);
            localStorage.setItem(WR_CACHE_KEY, JSON.stringify(c));
            wrRender(c.items, c.clusters);
        }
        wrRenderBlocked();
    };
    window.wrUnblockChannel = function (cid) {
        var b = wrBlocked(); delete b[cid];
        localStorage.setItem(WR_BLOCK_KEY, JSON.stringify(b));
        wrRenderBlocked();
    };
    window.wrRenderBlocked = function () {
        var el = document.getElementById('wrBlockedChips');
        if (!el) return;
        var b = wrBlocked(); var ids = Object.keys(b);
        el.innerHTML = ids.length
            ? '<span style="font-size:0.78rem;color:#adb5bd;font-weight:700;">🚫 차단:</span> ' + ids.map(function (cid) {
                return '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;background:#f8f9fa;color:#868e96;border-radius:14px;font-size:0.78rem;">'
                    + esc(b[cid]) + '<span onclick="wrUnblockChannel(\'' + cid + '\')" style="cursor:pointer;color:#1971c2;font-weight:800;">해제</span></span>';
            }).join(' ')
            : '';
    };

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
            // ★2토큰 규칙(2026-07-17 [로봇] 잡탕 실측 — 사용자 발견): 단어 1개만 겹치면 딴 소재가 섞임
            //   (현대차 조지아·삼성 전고체·농업로봇이 '로봇' 하나로 합쳐짐). 리드(최고시속) 영상과
            //   공유 토큰 2개+ 인 멤버만 같은 파도로 인정 — 나머지는 풀에 남겨 단독 파도 기회 유지.
            var lead = members.slice().sort(function (a, b) { return vph(items[b]) - vph(items[a]); })[0];
            var leadToks = {};
            wrTokens(items[lead].title).forEach(function (t2) { leadToks[t2] = 1; });
            members = members.filter(function (i) {
                if (i === lead) return true;
                var shared = wrTokens(items[i].title).filter(function (t2) { return leadToks[t2]; }).length;
                return shared >= 2;
            });
            if (members.length < 2) return;
            members.forEach(function (i) { assigned[i] = 1; });
            clusters.push({ label: tk, idx: members });
        });
        // 홀로 남았어도 강한 신호면 단독 파도로 — 신규 파도 조기 감지
        // ★2026-07-17 정정 2회: ①배수 5+만 쓰면 대형 채널 대박 누락(김재민 조지아 2.6배, 사용자 발견)
        //   ②"3일 이내" 이중 필터가 691배 괴물(주린이 공안 월급, 7일)까지 증발시킴(누락 감사 실측).
        //   신선도 판정은 배지(🔥/💀) 몫 — 수집 단계에서 숨기지 않는다. 기준 = 히트 기준과 동일.
        items.forEach(function (it, i) {
            if (assigned[i]) return;
            if (it.mult >= 3 || (it.viewCount >= 30000 && it.mult >= 1.5)) {
                clusters.push({ label: wrTokens(it.title)[0] || it.channelTitle, idx: [i], solo: true });
            }
        });
        return clusters;
    }

    // ---------- 배지 판정 (소재게이트 v2와 같은 잣대) ----------
    function wrJudgeCluster(c, items) {
        var vids = c.idx.map(function (i) { return items[i]; });
        // ★숲 포화도(2026-07-17 사용자 발견): 2토큰 규칙이 큰 파도를 조각내면 조각만 보고 🔥 오판
        //   (에어컨 10일·참전 8인데 김재민+카피캣 조각이 "첫 히트 2일·참전 2"로 신선해 보임).
        //   같은 소재 단어를 제목에 쓴 영상을 파도 경계 무시하고 전체에서 센다 — 4개+면 판이 붐빔.
        var forest = items.filter(function (v) { return (v.title || '').indexOf(c.label) >= 0; }).length;
        // ★결 필터 2차 정정(2026-07-17): 처음엔 광각 채널 전체를 📡로 강등했으나 사용자 정정 —
        //   "작은 채널 떡상=소재의 힘=먹잇감"([[feedback_small_channel_viral_prey]] 원칙). 채널 출신이
        //   아니라 '장르'가 문제였음(국제커플 브이로그 등). 장르 차단은 수집 단계(WR_GENRE_BLOCK)로 이동.
        var hasTracked = true;
        // 히트 기준(2026-07-17 정정): 조회수만 크고 그 채널 평소보다 못한 영상(삼프로 53만=평소의 0.2배)은
        // 히트가 아님 — 배수 3+ 이거나, 3만+이면서 최소 평소 이상(1.5배+)이어야 소재의 힘으로 인정
        var hits = vids.filter(function (v) { return v.mult >= 3 || (v.viewCount >= 30000 && v.mult >= 1.5); });
        var sumVph = vids.reduce(function (s, v) { return s + vph(v); }, 0);
        var newest = Math.min.apply(null, vids.map(function (v) { return ageDays(v.publishedAt); }));
        var badge, cls, why;
        if (!hasTracked) {
            badge = '📡 광각 발견'; cls = 'wr-scout';
            var bestM = Math.max.apply(null, vids.map(function (v) { return v.mult; }));
            why = '추적채널 밖(등록 563개 그물)에서 발견 — 최고 배수 ' + bestM.toFixed(1) + '배. 우리 결(국가·기업 스토리)인지 눈으로 확인 후 판단. 결이 맞고 세면 그 채널을 추적 목록에 추가';
            var text0 = vids.map(function (v) { return v.title; }).join(' ');
            var axis0 = '';
            if (AXIS_KR.some(function (w) { return text0.indexOf(w) >= 0; })) axis0 = WR_AXIS_LABELS.A.label;
            else if (AXIS_CN.some(function (w) { return text0.indexOf(w) >= 0; })) axis0 = WR_AXIS_LABELS.B.label;
            return { badge: badge, cls: cls, why: why, sumVph: vids.reduce(function (s, v) { return s + vph(v); }, 0), axis: axis0 };
        }
        if (!hits.length) {
            badge = '👀 관찰'; cls = 'wr-watch';
            why = '아직 터진 영상 없음(3만+/배수3+ 미달) — 오르면 알림판에 올라옴';
        } else {
            var firstHitAge = Math.max.apply(null, hits.map(function (v) { return ageDays(v.publishedAt); }));
            var newestHitAge = Math.min.apply(null, hits.map(function (v) { return ageDays(v.publishedAt); }));
            var copies = vids.length;
            if (firstHitAge > 13 || newest > 4) {
                badge = '💀 지났다'; cls = 'wr-dead';
                why = '첫 히트 ' + firstHitAge.toFixed(0) + '일 경과' + (newest > 4 ? ' · 최근 4일간 신규 없음' : '') + ' — 파도 끝';
            } else if (forest >= 4) {
                badge = '⚠️ 새각도 필수'; cls = 'wr-warm';
                why = "'" + c.label + "' 단어를 쓴 영상이 전체 " + forest + '개 — 이 조각은 신선해 보여도 소재 판 전체가 붐빔. 같은 얘기 재탕은 사망, 빈 각도만 생존';
            } else if (firstHitAge <= 3 && copies <= 3) {
                badge = '🔥 지금 타라'; cls = 'wr-hot';
                why = '첫 히트 ' + firstHitAge.toFixed(1) + '일 전 · 참전 ' + copies + '개(히트 ' + hits.length + ') — 48시간 내 제작하면 파도 위';
            } else if (newestHitAge <= 2 && copies <= 3) {
                // ★재점화(2026-07-17 감사): 옛 히트에 끌려 신선한 새 히트까지 ⚠️ 받던 결함
                //   (조지아 1일짜리가 10일 된 로봇 영상과 묶여 늙은 판정). 최신 히트가 2일 내 + 참전 적으면 🔥.
                badge = '🔥 지금 타라'; cls = 'wr-hot';
                why = '재점화 — 최신 히트 ' + newestHitAge.toFixed(1) + '일 전 · 참전 ' + copies + '개(히트 ' + hits.length + '). 새 불씨가 방금 붙음, 48시간 내 제작';
            } else {
                // ★참전≠경쟁(2026-07-17 사용자 관찰): 못 뜬 아류는 실경쟁이 아님 — 히트 수로 재탕 위험 판정
                if (hits.length <= 2) {
                    badge = '⚠️ 새각도 필수'; cls = 'wr-warm';
                    why = '첫 히트 ' + firstHitAge.toFixed(0) + '일 · 참전 ' + copies + '개(진짜 히트 ' + hits.length + '개) — 히트작에 없는 다음 궁금증으로만 진입';
                } else {
                    badge = '⚠️ 새각도 필수'; cls = 'wr-warm';
                    why = '첫 히트 ' + firstHitAge.toFixed(0) + '일 · 히트 ' + hits.length + '개 포함 참전 ' + copies + '개 — 판이 붐빔. 같은 얘기 재탕은 사망, 원본에 없는 다음 궁금증만 생존';
                }
            }
        }
        // 축 태그
        var text = vids.map(function (v) { return v.title; }).join(' ');
        var axis = '';
        if (AXIS_KR.some(function (w) { return text.indexOf(w) >= 0; })) axis = WR_AXIS_LABELS.A.label;
        else if (AXIS_CN.some(function (w) { return text.indexOf(w) >= 0; })) axis = WR_AXIS_LABELS.B.label;
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
                    if (WR_GENRE_BLOCK.test(v.title || '')) return; // 생활·연예 장르 컷
                    if (wrBlocked()[ch.id]) return; // 사용자 차단 채널
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
                var cat = (br.categories || {})[WR_CAT] || {};
                // ★14일 축적(2026-07-17): 브리핑은 24시간 창이라, 매 스캔마다 그날 수확 전량('videos',
                //   없으면 rising+viral)을 로컬에 쌓아 14일치 광각 그물을 만든다 — 업계 DB 방식의 경량판.
                var todays = (cat.videos && cat.videos.length) ? cat.videos : (cat.rising || []).concat(cat.viral || []);
                var hist = {};
                try { hist = JSON.parse(localStorage.getItem(WR_BRIEF_KEY) || '{}'); } catch (e2) {}
                todays.forEach(function (b) { if (b && b.videoId) hist[b.videoId] = b; });
                // 14일 지난 항목 청소 + 저장
                Object.keys(hist).forEach(function (k) {
                    if (ageDays(hist[k].publishedAt) > DAYS) delete hist[k];
                });
                try { localStorage.setItem(WR_BRIEF_KEY, JSON.stringify(hist)); } catch (e3) {}
                // ★광각 채널 진짜 중앙값(2026-07-17): 효율(조회÷구독) 근사는 유령구독 채널의 대박을
                //   쪽박으로 오판(구독10만·평소5천 채널이 3만 터뜨리면 실제 6배인데 근사 0.3배 → 히트 탈락).
                //   광각 채널도 실제 최근 영상 중앙값을 계산 — 채널당 2유닛, 7일 캐시, 스캔당 신규 30개 상한.
                var medCache = {};
                try { medCache = JSON.parse(localStorage.getItem('wave_ch_median_v1') || '{}'); } catch (e4) {}
                var histArr = Object.keys(hist).map(function (k) { return hist[k]; });
                var needMed = [];
                histArr.forEach(function (b) {
                    var mc = medCache[b.channelId];
                    if (!mc || Date.now() - mc.at > 7 * 86400000) {
                        if (needMed.indexOf(b.channelId) < 0) needMed.push(b.channelId);
                    }
                });
                var MED_CAP = 60; // 2026-07-17 상향: 563채널 전체 배수 계산이 본체(사용자 확정) — 채널당 2유닛
                for (var mi = 0; mi < Math.min(needMed.length, MED_CAP); mi++) {
                    var cid2 = needMed[mi];
                    st.textContent = '광각 채널 평소성적 계산 (' + (mi + 1) + '/' + Math.min(needMed.length, MED_CAP) + ')...';
                    try {
                        var pl2 = await fetchYouTubeAPI('playlistItems', { part: 'contentDetails,snippet', playlistId: 'UU' + cid2.slice(2), maxResults: 30 });
                        var vv = (pl2.items || []).map(function (it) {
                            return { id: it.contentDetails.videoId, d: it.contentDetails.videoPublishedAt || it.snippet.publishedAt };
                        });
                        var ids2 = vv.map(function (x) { return x.id; }).join(',');
                        if (ids2) {
                            var vr2 = await fetchYouTubeAPI('videos', { part: 'statistics', id: ids2, maxResults: 50 });
                            var sm = {};
                            (vr2.items || []).forEach(function (x) { sm[x.id] = parseInt((x.statistics || {}).viewCount || '0'); });
                            var matured2 = vv.filter(function (x) { var a = ageDays(x.d); return a >= 3 && a <= 90 && sm[x.id] != null; })
                                .map(function (x) { return sm[x.id]; });
                            medCache[cid2] = { at: Date.now(), med: Math.max(1, median(matured2.length >= 5 ? matured2 : vv.map(function (x) { return sm[x.id] || 0; }))) };
                        }
                    } catch (e5) { medCache[cid2] = { at: Date.now(), med: 0 }; }
                }
                try { localStorage.setItem('wave_ch_median_v1', JSON.stringify(medCache)); } catch (e6) {}
                if (needMed.length > MED_CAP) {
                    console.log('[파도레이더] 광각 중앙값 미계산 채널 ' + (needMed.length - MED_CAP) + '개 — 다음 스캔에서 이어서');
                }
                var seen = {};
                allItems.forEach(function (it) { seen[it.videoId] = 1; });
                histArr.forEach(function (b) {
                    if (seen[b.videoId]) return; seen[b.videoId] = 1;
                    if (ageDays(b.publishedAt) > DAYS) return;
                    // 데일리 방송 녹화·라이브 재방은 소재가 아님 (삼프로 '오전 방송 전체보기' 류)
                    if (/전체보기|풀버전|다시보기|라이브|LIVE|생방송|모닝브리핑|마감시황|시황/i.test(b.title || '')) return;
                    if (WR_GENRE_BLOCK.test(b.title || '')) return; // 생활·연예 장르 컷 ([남자] 브이로그 사고)
                    if (wrBlocked()[b.channelId]) return; // 사용자 차단 채널
                    allItems.push({
                        videoId: b.videoId, title: b.title, publishedAt: b.publishedAt,
                        channelId: b.channelId, channelTitle: b.channelTitle + ' ⚡',
                        viewCount: b.viewCount || 0, likeCount: 0, commentCount: 0,
                        thumbnail: b.thumbnail || '',
                        subscriberCount: b.subscriberCount || 0,
                        efficiency: b.efficiency || 0,
                        chMedian: (medCache[b.channelId] || {}).med || 0,
                        // 진짜 중앙값이 있으면 그걸로, 없으면(상한 초과분) 효율 근사 — 다음 스캔에서 채워짐
                        mult: ((medCache[b.channelId] || {}).med > 0)
                            ? (b.viewCount || 0) / medCache[b.channelId].med
                            : (b.efficiency || 1)
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
        lines.push('※ 이 판정은 "진행형 사건" 가정 — 끝난 옛날 얘기(완결형: 과거 참사·역사물)면 원본이 수요를 이미 소비해서 후발 재탕 사망. 만들기 전에 "내일도 새 뉴스가 나올 얘기인가" 한 번만 자문할 것.');
        var judged = {
            "실측": {
                "레퍼런스_업로드일": lead.publishedAt.slice(0, 10),
                "레퍼런스_조회수": lead.viewCount,
                "레퍼런스_구독자수": lead.subscriberCount,
                "판정일": new Date().toISOString().slice(0, 10)
            },
            "시의성": { "판정": "진행형", "근거": "파도 레이더 실측 — 참전 " + copies + "개, 합산 시속 " + sumVphNow + "회", "새각도": "" },
            // 제목·썸네일 벤치용(2026-07-17): 검증된 훅 구조를 SEO 단계가 벤치마킹(표현 복사 금지, 구조만).
            // 근거: 같은 소재로 골고루 7만 vs 우리 400 — 간판이 승부를 가름.
            "히트작_제목들": vids.filter(function (v) { return v.mult >= 3 || (v.viewCount >= 30000 && v.mult >= 1.5); })
                .slice(0, 3).map(function (v) { return v.title + " (" + fmtN(v.viewCount) + "회·" + v.mult.toFixed(0) + "배)"; }),
            "레퍼런스_URL": "https://www.youtube.com/watch?v=" + lead.videoId
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

    function wrCardHtml(v, withJudge) {
        // 큼지막·한눈에 (2026-07-17 사용자 요청: 썸네일·글자 확대, 공백 압축, 배수=색깔 알약)
        var a = ageDays(v.publishedAt);
        var ageTxt = a < 1 ? Math.round(a * 24) + '시간 전' : Math.round(a) + '일 전';
        var multCls = v.mult >= 10 ? 'wrm-hot' : (v.mult >= 3 ? 'wrm-warm' : 'wrm-cold');
        var multTxt = v.mult >= 10 ? Math.round(v.mult) : v.mult.toFixed(1);
        var isHit = v.mult >= 3 || (v.viewCount >= 30000 && v.mult >= 1.5);
        return '<div>'
            + '<div class="wr-card" onclick="window.open(\'https://www.youtube.com/watch?v=' + v.videoId + '\')">'
            + (v.thumbnail ? '<img class="wr-thumb" src="' + v.thumbnail + '" loading="lazy">' : '<div class="wr-thumb"></div>')
            + '<div class="wr-body">'
            + '<div class="wr-title">' + esc(v.title) + '</div>'
            + '<div class="wr-meta"><span class="wr-ch">' + esc(v.channelTitle) + '</span><span>' + ageTxt + '</span>'
            + '<b class="wr-views">' + fmtN(v.viewCount) + '회</b></div>'
            + '<div class="wr-pills"><span class="wr-mult ' + multCls + '">평소의 ' + multTxt + '배</span>'
            + '<span class="wr-vph">시속 ' + fmtN(Math.round(vph(v))) + '</span>'
            + (withJudge ? '<button onclick="event.stopPropagation();wrVideoJudge(\'' + v.videoId + '\')" style="padding:5px 12px;background:#0ca678;color:white;border:none;border-radius:9px;font-size:0.82rem;font-weight:700;cursor:pointer;">⚖️ 판정</button>' : '')
            + (isHit ? '<button onclick="event.stopPropagation();wrVideoQ(\'' + v.videoId + '\')" style="padding:5px 12px;background:#5f3dc4;color:white;border:none;border-radius:9px;font-size:0.82rem;font-weight:700;cursor:pointer;">💬 시청자 질문</button>' : '')
            + '</div>'
            + '</div></div>'
            + '<div id="wrVJ_' + v.videoId + '" style="display:none;background:#f0faf5;border:1px solid #c3e6d4;border-radius:12px;padding:12px;margin:-4px 0 8px;"></div>'
            + '<div id="wrQ_' + v.videoId + '" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:12px;margin:-4px 0 8px;"></div>'
            + '</div>';
    }

    // 💥 리더보드 행 (2026-07-17 — 순위 크게, 배수가 주인공. 클릭=액션 메뉴(URL복사·차단 등), 바로 이동 안 함)
    function wrBangRow(v, rank) {
        var a = ageDays(v.publishedAt);
        var ageTxt = a < 1 ? Math.round(a * 24) + '시간 전' : Math.round(a) + '일 전';
        var rcls = rank === 1 ? ' r1' : (rank === 2 ? ' r2' : (rank === 3 ? ' r3' : ''));
        var multTxt = v.mult >= 10 ? Math.round(v.mult).toLocaleString() : v.mult.toFixed(1);
        var act = "wrActions('" + v.videoId + "')";
        return '<div class="wr-row">'
            + '<div class="wr-rank' + rcls + '">' + rank + '</div>'
            + (v.thumbnail ? '<img class="wr-row-thumb" src="' + v.thumbnail + '" loading="lazy" onclick="' + act + '">' : '<div class="wr-row-thumb"></div>')
            + '<div class="wr-row-body">'
            + '<div class="wr-row-title" onclick="' + act + '">' + esc(v.title) + '</div>'
            + '<div class="wr-row-meta"><b>' + esc(v.channelTitle) + '</b> · ' + ageTxt + ' · 조회 <b>' + fmtN(v.viewCount) + '</b> · 시속 ' + fmtN(Math.round(vph(v))) + '</div>'
            + '</div>'
            + '<div class="wr-row-metric"><div class="wr-row-mult' + (v.mult >= 30 ? '' : ' cool') + '">' + multTxt + '배</div><div class="wr-row-vph">평소 대비</div></div>'
            + '<div class="wr-row-btns">'
            + '<button class="wr-btn-sm wr-btn-judge" onclick="event.stopPropagation();wrVideoJudge(\'' + v.videoId + '\')">⚖️ 판정</button>'
            + '<button class="wr-btn-sm wr-btn-q" onclick="event.stopPropagation();wrVideoQ(\'' + v.videoId + '\')">💬 질문</button>'
            + '</div></div>'
            + '<div id="wrAct_' + v.videoId + '" style="display:none;background:#f8f9fa;border:1px solid #e9ecef;border-radius:12px;padding:10px 12px;margin:0 0 8px 68px;"></div>'
            + '<div id="wrVJ_' + v.videoId + '" style="display:none;background:#f0faf5;border:1px solid #c3e6d4;border-radius:12px;padding:12px;margin:0 0 8px 68px;"></div>'
            + '<div id="wrQ_' + v.videoId + '" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:12px;margin:0 0 8px 68px;"></div>';
    }

    // 클릭 액션 메뉴 (2026-07-17 사용자 요청 — 카드 클릭시 영상으로 바로 튀지 않게)
    window.wrActions = function (vid) {
        var cache = wrCache(); if (!cache) return;
        var v = cache.items.find(function (x) { return x.videoId === vid; });
        var box = document.getElementById('wrAct_' + vid);
        if (!v || !box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        var url = 'https://www.youtube.com/watch?v=' + vid;
        var bs = 'padding:8px 16px;border:none;border-radius:9px;font-size:0.85rem;font-weight:800;cursor:pointer;';
        box.style.display = '';
        box.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
            + '<button style="' + bs + 'background:#1971c2;color:white;" onclick="window.open(\'' + url + '\')">▶ 영상 열기</button>'
            + '<button style="' + bs + 'background:#e7f0fb;color:#1971c2;" onclick="navigator.clipboard.writeText(\'' + url + '\').then(function(){alert(\'URL 복사됨\')})">📋 URL 복사</button>'
            + '<button style="' + bs + 'background:#fff5f5;color:#c92a2a;" onclick="if(confirm(\'' + esc(v.channelTitle).replace(/'/g, '') + ' 채널을 차단할까요? 앞으로 레이더에 안 나옵니다\')){wrBlockChannel(\'' + v.channelId + '\',\'' + esc(v.channelTitle).replace(/'/g, '') + '\')}">🚫 이 채널 차단</button>'
            + '<button style="' + bs + 'background:#e6f7ee;color:#0ca678;" onclick="window.open(\'https://www.youtube.com/channel/' + v.channelId + '/videos\')">📺 채널 들어가기</button>'
            + '<button style="' + bs + 'background:#f3f0ff;color:#5f3dc4;" onclick="var chs=JSON.parse(localStorage.getItem(\'wave_channels_v1\')||\'[]\');if(!chs.some(function(c){return c.id===\'' + v.channelId + '\'})){chs.push({id:\'' + v.channelId + '\',name:\'' + esc(v.channelTitle).replace(/'/g, '').replace(' ⚡', '') + '\'});localStorage.setItem(\'wave_channels_v1\',JSON.stringify(chs));wrRenderChannels();alert(\'추적 목록에 추가됨\')}else{alert(\'이미 추적 중\')}">⭐ 추적 추가</button>'
            + '<button style="' + bs + 'background:#f1f3f5;color:#495057;" onclick="navigator.clipboard.writeText(' + JSON.stringify(JSON.stringify(v.title)) + ').then(function(){alert(\'제목 복사됨\')})">제목 복사</button>'
            + '</div>';
    };

    // ⚖️ 영상 단독 판정 (2026-07-17 — 사용자: "파도 묶음 필요 없다, 소재가 중요" → 대박 카드에서 바로 판정)
    window.wrVideoJudge = function (vid) {
        var cache = wrCache(); if (!cache) return;
        var v = cache.items.find(function (x) { return x.videoId === vid; });
        var box = document.getElementById('wrVJ_' + vid);
        if (!v || !box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        var el = Math.floor(ageDays(v.publishedAt));
        // 참전 추정: 제목 토큰 2개+ 겹치는 다른 영상 수 (같은 소재를 몇 명이 건드렸나)
        var myToks = {}; wrTokens(v.title).forEach(function (t) { myToks[t] = 1; });
        var copies = cache.items.filter(function (x) {
            if (x.videoId === vid) return false;
            return wrTokens(x.title).filter(function (t) { return myToks[t]; }).length >= 2;
        }).length + 1;
        var verdict, lines = [];
        var demandOk = v.mult >= 3 || (v.viewCount >= 30000 && v.mult >= 1.5);
        if (!demandOk) { verdict = '⛔ 폐기 권고'; lines.push('수요 미증명 — 평소의 ' + v.mult.toFixed(1) + '배.'); }
        else if (el >= 14) { verdict = '⛔ 폐기 권고'; lines.push('선점 실기 — ' + el + '일 경과(2주+).'); }
        else if (el >= 3 || copies >= 4) {
            verdict = '⚠️ 새각도 조건부 진행';
            lines.push(el + '일 경과 · 같은 소재 건드린 영상 ' + copies + '개 — 원본에 없는 다음 궁금증으로만.');
        } else {
            verdict = '✅ 진행 (48시간 내)';
            lines.push(el + '일 · ' + fmtN(v.viewCount) + '회 · 평소의 ' + v.mult.toFixed(1) + '배 · 참전 ' + copies + '개 — 초입.');
        }
        lines.push('※ 완결형(끝난 옛날 얘기)이면 무효 — "내일도 새 뉴스 나올 얘기인가" 자문.');
        var judged = {
            "실측": { "레퍼런스_업로드일": v.publishedAt.slice(0, 10), "레퍼런스_조회수": v.viewCount, "레퍼런스_구독자수": v.subscriberCount, "판정일": new Date().toISOString().slice(0, 10) },
            "시의성": { "판정": "진행형", "근거": "레이더 실측 — 평소의 " + v.mult.toFixed(1) + "배, 참전 " + copies + "개", "새각도": "" },
            "히트작_제목들": [v.title + " (" + fmtN(v.viewCount) + "회·" + v.mult.toFixed(0) + "배)"],
            "레퍼런스_URL": "https://www.youtube.com/watch?v=" + vid
        };
        box.style.display = '';
        box.innerHTML = '<div style="font-weight:800;margin-bottom:6px;">' + verdict + '</div>'
            + lines.map(function (l) { return '<div style="font-size:0.85rem;color:#555;margin-bottom:4px;">· ' + esc(l) + '</div>'; }).join('')
            + '<button onclick="navigator.clipboard.writeText(document.getElementById(\'wrVJ_' + vid + '\').dataset.judged).then(function(){alert(\'복사됨 — 클로드에게 붙여넣고 작업 시작\')})" style="margin-top:6px;padding:6px 14px;background:#1971c2;color:white;border:none;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;">📋 실측 JSON 복사</button>';
        box.dataset.judged = JSON.stringify(judged, null, 2);
    };

    // 💬 시청자 질문 (2026-07-17 리워크 — 파도 묶음이 아니라 "터진 영상 하나"의 댓글만, 안내 한 줄 포함)
    // 사용자 피드백: 파도 통짜 묶음은 잡탕·용도불명. 뉴스 매칭도 품질 낮아 제거.
    window.wrVideoQ = async function (vid) {
        var box = document.getElementById('wrQ_' + vid);
        if (!box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; return; } // 토글
        box.style.display = '';
        box.innerHTML = '<span style="color:#b45309;font-weight:700;">이 영상의 댓글에서 질문 수집 중...</span>';
        try {
            var qs = [];
            var cr = await fetchYouTubeAPI('commentThreads', { part: 'snippet', videoId: vid, order: 'relevance', maxResults: 100, textFormat: 'plainText' });
            (cr.items || []).forEach(function (it) {
                var s = it.snippet.topLevelComment.snippet;
                var txt = String(s.textDisplay || '').replace(/\s+/g, ' ').trim();
                if (txt.length < 8 || txt.length > 220) return;
                if (!/[?？]|궁금|왜 |어떻게 |얼마나 |그럼 |다음엔|우리나라는|한국은/.test(txt)) return;
                qs.push({ t: txt, likes: parseInt(s.likeCount || 0) });
            });
            qs.sort(function (a, b) { return b.likes - a.likes; });
            box.innerHTML = '<div style="font-weight:800;margin-bottom:8px;">💬 이 영상 시청자들이 직접 묻는 것 (좋아요순) — <span style="color:#b45309;">이 중 하나가 우리 다음 영상 제목감. 골라서 클로드에게 "이 각도로 작업 시작"</span></div>'
                + (qs.length ? qs.slice(0, 8).map(function (q) {
                    return '<div style="font-size:0.9rem;margin-bottom:5px;background:white;border-radius:8px;padding:8px 10px;">' + esc(q.t) + ' <b style="color:#e8590c;">👍' + q.likes + '</b></div>';
                }).join('') : '<div style="color:#888;">질문형 댓글이 없음 — 이 영상엔 각도 단서가 없으니 뉴스에서 새 국면을 찾는 쪽 권장</div>');
        } catch (e) {
            box.innerHTML = '<span style="color:#dc3545;">댓글 수집 실패(' + esc(e.message) + ') — 댓글 막힌 영상일 수 있음</span>';
        }
    };

    function wrRender(items, clusters) {
        var listEl = document.getElementById('wrList');
        if (!listEl) return;
        if (!clusters.length) { listEl.innerHTML = '<p style="color:#888;">최근 14일 파도 없음 — 채널을 추가하거나 다시 스캔하세요.</p>'; return; }
        var scored = clusters.map(function (c, i) {
            var j = wrJudgeCluster(c, items);
            c.sumVphView = j.sumVph;
            return { c: c, j: j, i: i };
        });
        // 정렬: 🔥 먼저, 그 안에서 합산 시속 순 (📡 광각은 ⚠️ 다음)
        var order = { 'wr-hot': 0, 'wr-warm': 1, 'wr-scout': 2, 'wr-watch': 3, 'wr-dead': 4 };
        scored.sort(function (a, b) {
            if (order[a.j.cls] !== order[b.j.cls]) return order[a.j.cls] - order[b.j.cls];
            return b.j.sumVph - a.j.sumVph;
        });
        // ★💥 대박 소재 최우선 표시(2026-07-17 사용자: "내가 보는 건 대박 터진 소재 찾기, 그게 최우선")
        //   파도 묶음과 무관하게, 최근 7일 내 '평소 대비 폭발'한 영상을 배수 순으로 맨 위에 깐다.
        var bangs = items.filter(function (v) { return v.mult >= 3 && ageDays(v.publishedAt) <= 7; })
            .sort(function (a, b) { return b.mult - a.mult; }).slice(0, 20);
        var bangHtml = bangs.length
            ? '<div class="wr-bang">'
            + '<div class="wr-bang-head"><span class="wr-bang-title">💥 대박 소재 순위</span>'
            + '<span class="wr-bang-sub">채널 평소 조회수 대비 몇 배 터졌나 — 최근 7일 · 등록채널 전체</span></div>'
            + bangs.map(function (v, bi) { return wrBangRow(v, bi + 1); }).join('')
            + '</div>'
            : '';
        var axisFilter = (document.getElementById('wrAxisFilter') || {}).value || '';
        var visible = scored.filter(function (s) {
            if (!axisFilter) return true;
            return s.j.axis.indexOf(axisFilter) >= 0;
        });
        // ★침묵 잘림 방지(2026-07-17 감사): 상한 25 + 잘리면 몇 개 숨겼는지 명시
        var CAP = 25;
        var cutNote = visible.length > CAP
            ? '<p style="color:#868e96;font-size:0.85rem;margin:8px 0;">파도 ' + visible.length + '개 중 상위 ' + CAP + '개 표시 — 숨겨진 ' + (visible.length - CAP) + '개는 대부분 💀·👀 (배지 순 정렬)</p>'
            : '';
        listEl.innerHTML = bangHtml + cutNote + visible.slice(0, CAP).map(function (s) {
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
        + '.wr-wave.wr-scout-wave{border-left:5px solid #9775fa;opacity:.9;}'
        + '.wr-badge.wr-scout{background:#f3f0ff;color:#5f3dc4;}'
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
        + '.wr-vph{font-size:0.85rem;color:#1971c2;font-weight:700;}'
        // 💥 대박 리더보드 (2026-07-17 — 순위+큼지막+차분한 배색, 배수가 주인공)
        + '.wr-bang{background:white;border:1px solid #ececec;border-radius:16px;padding:6px 18px 10px;margin-bottom:18px;box-shadow:0 2px 10px rgba(0,0,0,.05);}'
        + '.wr-bang-head{display:flex;align-items:baseline;gap:12px;padding:12px 4px 8px;border-bottom:2px solid #f1f3f5;}'
        + '.wr-bang-title{font-size:1.25rem;font-weight:900;letter-spacing:-0.5px;}'
        + '.wr-bang-sub{font-size:0.82rem;color:#adb5bd;}'
        + '.wr-row{display:flex;align-items:center;gap:16px;padding:14px 4px;border-bottom:1px solid #f4f4f4;}'
        + '.wr-row:last-child{border-bottom:none;}'
        + '.wr-rank{width:52px;text-align:center;font-size:1.7rem;font-weight:900;color:#ced4da;flex-shrink:0;font-style:italic;}'
        + '.wr-rank.r1{color:#fa5252;font-size:2rem;}'
        + '.wr-rank.r2{color:#ff922b;font-size:1.85rem;}'
        + '.wr-rank.r3{color:#fab005;}'
        + '.wr-row-thumb{width:200px;height:112px;object-fit:cover;border-radius:12px;flex-shrink:0;background:#f1f3f5;cursor:pointer;}'
        + '.wr-row-body{flex:1;min-width:0;}'
        + '.wr-row-title{font-weight:800;font-size:1.08rem;line-height:1.4;color:#212529;cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
        + '.wr-row-title:hover{color:#1971c2;}'
        + '.wr-row-meta{font-size:0.85rem;color:#adb5bd;margin-top:6px;}'
        + '.wr-row-meta b{color:#495057;font-weight:700;}'
        + '.wr-row-metric{width:130px;text-align:right;flex-shrink:0;}'
        + '.wr-row-mult{font-size:1.45rem;font-weight:900;color:#fa5252;letter-spacing:-0.5px;}'
        + '.wr-row-mult.cool{color:#e8590c;}'
        + '.wr-row-vph{font-size:0.8rem;color:#868e96;margin-top:2px;}'
        + '.wr-row-btns{display:flex;flex-direction:column;gap:6px;flex-shrink:0;}'
        + '.wr-btn-sm{padding:7px 14px;border:none;border-radius:9px;font-size:0.82rem;font-weight:800;cursor:pointer;white-space:nowrap;}'
        + '.wr-btn-judge{background:#e6f7ee;color:#0ca678;}'
        + '.wr-btn-judge:hover{background:#0ca678;color:white;}'
        + '.wr-btn-q{background:#f3f0ff;color:#5f3dc4;}'
        + '.wr-btn-q:hover{background:#5f3dc4;color:white;}'
        + '@media(max-width:900px){.wr-row{flex-wrap:wrap;}.wr-row-thumb{width:150px;height:84px;}}';

    // ---------- 장르 토글 (경제 ⇄ 역사) ----------
    function wrPaintGenreToggle() {
        var e = document.getElementById('wrGenreEcon'), h = document.getElementById('wrGenreHist');
        if (!e || !h) return;
        var on = 'background:#1971c2;color:#fff;', off = 'background:#fff;color:#868e96;';
        e.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;font-weight:700;' + (WR_GENRE === '경제' ? on : off);
        h.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;border-left:1px solid #dee2e6;font-weight:700;' + (WR_GENRE === '역사' ? on : off);
    }
    function wrRebuildAxisOptions() {
        var sel = document.getElementById('wrAxisFilter');
        if (!sel) return;
        sel.innerHTML = '<option value="">전체 축</option>'
            + '<option value="' + WR_AXIS_LABELS.A.key + '">' + WR_AXIS_LABELS.A.label + '만</option>'
            + '<option value="' + WR_AXIS_LABELS.B.key + '">' + WR_AXIS_LABELS.B.label + '만</option>';
    }
    window.wrSetGenre = function (g) {
        if ((g === '역사' ? '역사' : '경제') === WR_GENRE) return; // 같은 장르 클릭 무시
        wrApplyGenre(g);
        wrPaintGenreToggle();
        wrRebuildAxisOptions();
        // 장르별 격리된 상태로 화면 갱신 — 추적채널·차단·캐시 전부 새 장르 것으로
        wrRenderChannels(); wrRenderBlocked();
        var st = document.getElementById('wrStatus');
        var cache = wrCache();
        if (cache) { wrRerenderFromCache(); }
        else {
            var el = document.getElementById('wrList'); if (el) el.innerHTML = '';
            if (st) st.textContent = (WR_GENRE === '역사' ? '📜 역사' : '💹 경제') + ' 모드 — 아직 스캔 없음. 🌊 파도 스캔을 눌러주세요.';
        }
    };

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
            + '      <div id="wrGenreToggle" style="display:inline-flex;border:1px solid #dee2e6;border-radius:8px;overflow:hidden;font-size:0.8rem;font-weight:700;">'
            + '        <button id="wrGenreEcon" onclick="wrSetGenre(\'경제\')" style="padding:6px 12px;border:none;cursor:pointer;">💹 경제</button>'
            + '        <button id="wrGenreHist" onclick="wrSetGenre(\'역사\')" style="padding:6px 12px;border:none;cursor:pointer;border-left:1px solid #dee2e6;">📜 역사</button>'
            + '      </div>'
            + '      <select id="wrAxisFilter" onchange="wrRerender()" style="padding:6px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:0.8rem;">'
            + '        <option value="">전체 축</option>'
            + '        <option value="' + WR_AXIS_LABELS.A.key + '">' + WR_AXIS_LABELS.A.label + '만</option>'
            + '        <option value="' + WR_AXIS_LABELS.B.key + '">' + WR_AXIS_LABELS.B.label + '만</option>'
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
            + '    <div id="wrBlockedChips" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;"></div>'
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
                    if (p === 'radar') { wrPaintGenreToggle(); wrRenderChannels(); wrRenderBlocked(); wrRerenderFromCache(); }
                } catch (e) {}
                return r;
            };
            patched._wrPatched = true;
            window.switchProcess = patched;
        }
        wrPaintGenreToggle();
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
