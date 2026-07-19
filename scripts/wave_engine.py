# -*- coding: utf-8 -*-
"""파도 엔진 — 소재 묶기(클러스터링) + 타이밍 판정. 순수 함수만 (API 호출 없음, 테스트 가능).

★2026-07-19 전면 재설계 (리서치 3종 근거):
- 계산은 전부 서버(이 모듈, Actions 데일리 배치)에서 하고 브라우저는 그리기만
  (업계 표준 git-scraping 패턴: simonwillison.net/2020/Oct/9/git-scraping).
- 소재 묶기 = Kiwi 형태소 명사 추출 기반. 기존 JS 토크나이저의 고질병
  (조사 변형 "댐이/댐을" 분리, 표기 변형, 불용어 블랙리스트 군비경쟁)을 형태소 층에서 해결.
  임베딩(ko-sroberta)은 데일리 배치에 torch 500MB라 보류 — 제목 클러스터링은
  고유명사 겹침이 지배적이라 명사 기반으로 충분(리서치 ② 결론).
- 판정 기준은 여기 CONFIG 한 곳에만 존재 — 배지와 게이트 판정이 어긋나는 자기모순
  (배지=첫 히트 나이, 게이트=리드 나이로 따로 계산하던 버그)을 구조적으로 차단.

판정 근거 실측 (CLAUDE.md 소재게이트 v2와 동일):
- 후발 페널티: 같은 소재 선발 36.3만 vs 후발 8.8천 (41배)
- 완결형 스토리는 3일이면 소비 끝, 진행형 파도는 3~13일이면 '새 각도'만 생존
- 영상 수명주기: 뉴스성 60%+가 초반 폭발 후 power-law 감쇠, 3일차 이후 미래와 선형
  (icwsm15 "Lifecycle of a YouTube Video", arxiv 2507.21187)
"""
import math
import re
from datetime import datetime, timezone

# ── 판정 설정 (단일 진실원 — 숫자를 바꾸려면 여기만) ──
CONFIG = {
    "hit_mult": 3.0,          # 히트 = 평소의 3배+ (업계 통념: 2x 주목/3x 유의미/5x 진짜)
    "hit_views_alt": 30000,   # 또는 조회 3만+ 이면서
    "hit_mult_alt": 1.5,      #    평소의 1.5배+
    "fresh_days": 3,          # 첫 히트 3일 이내 = 초입 (완결형 소비 3일 실측)
    "dead_days": 13,          # 첫 히트 13일+ = 지났다
    "stale_upload_days": 4,   # 신규 업로드 4일+ 끊김 = 식는 중
    "crowded": 4,             # 참전 채널 4개+ = 포화 (후발 41배 손해)
    "min_shared_nouns": 2,    # 같은 파도 = 리드와 명사 2개+ 공유
    "idf_cut": 0.12,          # 전체 영상 12% 초과 등장 명사는 씨앗 자격 박탈
    "single_min_mult": 3.0,   # 단독 영상도 3배+면 단독 파도로 승격
}

# 씨앗 자격이 없는 범용 명사 (형태소 분석 후에도 남는 장르 공통어 — 최소한만)
_STOP_NOUNS = set("""
이유 진짜 충격 소름 실체 정체 결국 지금 오늘 사실 논란 공개 최초 세계 전세계 난리 발칵
이것 진실 비밀 경고 역대급 대박 초유 언론 몰락 위기 정부 국민 대통령 회장 상황 사태
속보 발표 시작 결말 최후 현재 반전 근황 최악 최고 최대 전부 나라 국가 도시 사람 국민들
전쟁 교수 박사 대표 소장 위원 기자 앵커 작가 전문가 인터뷰 대담 강연 특집 총정리 요약
한국 중국 미국 일본 유럽 인도 러시아 북한 기업 경제 회사 문제 사건 내막 방송 오전 오후
폭락 하락 상승 급등 급락 전망 주식 코스피 증시 시장 투자 신호 공장 산업 제품 가격 돈
수출 수입 역사 세계사 한국사 이야기 실화 미스터리 다큐 스토리 그날 당시 시대 인물 전설
영상 채널 유튜브 구독 조회수 편 년 월 일 시간 분 초 억 조 원 달러 개 명 번 위 배
태도 급변 변화 수급 전략 변동 대응 매매 계좌 개미 종목 시황 특집 분석 해설 정리 핵심
월요일 화요일 수요일 목요일 금요일 토요일 일요일 주말 내일 어제 이번주 다음주
""".split())

