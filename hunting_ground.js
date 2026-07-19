// ============================================================
// 🌊 오늘의 사냥터 — 파도 레이더 v2 (2026-07-19 전면 재설계)
// ============================================================
// 원칙 (리서치 3종 근거 — 상용툴 UX 조사 · 깃허브 구현 조사 · 구버전 코드 진단):
//   1. 계산은 전부 서버(daily_briefing.py + wave_engine.py, 매일 06:30) — 여기는 그리기만.
//      스캔 버튼·대기시간·클라 API 지출 없음. 열자마자 결과. (git-scraping 패턴)
//   2. 카드 하나에 정보 3개만: 판정 배지(🔥/⚠️/💀) · 평소의 N배 · 며칠 됐나.
//      구버전의 개념 15종(시속·화살표·축·효율·이중판정...)은 삭제 — "감이 안 잡힘"의 원인.
//   3. 판정은 서버 wave_engine.CONFIG 단일 진실원 — 배지와 게이트 판정이 절대 안 어긋남.
//   4. 발견→제작 원클릭: 카드에서 바로 📋 대본 시작 / ⚖️ 게이트 JSON (업계 공통 UX).
// 구버전 wave_radar.js는 참고용으로 저장소에 남김 (index.html에서 제외됨).
// 전역 의존: escapeHtml, formatNumber, copyPipelineCmd, _blockedCh, blockChannelFromCard, switchProcess
(function () {
    'use strict';

    var HG_DATA = null;   // briefing.json 통째
    var HG_EVER = null;   // evergreen.json 통째 (♻️ 탭 처음 열 때 로드)
    var HG_GENRE = null;  // '경제' | '역사' — 탭 열 때 current_channel에서 파생 (별도 저장 안 함: 상태 분열 방지)
    var HG_TAB = 'waves'; // 'waves' | 'evergreen'
    var HG_SHOW_DEAD = false;

    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s || '') : String(s || ''); }
    function fmtN(v) { v = v || 0; return v >= 10000 ? (v / 10000).toFixed(1) + '만' : v.toLocaleString(); }
    function blocked() { try { return (typeof _blockedCh === 'function') ? _blockedCh() : {}; } catch (e) { return {}; } }
    function ageDays(iso) { return (Date.now() - new Date(iso)) / 86400000; }
    function ageTxt(iso) {
        var d = Math.floor(ageDays(iso));
        return d <= 0 ? '오늘' : d === 1 ? '어제' : d + '일 전';
    }

    // ---------- 데이터 ----------
    async function hgLoad() {
        var r = await fetch('briefing.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-store' });
        if (!r.ok) throw new Error('briefing.json 없음');
        HG_DATA = await r.json();
    }

    function hgCat() {
        var cats = (HG_DATA || {}).categories || {};
        return cats[HG_GENRE] || cats['경제'] || null;
    }

    // ---------- ♻️ 에버그린 영상 (별도 프로세스 탭) ----------
    async function hgOpenEver() {
        if (!HG_GENRE) {
            var cur = '';
            try { cur = localStorage.getItem('current_channel') || '경제'; } catch (e) { }
            HG_GENRE = cur.indexOf('역사') >= 0 ? '역사' : '경제';
        }
        hgPaintGenre();
        if (!HG_EVER) {
            var el = document.getElementById('hgEverList');
            if (el) el.innerHTML = '<p style="color:#888;padding:14px;">에버그린 금고 여는 중...</p>';
            try {
                var r = await fetch('evergreen.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-store' });
                if (r.ok) HG_EVER = await r.json();
            } catch (e) { }
        }
        hgRenderEvergreen();
    }

    function hgRenderEvergreen() {
        var listEl = document.getElementById('hgEverList');
        var stEl = document.getElementById('hgEverStatus');
        if (!listEl) return;
        if (!HG_EVER) {
            listEl.innerHTML = '<p style="color:#888;padding:14px;">에버그린 데이터가 아직 없어요 — 주간 스캔(월요일 아침)이 처음 돌면 생깁니다.</p>';
            return;
        }
        var cat = (HG_EVER.categories || {})[HG_GENRE] || (HG_EVER.categories || {})['경제'];
        if (!cat) { listEl.innerHTML = '<p style="color:#888;padding:14px;">이 장르 데이터가 없어요.</p>'; return; }
        var gen = new Date(HG_EVER.generatedAt);
        if (stEl) stEl.innerHTML = '주간 스캔: ' + (gen.getMonth() + 1) + '/' + gen.getDate()
            + ' · 검사한 영상 ' + (cat.scannedVideos || 0) + '개 · 배수 높은 순 — ♻️ 배지를 누르면 그 소재가 언제 또 터졌는지 펼쳐집니다';
        var blk = blocked();
        // ★영상 단위 평탄화(2026-07-19 사용자: "왜 사냥터처럼 묶어놨나") — 기본은 영상 리스트,
        //   재탕 근거(같은 소재의 다른 히트들)는 ♻️ 배지 클릭 시 펼침
        var rows = [], seen = {};
        (cat.remakes || []).forEach(function (rm, ri) {
            (rm.videos || []).forEach(function (v) {
                if (blk[v.channelId] || seen[v.videoId]) return;
                seen[v.videoId] = 1;
                rows.push({ v: v, rm: rm, ri: ri });
            });
        });
        // ★활동 중 소재 강등(2026-07-19 사용자 실물검사: 한화오션·삼성 조립주택 = 핫이슈 유입):
        //   최근 30일 내 히트가 있는 소재는 '진행형 사가'인지 에버그린인지 기계로 확정 불가(리서치 결론)
        //   → 조용한 검증 소재를 위로, 활동 중 소재는 경고 붙여 아래로.
        rows.forEach(function (x) { x.active = x.rm ? x.rm.lastHitDays < 30 : false; });
        rows.sort(function (a, b) {
            if (a.active !== b.active) return a.active ? 1 : -1;
            return (b.v.mult || 0) - (a.v.mult || 0);
        });
        // ★단독(재탕 미검증)은 기본 화면에서 제외, 접힌 참고 섹션으로 강등 (2026-07-19 사용자:
        //   "한 번 훅하고 꺼진 건 에버그린이 아니다" — 재탕 증명이 있는 것만 본편)
        var singles = (cat.singles || []).filter(function (v) { return !blk[v.channelId] && !seen[v.videoId]; });
        var quiet = rows.filter(function (x) { return !x.active; });
        var act = rows.filter(function (x) { return x.active; });
        var html = quiet.slice(0, 80).map(hgEverRow).join('')
            || '<p style="color:#888;padding:14px;">조용한 검증 소재가 아직 없어요.</p>';
        if (act.length) {
            html += '<div style="margin:18px 0 8px;padding:10px 14px;background:#fff9db;border:1.5px solid #f08c00;border-radius:10px;font-weight:800;color:#b45309;font-size:0.95rem;">'
                + '⚠️ 아래는 최근 30일 내 히트가 있는 "활동 중" 소재 — 에버그린 확정이 아니라 진행형 핫이슈일 수 있어요. 만들기 전에 ⏳수명판정 돌려보세요.</div>'
                + act.slice(0, 40).map(hgEverRow).join('');
        }
        if (singles.length) {
            html += '<div style="margin-top:14px;">'
                + '<button onclick="hgToggleSingles()" style="width:100%;padding:11px;background:#f1f3f5;border:1.5px solid #d0d4da;border-radius:10px;font-size:0.9rem;font-weight:700;color:#666;cursor:pointer;">'
                + (HG_EVER_SINGLES ? '▲ 접기' : '▼ 참고: 단독 대박 ' + singles.length + '개 (6개월+ 전 한 번 터짐 — 재탕은 아직 검증 안 됨)') + '</button>'
                + (HG_EVER_SINGLES ? '<div style="opacity:0.75;margin-top:8px;">' + singles.slice(0, 40).map(function (v) { return hgEverRow({ v: v }); }).join('') + '</div>' : '')
                + '</div>';
        }
        listEl.innerHTML = html;
    }
    var HG_EVER_SINGLES = false;
    window.hgToggleSingles = function () { HG_EVER_SINGLES = !HG_EVER_SINGLES; hgRenderEvergreen(); };

    function hgEverRow(x) {
        var v = x.v, rm = x.rm;
        var multTxt = v.mult >= 10 ? Math.round(v.mult) : (v.mult || 0).toFixed(1);
        var ageTxt2 = v.age >= 30 ? Math.round(v.age / 30) + '개월 전' : v.age + '일 전';
        var remakeBadge = rm
            ? '<button onclick="hgEverExpand(' + x.ri + ',\'' + v.videoId + '\')" style="padding:5px 12px;background:#0ca678;color:#fff;border:none;border-radius:8px;font-size:0.85rem;font-weight:800;cursor:pointer;">♻️ 이 소재 ' + rm.hits + '번 터짐 · ' + rm.channels + '채널 ▾</button>'
            : '<span class="stat-badge" style="font-size:0.82rem;">💎 단독 검증</span>';
        var hint = !rm ? ''
            : rm.lastHitDays < 30 ? '<span class="stat-badge" style="background:#f08c00;color:#fff;font-weight:800;">⚠️ 지금 활동 중인 소재(' + rm.lastHitDays + '일 전 히트) — 진행형 핫이슈일 수 있음, ⏳수명판정 필수</span>'
            : rm.saturated ? '<span class="stat-badge" style="background:#e03131;color:#fff;font-weight:700;">🚧 최근 2달 재탕 몰림 — 새 각도 필수</span>'
            : '<span class="stat-badge" style="background:#0ca678;color:#fff;font-weight:700;">✅ 조용한 검증 소재 — 재탕 기회</span>';
        // 🌲 감쇠곡선 신호: 90일+ 지난 영상이 지난주에도 조회수를 벎 = 수요 지속의 직접 증거
        var earning = (v.stillEarning || (rm && rm.earning))
            ? '<span class="stat-badge" style="background:#2f9e44;color:#fff;font-weight:700;">🌲 지금도 조회수 붙는 중' + (v.weekGain ? ' +' + fmtN(v.weekGain) + '/주' : '') + '</span>'
            : '';
        return '<div class="card" style="margin-bottom:10px;"><div class="card-inner">'
            + '<div style="display:flex;gap:14px;align-items:flex-start;padding:12px;">'
            + '<img src="' + v.thumbnail + '" loading="lazy" onclick="window.open(\'https://youtube.com/watch?v=' + v.videoId + '\',\'_blank\')" style="width:200px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;cursor:pointer;flex-shrink:0;">'
            + '<div style="flex:1;min-width:0;">'
            + '  <div style="font-weight:800;font-size:1.05rem;margin-bottom:4px;"><a href="https://youtube.com/watch?v=' + v.videoId + '" target="_blank" style="color:#222;text-decoration:none;">' + esc(v.title) + '</a></div>'
            + '  <div style="font-size:0.88rem;color:#888;margin-bottom:8px;">' + esc(v.channelTitle) + ' · 조회 ' + fmtN(v.viewCount) + ' · ' + ageTxt2 + '</div>'
            + '  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">'
            + '    <span class="stat-badge" style="background:#8b5cf6;color:#fff;font-weight:800;font-size:0.92rem;">💥 평소의 ' + multTxt + '배</span>'
            + remakeBadge + earning + hint
            + '  </div>'
            + '  <div style="display:flex;gap:8px;flex-wrap:wrap;">'
            + '    <button onclick="copyPipelineCmd(\'' + v.videoId + '\',this)" class="pipe-btn">📋 대본 명령</button>'
            + '    <button onclick="copyVideoPack(\'' + v.videoId + '\',this)" class="pipe-btn">💬 URL·제목·댓글</button>'
            + '    <button onclick="hgLifespanPrompt(this)" data-title="' + esc(v.title) + '" class="pipe-btn">⏳ 수명판정 복사</button>'
            + '    <button onclick="blockChannelFromCard(this)" data-cid="' + v.channelId + '" data-cname="' + esc(v.channelTitle) + '" class="pipe-btn" style="color:#c92a2a;">🚫 채널 차단</button>'
            + '  </div>'
            + (rm ? '<div id="hgEverX_' + x.ri + '_' + v.videoId + '" style="display:none;margin-top:10px;border-top:1px dashed #d0d4da;padding-top:8px;"></div>' : '')
            + '</div></div></div></div>';
    }

    // ⏳ 소재 수명판정 프롬프트 복사 — EverGreenQA(EMNLP 2025) 검증 문항 + 업계 체크리스트 기반.
    //   웹검색 없이 판정시키는 게 포인트(훈련 지식만으로 안정적으로 답해지면 = 에버그린 프록시)
    window.hgLifespanPrompt = function (btn) {
        var title = btn.dataset.title || '';
        var p = '너는 유튜브 롱폼 소재의 수명을 판정하는 분석가다. 웹검색 없이 판단해라.\n\n'
            + '소재(레퍼런스 제목): ' + title + '\n\n'
            + '아래 5문항에 각각 예/아니오 + 근거 1줄로 답한 뒤 최종 판정해라:\n'
            + '1. 완결성: 이 이야기는 결말이 이미 나왔는가? (진행 중이면 뉴스성)\n'
            + '2. 답 불변성: 핵심 전말·답이 1년 뒤 바뀔 수 있는가?\n'
            + '3. 트리거 독립: 특정 날짜·이벤트·시세가 끝나면 존재 이유가 사라지는가?\n'
            + '4. 수요 지속: 1년 뒤에도 이 질문(왜/어떻게 됐나)을 검색할 사람이 있는가?\n'
            + '5. 날짜 제거: 제목에서 시점 표현을 빼도 성립하는가?\n\n'
            + '최종 출력(JSON): {"판정":"evergreen|semi-evergreen|news","확신도":0~1,'
            + '"에버그린_전환_조건":"news면 어떤 조건 충족 시 에버그린 되는지 1줄","근거":[문항별 1줄]}';
        navigator.clipboard.writeText(p).then(function () {
            var t = btn.textContent;
            btn.textContent = '✓ 복사됨 — 클로드에 붙여넣기';
            setTimeout(function () { btn.textContent = t; }, 3000);
        });
    };

    // ♻️ 배지 클릭 → 그 소재의 다른 히트들(재탕 이력) 펼침
    window.hgEverExpand = function (ri, vid) {
        var cat = (HG_EVER && HG_EVER.categories) ? ((HG_EVER.categories[HG_GENRE] || HG_EVER.categories['경제'])) : null;
        if (!cat) return;
        var rm = (cat.remakes || [])[ri];
        var box = document.getElementById('hgEverX_' + ri + '_' + vid);
        if (!rm || !box) return;
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        box.style.display = '';
        box.innerHTML = '<div style="font-size:0.85rem;color:#666;font-weight:700;margin-bottom:6px;">♻️ [' + esc(rm.label) + '] 재탕 이력 — 첫 히트와 마지막 히트 간격 ' + Math.round(rm.gapDays / 30) + '개월</div>'
            + (rm.videos || []).map(function (o) {
                var me = o.videoId === vid ? 'background:#fff9db;' : '';
                return '<div style="display:flex;gap:10px;align-items:center;padding:5px 4px;font-size:0.92rem;' + me + 'border-radius:6px;">'
                    + '<img src="' + o.thumbnail + '" loading="lazy" style="width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:5px;flex-shrink:0;">'
                    + '<a href="https://youtube.com/watch?v=' + o.videoId + '" target="_blank" style="flex:1;min-width:0;color:#444;text-decoration:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;">' + esc(o.title) + '</a>'
                    + '<span style="flex-shrink:0;color:#8b5cf6;font-weight:700;">' + (o.mult || 0).toFixed(1) + '배</span>'
                    + '<span style="flex-shrink:0;color:#666;">' + fmtN(o.viewCount) + '회</span>'
                    + '<span style="flex-shrink:0;color:#999;">' + (o.age >= 30 ? Math.round(o.age / 30) + '개월 전' : o.age + '일 전') + '</span></div>';
            }).join('');
    };

    // ---------- 렌더 ----------
    function hgRender() {
        var listEl = document.getElementById('hgList');
        var stEl = document.getElementById('hgStatus');
        if (!listEl) return;
        var cat = hgCat();
        if (!cat) { listEl.innerHTML = '<p style="color:#888;padding:14px;">데이터가 아직 없어요 — 내일 아침 6:30 스캔 후 생깁니다.</p>'; return; }

        // 신선도 표시 + 낡음 경고 (Actions 침묵 실패 대비)
        var gen = new Date(HG_DATA.generatedAt);
        var hrs = Math.round((Date.now() - gen) / 3600000);
        stEl.innerHTML = '서버 스캔: ' + (gen.getMonth() + 1) + '/' + gen.getDate() + ' '
            + String(gen.getHours()).padStart(2, '0') + ':' + String(gen.getMinutes()).padStart(2, '0')
            + ' · 14일 풀 ' + (cat.pool || (cat.videos || []).length) + '개'
            + (hrs > 36 ? ' <b style="color:#e03131;">⚠️ ' + hrs + '시간 전 데이터 — 서버 스캔이 멈췄을 수 있음</b>' : '');

        var vidMap = {};
        (cat.videos || []).forEach(function (v) { vidMap[v.videoId] = v; });
        var blk = blocked();
        var waves = (cat.waves || []).map(function (w) {
            // 차단 채널 영상 제거 후 재구성 (전부 차단이면 파도 자체 숨김)
            var vids = w.videoIds.map(function (id) { return vidMap[id]; })
                .filter(function (v) { return v && !blk[v.channelId]; });
            return vids.length ? { w: w, vids: vids } : null;
        }).filter(Boolean);

        if (!waves.length) {
            listEl.innerHTML = '<p style="color:#888;padding:14px;">'
                + (cat.waves ? '표시할 파도가 없어요.' : '파도 데이터가 아직 없어요 — 내일 아침 스캔부터 생성됩니다. (오늘은 아래 개별 영상 순위를 보세요)')
                + '</p>' + hgFallbackOutliers(cat, blk);
            return;
        }

        var live = waves.filter(function (x) { return x.w.verdict === 'hot' || x.w.verdict === 'angle'; });
        var dead = waves.filter(function (x) { return x.w.verdict === 'dead' || x.w.verdict === 'watch'; });

        var html = live.map(hgWaveCard).join('')
            || '<p style="color:#888;padding:14px;">지금 탈 만한 파도가 없어요 — 전부 지났거나 수요 미증명.</p>';
        html += '<div style="margin-top:14px;">'
            + '<button onclick="hgToggleDead()" style="width:100%;padding:11px;background:#f1f3f5;border:1.5px solid #d0d4da;border-radius:10px;font-size:0.9rem;font-weight:700;color:#666;cursor:pointer;">'
            + (HG_SHOW_DEAD ? '▲ 접기' : '▼ 지난 파도·관망 ' + dead.length + '개 보기 (참고용 — 만들지 마세요)') + '</button>'
            + (HG_SHOW_DEAD ? '<div style="opacity:0.65;margin-top:8px;">' + dead.map(hgWaveCard).join('') + '</div>' : '')
            + '</div>';
        listEl.innerHTML = html;
    }

    // 파도 데이터가 없을 때(개편 첫날) 개별 영상 배수 순위로 대체
    function hgFallbackOutliers(cat, blk) {
        var rows = (cat.outlier || []).filter(function (v) { return !blk[v.channelId]; }).slice(0, 10);
        if (!rows.length) return '';
        return '<div class="section-content">' + rows.map(function (v) {
            return '<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid #f1f3f5;">'
                + '<img src="' + v.thumbnail + '" loading="lazy" style="width:170px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;">'
                + '<div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:0.9rem;">' + esc(v.title) + '</div>'
                + '<div style="font-size:0.88rem;color:#888;">' + esc(v.channelTitle) + ' · ' + fmtN(v.viewCount) + '회 · ' + ageTxt(v.publishedAt) + '</div></div>'
                + '<span class="stat-badge" style="background:#8b5cf6;color:#fff;font-weight:700;">💥 ' + (v.mult || 0).toFixed(1) + '배</span></div>';
        }).join('') + '</div>';
    }

    var VERDICT_STYLE = {
        hot: { bd: '#e03131', bg: '#fff5f5' },
        angle: { bd: '#f08c00', bg: '#fff9db' },
        watch: { bd: '#adb5bd', bg: '#f8f9fa' },
        dead: { bd: '#adb5bd', bg: '#f8f9fa' }
    };

    function hgWaveCard(x) {
        var w = x.w, vids = x.vids;
        var lead = vids.reduce(function (a, b) { return ((b.mult || 0) > (a.mult || 0)) ? b : a; }, vids[0]);
        var s = VERDICT_STYLE[w.verdict] || VERDICT_STYLE.watch;
        var multTxt = lead.mult ? (lead.mult >= 10 ? Math.round(lead.mult) : lead.mult.toFixed(1)) + '배' : '-';
        var wid = 'hg_' + lead.videoId;
        var members = vids.length > 1
            ? '<div style="margin-top:8px;border-top:1px dashed #e9ecef;padding-top:6px;">'
                + vids.filter(function (v) { return v.videoId !== lead.videoId; }).slice(0, 6).map(function (v) {
                    return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;font-size:0.95rem;color:#555;">'
                        + '<img src="' + v.thumbnail + '" loading="lazy" style="width:130px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;flex-shrink:0;">'
                        + '<a href="https://youtube.com/watch?v=' + v.videoId + '" target="_blank" style="flex:1;min-width:0;color:#555;text-decoration:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;">' + esc(v.title) + '</a>'
                        + '<span style="flex-shrink:0;color:#8b5cf6;font-weight:700;">' + (v.mult ? v.mult.toFixed(1) + '배' : '') + '</span>'
                        + '<span style="flex-shrink:0;color:#999;">' + ageTxt(v.publishedAt) + '</span></div>';
                }).join('') + '</div>'
            : '';
        return '<div style="border:2px solid ' + s.bd + ';background:' + s.bg + ';border-radius:14px;padding:14px;margin-bottom:12px;">'
            + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">'
            + '<span style="font-weight:900;font-size:1.15rem;">' + w.badge + '</span>'
            + '<span style="font-weight:800;font-size:1.05rem;color:#374151;">' + esc(w.label) + '</span>'
            + '<span style="font-size:0.8rem;color:#888;">참전 ' + w.entrants + '개 채널 · 히트 ' + w.hits + '개</span>'
            + '</div>'
            + '<div style="font-size:0.95rem;color:#555;margin-bottom:10px;">' + esc(w.why) + '</div>'
            + '<div style="display:flex;gap:12px;align-items:flex-start;">'
            + '  <img src="' + lead.thumbnail + '" loading="lazy" onclick="window.open(\'https://youtube.com/watch?v=' + lead.videoId + '\',\'_blank\')" style="width:260px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;cursor:pointer;flex-shrink:0;">'
            + '  <div style="flex:1;min-width:0;">'
            + '    <div style="font-weight:800;font-size:1.08rem;margin-bottom:4px;"><a href="https://youtube.com/watch?v=' + lead.videoId + '" target="_blank" style="color:#222;text-decoration:none;">' + esc(lead.title) + '</a></div>'
            + '    <div style="font-size:0.9rem;color:#888;margin-bottom:6px;">' + esc(lead.channelTitle) + ' · 조회 ' + fmtN(lead.viewCount) + ' · ' + ageTxt(lead.publishedAt) + '</div>'
            + '    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">'
            + '      <span class="stat-badge" style="background:#8b5cf6;color:#fff;font-weight:800;font-size:0.9rem;">💥 평소의 ' + multTxt + '</span>'
            + (w.growth != null && w.growth > 0.1 ? '<span class="stat-badge" style="background:#0ca678;color:#fff;font-weight:700;">📈 어제보다 +' + Math.round(w.growth * 100) + '%</span>' : '')
            + '    </div>'
            + '  </div>'
            + '</div>'
            + members
            + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
            + '  <button onclick="copyPipelineCmd(\'' + lead.videoId + '\',this)" style="padding:8px 16px;background:#1971c2;color:#fff;border:none;border-radius:8px;font-weight:800;font-size:0.86rem;cursor:pointer;">📋 대본 시작</button>'
            + '  <button onclick="hgGateJson(\'' + lead.videoId + '\',this)" style="padding:8px 16px;background:#495057;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:0.86rem;cursor:pointer;">⚖️ 게이트 JSON 복사</button>'
            + '  <button onclick="blockChannelFromCard(this)" data-cid="' + lead.channelId + '" data-cname="' + esc(lead.channelTitle) + '" style="padding:8px 12px;background:none;border:1px solid #e03131;color:#c92a2a;border-radius:8px;font-size:0.82rem;cursor:pointer;">🚫 채널 차단</button>'
            + '  <div id="' + wid + '_msg" style="align-self:center;font-size:0.8rem;color:#0ca678;font-weight:700;"></div>'
            + '</div>'
            + '</div>';
    }

    // ⚖️ 소재게이트 v2 실측 JSON — 판정 내용은 서버 계산값 그대로 (배지와 동일 기준 보장)
    window.hgGateJson = function (vid, btn) {
        var cat = hgCat(); if (!cat) return;
        var vidMap = {};
        (cat.videos || []).forEach(function (v) { vidMap[v.videoId] = v; });
        var v = vidMap[vid]; if (!v) return;
        var wave = (cat.waves || []).find(function (w) { return w.videoIds.indexOf(vid) >= 0; }) || {};
        var judged = {
            "실측": {
                "레퍼런스_업로드일": (v.publishedAt || '').slice(0, 10),
                "레퍼런스_조회수": v.viewCount,
                "레퍼런스_구독자수": v.subscriberCount,
                "평소대비_배수": v.mult,
                "판정일": new Date().toISOString().slice(0, 10)
            },
            "시의성": {
                "판정": wave.verdict === 'hot' ? '진행형·초입' : wave.verdict === 'angle' ? '진행형·새각도필수' : '지남/미증명',
                "근거": wave.why || ('평소의 ' + (v.mult || 0) + '배'),
                "참전": wave.entrants || 1,
                "새각도": ""
            },
            "히트작_제목들": (wave.videoIds || [vid]).map(function (id) {
                var x = vidMap[id]; if (!x) return null;
                return x.title + ' (' + fmtN(x.viewCount) + '회·' + (x.mult ? x.mult.toFixed(0) + '배' : '-') + ')';
            }).filter(Boolean),
            "레퍼런스_URL": "https://www.youtube.com/watch?v=" + vid,
            "주의": "완결형(끝난 옛날 얘기)이면 진행형 판정 무효 — 소재게이트에서 완결/진행 구분할 것"
        };
        navigator.clipboard.writeText(JSON.stringify(judged, null, 2)).then(function () {
            var m = document.getElementById('hg_' + vid + '_msg');
            if (m) { m.textContent = '✓ 복사됨 — 클로드에 붙여넣기'; setTimeout(function () { m.textContent = ''; }, 4000); }
        });
    };

    window.hgToggleDead = function () { HG_SHOW_DEAD = !HG_SHOW_DEAD; hgRender(); };

    // 채널 차단/해제 직후 index.html의 _rerenderAllLists()가 호출 — 사냥터도 즉시 갱신
    window.hgRerender = function () {
        if (HG_DATA && document.getElementById('hgList')) hgRender();
        // ♻️ 에버그린 리스트도 즉시 갱신 (2026-07-19: 사냥터와 동일 유형의 누락 — 차단 직후 반영 안 되던 구멍)
        if (HG_EVER && document.getElementById('hgEverList')) hgRenderEvergreen();
    };

    window.hgSetGenre = function (g) {
        HG_GENRE = g;
        hgPaintGenre();
        // ★두 탭 리스트 모두 재렌더(2026-07-19 버그: 에버그린 탭에서 역사 눌러도 사냥터만 다시 그려 화면 불변)
        hgRender();
        hgRenderEvergreen();
    };

    function hgPaintGenre() {
        var on = 'background:#1971c2;color:#fff;', off = 'background:#fff;color:#555;';
        // 사냥터·에버그린 두 탭의 토글 버튼 전부 칠함
        [['hgGenreEcon', 'hgGenreHist'], ['hgEverGenreEcon', 'hgEverGenreHist']].forEach(function (pair) {
            var e = document.getElementById(pair[0]), h = document.getElementById(pair[1]);
            if (!e || !h) return;
            e.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;font-weight:700;' + (HG_GENRE === '경제' ? on : off);
            h.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;font-weight:700;border-left:1px solid #dee2e6;' + (HG_GENRE === '역사' ? on : off);
        });
    }

    // ---------- 주입 (preempt_radar와 동일 패턴) ----------
    function setup() {
        var trendBtn = document.getElementById('procBtn_trend');
        if (trendBtn) {
            var btn = document.createElement('button');
            btn.className = 'process-btn inactive';
            btn.id = 'procBtn_radar';
            btn.innerHTML = '🌊 오늘의 사냥터';
            btn.onclick = function () { switchProcess('radar'); };
            trendBtn.insertAdjacentElement('afterend', btn);
            // ♻️ 에버그린 = 별도 사이드바 탭 (사냥터=지금 타이밍, 에버그린=시간 무관 소재 창고)
            var btn2 = document.createElement('button');
            btn2.className = 'process-btn inactive';
            btn2.id = 'procBtn_evergreen';
            btn2.innerHTML = '♻️ 에버그린 영상';
            btn2.onclick = function () { switchProcess('evergreen'); };
            btn.insertAdjacentElement('afterend', btn2);
        }
        var container = document.querySelector('.container');
        if (!container) return;
        var div = document.createElement('div');
        div.id = 'process-radar';
        div.style.display = 'none';
        div.innerHTML = ''
            + '<div class="section">'
            + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
            + '    <span>🌊 오늘의 사냥터 — 지금 만들 만한 소재</span>'
            + '    <div id="hgGenreToggle" style="display:inline-flex;border:1px solid #dee2e6;border-radius:8px;overflow:hidden;font-size:0.8rem;">'
            + '      <button id="hgGenreEcon" onclick="hgSetGenre(\'경제\')">💹 경제</button>'
            + '      <button id="hgGenreHist" onclick="hgSetGenre(\'역사\')">📜 역사</button>'
            + '    </div>'
            + '  </div>'
            + '  <div class="section-content">'
            + '    <p style="font-size:0.85rem;color:#888;margin-bottom:8px;">'
            + '      서버가 매일 아침 등록 채널 전체(14일치)를 스캔해 <b>같은 소재끼리 묶고</b> 판정을 붙입니다.'
            + '      🔥 지금 타라(터진 지 3일 내·참전 적음) / ⚠️ 새 각도만(이미 붐빔) / 💀 지났다.'
            + '      💥 배수 = 그 채널 <b>평소</b> 조회수 대비 몇 배 터졌나.'
            + '    </p>'
            + '    <div id="hgStatus" style="font-size:0.82rem;color:#1971c2;font-weight:600;margin-bottom:10px;"></div>'
            + '    <div id="hgList"><p style="color:#888;padding:14px;">불러오는 중...</p></div>'
            + '  </div>'
            + '</div>';
        container.appendChild(div);

        // ♻️ 에버그린 영상 컨테이너
        var div2 = document.createElement('div');
        div2.id = 'process-evergreen';
        div2.style.display = 'none';
        div2.innerHTML = ''
            + '<div class="section">'
            + '  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
            + '    <span>♻️ 에버그린 영상 — 재탕해도 또 터지는 검증 소재</span>'
            + '    <div style="display:inline-flex;border:1px solid #dee2e6;border-radius:8px;overflow:hidden;font-size:0.8rem;">'
            + '      <button id="hgEverGenreEcon" onclick="hgSetGenre(\'경제\')">💹 경제</button>'
            + '      <button id="hgEverGenreHist" onclick="hgSetGenre(\'역사\')">📜 역사</button>'
            + '    </div>'
            + '  </div>'
            + '  <div class="section-content">'
            + '    <p style="font-size:0.85rem;color:#888;margin-bottom:8px;">'
            + '      시사 이슈가 아니라 <b>언제 만들어도 터지는 소재</b>를 모읍니다. 주 1회(월요일 아침) 등록 채널 전체의 과거 영상을 훑어,'
            + '      ♻️ <b>재탕 검증</b>(같은 소재가 60일+ 간격으로 2번 이상 터짐 · 채널 3개+ 검증이면 🏆 최상급)과'
            + '      💎 <b>단독 에버그린</b>(30일+ 지났는데 같은 시기 영상들 평소의 5배+ · 조회 3만+)을 골라냅니다.'
            + '      🚧 최근 2달에 재탕이 몰린 소재는 포화 경고가 붙어요.'
            + '    </p>'
            + '    <div id="hgEverStatus" style="font-size:0.82rem;color:#0ca678;font-weight:600;margin-bottom:10px;"></div>'
            + '    <div id="hgEverList"><p style="color:#888;padding:14px;">불러오는 중...</p></div>'
            + '  </div>'
            + '</div>';
        container.appendChild(div2);

        var orig = window.switchProcess;
        if (typeof orig === 'function' && !orig._hgPatched) {
            var patched = function (p) {
                var r = orig.apply(this, arguments);
                try {
                    var el = document.getElementById('process-radar');
                    if (el) el.style.display = (p === 'radar') ? '' : 'none';
                    var b = document.getElementById('procBtn_radar');
                    if (b) b.classList.toggle('inactive', p !== 'radar');
                    var el2 = document.getElementById('process-evergreen');
                    if (el2) el2.style.display = (p === 'evergreen') ? '' : 'none';
                    var b2 = document.getElementById('procBtn_evergreen');
                    if (b2) b2.classList.toggle('inactive', p !== 'evergreen');
                    if (p === 'radar') hgOpen();
                    if (p === 'evergreen') hgOpenEver();
                } catch (e) { }
                return r;
            };
            patched._hgPatched = true;
            window.switchProcess = patched;
        }
    }

    async function hgOpen() {
        // 장르 = 앱 전체 채널 선택에서 파생 (상태 분열 방지 — 구버전은 따로 저장해 브리핑과 어긋났음)
        if (!HG_GENRE) {
            var cur = '';
            try { cur = localStorage.getItem('current_channel') || '경제'; } catch (e) { }
            HG_GENRE = cur.indexOf('역사') >= 0 ? '역사' : '경제';
        }
        hgPaintGenre();
        if (!HG_DATA) {
            try { await hgLoad(); } catch (e) {
                var el = document.getElementById('hgList');
                if (el) el.innerHTML = '<p style="color:#e03131;padding:14px;">briefing.json을 못 읽었어요: ' + esc(e.message) + '</p>';
                return;
            }
        }
        hgRender();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
