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
    var HG_GENRE = null;  // '경제' | '역사' — 탭 열 때 current_channel에서 파생 (별도 저장 안 함: 상태 분열 방지)
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
                + '<img src="' + v.thumbnail + '" loading="lazy" style="width:104px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;">'
                + '<div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:0.9rem;">' + esc(v.title) + '</div>'
                + '<div style="font-size:0.78rem;color:#888;">' + esc(v.channelTitle) + ' · ' + fmtN(v.viewCount) + '회 · ' + ageTxt(v.publishedAt) + '</div></div>'
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
                    return '<div style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:0.82rem;color:#555;">'
                        + '<img src="' + v.thumbnail + '" loading="lazy" style="width:64px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;flex-shrink:0;">'
                        + '<a href="https://youtube.com/watch?v=' + v.videoId + '" target="_blank" style="flex:1;min-width:0;color:#555;text-decoration:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;">' + esc(v.title) + '</a>'
                        + '<span style="flex-shrink:0;color:#8b5cf6;font-weight:700;">' + (v.mult ? v.mult.toFixed(1) + '배' : '') + '</span>'
                        + '<span style="flex-shrink:0;color:#999;">' + ageTxt(v.publishedAt) + '</span></div>';
                }).join('') + '</div>'
            : '';
        return '<div style="border:2px solid ' + s.bd + ';background:' + s.bg + ';border-radius:14px;padding:14px;margin-bottom:12px;">'
            + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">'
            + '<span style="font-weight:900;font-size:1.02rem;">' + w.badge + '</span>'
            + '<span style="font-weight:800;color:#374151;">' + esc(w.label) + '</span>'
            + '<span style="font-size:0.8rem;color:#888;">참전 ' + w.entrants + '개 채널 · 히트 ' + w.hits + '개</span>'
            + '</div>'
            + '<div style="font-size:0.86rem;color:#555;margin-bottom:10px;">' + esc(w.why) + '</div>'
            + '<div style="display:flex;gap:12px;align-items:flex-start;">'
            + '  <img src="' + lead.thumbnail + '" loading="lazy" onclick="window.open(\'https://youtube.com/watch?v=' + lead.videoId + '\',\'_blank\')" style="width:168px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;cursor:pointer;flex-shrink:0;">'
            + '  <div style="flex:1;min-width:0;">'
            + '    <div style="font-weight:700;font-size:0.95rem;margin-bottom:3px;"><a href="https://youtube.com/watch?v=' + lead.videoId + '" target="_blank" style="color:#222;text-decoration:none;">' + esc(lead.title) + '</a></div>'
            + '    <div style="font-size:0.8rem;color:#888;margin-bottom:6px;">' + esc(lead.channelTitle) + ' · 조회 ' + fmtN(lead.viewCount) + ' · ' + ageTxt(lead.publishedAt) + '</div>'
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

    window.hgSetGenre = function (g) {
        HG_GENRE = g;
        hgPaintGenre();
        hgRender();
    };

    function hgPaintGenre() {
        var e = document.getElementById('hgGenreEcon'), h = document.getElementById('hgGenreHist');
        if (!e || !h) return;
        var on = 'background:#1971c2;color:#fff;', off = 'background:#fff;color:#555;';
        e.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;font-weight:700;' + (HG_GENRE === '경제' ? on : off);
        h.style.cssText = 'padding:6px 12px;border:none;cursor:pointer;font-weight:700;border-left:1px solid #dee2e6;' + (HG_GENRE === '역사' ? on : off);
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

        var orig = window.switchProcess;
        if (typeof orig === 'function' && !orig._hgPatched) {
            var patched = function (p) {
                var r = orig.apply(this, arguments);
                try {
                    var el = document.getElementById('process-radar');
                    if (el) el.style.display = (p === 'radar') ? '' : 'none';
                    var b = document.getElementById('procBtn_radar');
                    if (b) b.classList.toggle('inactive', p !== 'radar');
                    if (p === 'radar') hgOpen();
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