# 데일리 방송 재방·라이브·수면낭독 = 소재가 아니라 형식 (잡파도 차단.
#  수면/오디오북류는 에버그린 실물검사에서 '오디오' 잡탕 클러스터로 실측 — 구 wave_radar 차단 목록 계승)
_JUNK_TITLE = re.compile(
    r"전체보기|풀버전|다시보기|본방송|라이브|LIVE|생방송|모닝브리핑|마감시황|아침시황"
    r"|수면|자장가|잠들기|잠잘 때|잘 때 듣|꿀잠|숙면|백색소음|asmr|오디오북|낭독|읽어드리|읽어주는|몰아보기", re.I)

try:
    from kiwipiepy import Kiwi
    _kiwi = Kiwi()
except Exception:
    _kiwi = None  # 로컬에 kiwi 없으면 정규식 폴백 (Actions에는 pip 설치됨)


def extract_nouns(title):
    """제목 → 소재 명사 집합. Kiwi 있으면 형태소(NNG/NNP/SL), 없으면 정규식 폴백."""
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", title or "")  # [1부]·(feat...) 제거
    nouns = []
    if _kiwi:
        for tok in _kiwi.tokenize(t):
            if tok.tag in ("NNG", "NNP", "SL") and len(tok.form) >= 2:
                nouns.append(tok.form.lower())
    else:
        for w in re.findall(r"[가-힣A-Za-z0-9]{2,}", t):
            w = re.sub(r"(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터)$", "", w)
            if len(w) >= 2:
                nouns.append(w.lower())
    return [n for n in nouns if n not in _STOP_NOUNS and not n.isdigit()]


def _age_days(pub_iso, now):
    try:
        return (now - datetime.fromisoformat(pub_iso.replace("Z", "+00:00"))).total_seconds() / 86400
    except Exception:
        return 999


def is_hit(v):
    m = v.get("mult") or 0
    return m >= CONFIG["hit_mult"] or (
        (v.get("viewCount") or 0) >= CONFIG["hit_views_alt"] and m >= CONFIG["hit_mult_alt"])


def cluster(videos, anchor_pct=None):
    """영상 목록 → 파도 목록. 각 파도 = {label, video_idx:[...], seed_nouns}.
    방식: 명사 2개+ 공유 그리디(리드=조회수 최다 영상이 멤버를 선점). IDF컷으로 범용어 배제.
    anchor_pct(★2026-07-19 에버그린 실물검사에서 추가): 공유 명사 중 최소 1개는
    전체의 anchor_pct 이하로 드문 '닻' 단어여야 함 — '삼성'·'세종' 같은 니치 초고빈도
    단어 2개만으로 다른 소재가 한 덩어리로 붙던 오묶임 차단. None이면 미적용(브리핑
    14일 풀은 시간·소재가 좁아 불필요, 장기 에버그린 풀에서만 필요)."""
    n = len(videos)
    if n == 0:
        return []
    noun_sets = [set(extract_nouns(v.get("title", ""))) for v in videos]
    # IDF컷: 너무 흔한 명사는 씨앗·공유 판정 양쪽에서 제외
    freq = {}
    for s in noun_sets:
        for w in s:
            freq[w] = freq.get(w, 0) + 1
    # 하한 5: 풀이 작을 때 진짜 씨앗(파도 전체가 공유하는 단어)까지 잘라내는 것 방지
    cut = max(5, math.ceil(n * CONFIG["idf_cut"]))
    sig_sets = [set(w for w in s if freq.get(w, 0) <= cut) for s in noun_sets]
    anchor_cut = max(3, math.ceil(n * anchor_pct)) if anchor_pct else None

    def same_wave(a, b):
        shared = sig_sets[a] & sig_sets[b]
        if len(shared) < CONFIG["min_shared_nouns"]:
            return False
        if anchor_cut is not None and min(freq.get(w, 0) for w in shared) > anchor_cut:
            return False  # 흔한 단어들끼리만 겹침 = 접착제 오묶임
        return True

    order = sorted(range(n), key=lambda i: -(videos[i].get("viewCount") or 0))
    assigned = [False] * n
    waves = []
    for li in order:
        if assigned[li] or not sig_sets[li]:
            continue
        members = [li]
        assigned[li] = True
        for j in order:
            if assigned[j]:
                continue
            if same_wave(li, j):
                members.append(j)
                assigned[j] = True
        if len(members) >= 2:
            shared = set(sig_sets[members[0]])
            for m in members[1:]:
                shared &= sig_sets[m]
            label_pool = shared or sig_sets[li]
            label = " ".join(sorted(label_pool, key=lambda w: -freq.get(w, 0))[:3])
            waves.append({"label": label, "video_idx": members})
        else:
            assigned[li] = False  # 혼자면 배정 취소 — 아래 단독 대박 승격 루프가 다시 본다
    # 단독 대박 승격 (묶이진 않았지만 평소의 3배+ = 그 자체로 소재)
    for i in range(n):
        if not assigned[i] and (videos[i].get("mult") or 0) >= CONFIG["single_min_mult"]:
            label = " ".join(list(sig_sets[i])[:3]) or (videos[i].get("title") or "")[:20]
            waves.append({"label": label, "video_idx": [i]})
            assigned[i] = True
    return waves


def judge(wave, videos, now):
    """파도 하나 판정 — 배지·이유·게이트 초안이 전부 이 한 곳에서 나옴 (기준 이원화 금지).
    반환: {verdict: hot|angle|dead|watch, badge, why, hits, entrants, first_hit_days, latest_days}"""
    vs = [videos[i] for i in wave["video_idx"]]
    hits = [v for v in vs if is_hit(v)]
    entrants = len({v.get("channelId") for v in vs})
    ages = [_age_days(v.get("publishedAt", ""), now) for v in vs]
    latest_days = round(min(ages), 1) if ages else 999
    hit_ages = [_age_days(v.get("publishedAt", ""), now) for v in hits]
    first_hit_days = round(max(hit_ages), 1) if hit_ages else None
    latest_hit_days = round(min(hit_ages), 1) if hit_ages else None
    lead = max(vs, key=lambda v: v.get("mult") or 0) if vs else None
    growth = None  # 클러스터 조회 성장률 (전일 스냅샷 있는 영상만)
    gs = [v["growth"] for v in vs if v.get("growth") is not None]
    if gs:
        growth = round(sum(gs) / len(gs), 3)

    C = CONFIG
    if not hits:
        r = ("watch", "👀 관망", "히트 없음 — 평소 대비 %.1f배가 최고. 수요 미증명." % max((v.get("mult") or 0) for v in vs))
    elif first_hit_days > C["dead_days"]:
        r = ("dead", "💀 지났다", "첫 히트가 %d일 전 — 완결 소비 끝났을 가능성. 후발 41배 손해 실측." % int(first_hit_days))
    elif latest_days > C["stale_upload_days"] and entrants >= 2:
        r = ("dead", "💀 식었다", "%d일째 신규 참전 없음 — 파도가 꺼지는 중." % int(latest_days))
    elif entrants >= C["crowded"]:
        r = ("angle", "⚠️ 새 각도만", "이미 %d개 채널 참전 — 같은 각도 후발은 41배 손해. 새 각도 필수." % entrants)
    elif first_hit_days <= C["fresh_days"]:
        r = ("hot", "🔥 지금 타라", "첫 히트 %.1f일 전 · 참전 %d개뿐 — 초입." % (first_hit_days, entrants))
    elif latest_hit_days is not None and latest_hit_days <= 2:
        r = ("hot", "🔥 재점화", "최신 히트 %.1f일 전 — 파도가 다시 붙는 중. 참전 %d개." % (latest_hit_days, entrants))
    else:
        r = ("angle", "⚠️ 새 각도만", "첫 히트 %.1f일 — 초입(3일)은 지남. 새 각도라야 생존." % first_hit_days)

    verdict, badge, why = r
    if growth is not None and growth > 0.3 and verdict != "dead":
        why += " 어제보다 조회 +%d%% 성장 중." % int(growth * 100)
    return {
        "verdict": verdict, "badge": badge, "why": why,
        "hits": len(hits), "entrants": entrants,
        "firstHitDays": first_hit_days, "latestDays": latest_days,
        "growth": growth,
        "leadVideoId": lead.get("videoId") if lead else None,
        "leadMult": lead.get("mult") if lead else None,
    }


def build_waves(videos, now=None):
    """영상 풀 → 판정 붙은 파도 목록 (verdict 우선순위 → 리드 배수 순 정렬)."""
    now = now or datetime.now(timezone.utc)
    videos = [v for v in videos if not _JUNK_TITLE.search(v.get("title") or "")]
    ws = cluster(videos)
    out = []
    for w in ws:
        j = judge(w, videos, now)
        out.append({"label": w["label"], "videoIds": [videos[i]["videoId"] for i in w["video_idx"]], **j})
    prio = {"hot": 0, "angle": 1, "watch": 2, "dead": 3}
    out.sort(key=lambda w: (prio.get(w["verdict"], 9), -(w["leadMult"] or 0)))
    return out
