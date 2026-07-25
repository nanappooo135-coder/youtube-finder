#!/usr/bin/env python3
"""
구글 트렌드 급상승 검색어(KR) 전체 + 구글 연결 기사 → trends.json 저장
GitHub Actions에서 10분마다 자동 실행됨 (fetch-news.yml에 포함).

★v2 (2026-07-26): RSS(상위 10개 한계) → 트렌드 웹UI 내부 API(batchexecute)로 교체.
  - i0OFE: 지난 24h 급상승 전체(~200개) + 검색량 + 급등시각 + 구글 공식 카테고리
  - w4opAf: 구글이 각 키워드에 연결한 뉴스 기사 (제목·URL·언론사·시각)
  - 경제 판별 1순위 = 구글 공식 카테고리(3=비즈니스/금융), 2순위 = 자체 어휘 휴리스틱
  - RSS는 API 실패 시 폴백
- 네이버 뉴스: high 등급 키워드만 보강 (호출량 절약) — 키 없으면 스킵
- 이력(history): 실행마다 검색량 스냅샷 누적 → 프론트 스파크라인
환경변수(선택): NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
"""
import os
import json
import re
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

TRENDS_RSS = "https://trends.google.co.kr/trending/rss?geo=KR"
BATCH_URL = "https://trends.google.com/_/TrendsUi/data/batchexecute"
HISTORY_RETENTION_MS = 48 * 3600 * 1000  # 48시간
MAX_HISTORY_POINTS = 300
NAVER_ENRICH_CAP = 20      # high 등급 네이버 보강 상한 (호출량 보호)
ARTICLE_TIERS = ("high", "mid")  # 구글 기사(w4opAf)를 붙일 등급

# ── 구글 공식 카테고리 (2026-07-26 KR 실측으로 역추적 검증) ──────────
# 3=비즈니스(투자·브로드컴·현대·택배기사·일용직), 17=스포츠(베헨 비스바덴 대 바이에른),
# 4=연예(고윤정·소지섭), 14=정치(조국혁신당), 20=날씨(météo) 확인됨
TOPIC_NAMES = {
    1: "자동차", 2: "뷰티", 3: "비즈니스", 4: "연예", 5: "푸드",
    6: "게임", 7: "건강", 8: "취미", 9: "교육", 10: "법·행정",
    11: "기타", 12: "동물", 13: "여행?", 14: "정치", 15: "과학",
    16: "교통", 17: "스포츠", 18: "테크", 19: "쇼핑?", 20: "날씨",
}
TOPIC_ECON_HIGH = {3}            # 구글이 비즈니스/금융으로 태그 → 💰직결
TOPIC_ECON_MID = {18, 15, 5}     # 테크·과학·푸드(원자재) → 💡연관 후보
TOPIC_NOISE = {17, 4, 20, 6}     # 스포츠·연예·날씨·게임 → 강한 경제 신호 없으면 low

# ── 경제성 판정 어휘 (휴리스틱 — 구글 카테고리 보조) ──────────────────
ECON_TERMS = [
    # 시장·지표
    "주가", "주식", "증시", "코스피", "코스닥", "나스닥", "다우", "S&P",
    "금리", "환율", "달러", "엔화", "위안", "원화", "국채", "채권",
    "물가", "인플레이션", "GDP", "경기", "경제", "무역", "수출", "수입",
    "관세", "유가", "국제유가", "고유가", "목표주가", "원자재", "반도체", "배터리", "이차전지",
    # 기업 행위
    "실적", "어닝", "매출", "영업이익", "적자", "흑자", "파산", "부도",
    "인수", "합병", "M&A", "상장", "IPO", "공모", "배당", "투자",
    "협약", "MOU", "계약", "수주", "공급", "리콜", "감산", "증산",
    "공장", "생산", "출시", "가격", "인상", "인하", "폭등", "폭락",
    "급등", "급락", "상한가", "하한가",
    # 정책·노동
    "한국은행", "연준", "FOMC", "기준금리", "금융위", "기재부",
    "세금", "감세", "증세", "보조금", "규제", "부동산", "아파트",
    "분양", "전세", "집값", "대출", "노조", "파업", "실업", "고용",
    "임금", "최저임금", "연금", "재테크",
    # 코인
    "비트코인", "이더리움", "암호화폐", "가상화폐", "코인",
    # 산업 키워드
    "AI", "인공지능", "데이터센터", "전기차", "방산", "조선", "원전", "로봇",
]
ECON_ENTITIES = [
    "삼성", "현대차", "현대자동차", "SK", "LG", "한화", "포스코", "롯데",
    "셀트리온", "네이버", "카카오", "쿠팡", "HD현대", "두산", "기아",
    "테슬라", "엔비디아", "애플", "구글", "아마존", "마이크로소프트", "메타",
    "TSMC", "인텔", "브로드컴", "AMD", "오픈AI", "OpenAI",
    "록히드", "보잉", "도요타", "폭스바겐", "머스크", "젠슨 황", "젠슨황",
    "버핏", "월가", "월스트리트",
]

# 동형어 오탐 차단: term을 찾기 전에 이 문구들을 제거
FALSE_FRIENDS = {
    "유가": ["유가족"],
    "인상": ["인상적", "인상착의", "인상파", "첫인상"],
    "경기": ["경기도", "경기장", "경기북부", "경기남부"],
    "투자": ["투자자문 사칭"],
    "코인": ["코인노래"],
    "공모": ["공모전", "공모혐의", "범행 공모", "공모한", "공모자"],
}

# 약한 어휘: 비경제 문맥에도 흔함(축구 "계약"...) — 이것만으로는 high 불가
ECON_WEAK = {
    "계약", "인상", "인하", "가격", "투자", "경기", "협약", "공급", "출시",
    "생산", "공장", "고용", "임금", "규제", "AI", "인공지능", "로봇", "공모",
}

# 스포츠·연예 문맥 기사는 휴리스틱 스코어링에서 제외
NON_ECON_CONTEXT = [
    "축구", "야구", "농구", "배구", "골프", "리그", "감독", "선수단",
    "이적", "골", "홈런", "우승", "결승", "예선", "국가대표", "대표팀",
    "드라마", "예능", "배우", "아이돌", "콘서트", "팬미팅", "열애", "결혼발표",
]


def http_get(url: str, headers: dict = None, timeout: int = 15) -> bytes:
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    s = (s.replace("&lt;", "<").replace("&gt;", ">")
          .replace("&amp;", "&").replace("&quot;", '"')
          .replace("&#39;", "'").replace("&apos;", "'"))
    return s.strip()


# ══════════════════════════════════════════════════════════════
# 구글 트렌드 내부 API (batchexecute — 트렌드 웹UI와 동일 소스)
# ══════════════════════════════════════════════════════════════
def batchexec(rpcid: str, inner_args, timeout: int = 20):
    body = urllib.parse.urlencode({
        "f.req": json.dumps([[[rpcid, json.dumps(inner_args), None, "generic"]]])
    }).encode()
    req = urllib.request.Request(BATCH_URL, data=body)
    req.add_header("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    for line in raw.splitlines():
        if line.startswith('[["wrb.fr"'):
            return json.loads(json.loads(line)[0][2])
    raise RuntimeError("batchexecute 응답에 wrb.fr 없음")


def fetch_trends_api():
    """i0OFE → 지난 24h 급상승 전체.
    항목 구조(실측): [0]키워드 [3][0]시작ts(초) [6]검색량 [8]증가율% [10]토픽ID목록 [11]뉴스토큰"""
    payload = batchexec("i0OFE", [None, None, "KR", 0, "ko", 24, 1])
    items = []
    for row in payload[1]:
        try:
            kw = row[0]
            if not kw:
                continue
            started = (row[3] or [0])[0] if isinstance(row[3], list) else 0
            vol = int(row[6] or 0)
            topic_ids = [int(x) for x in (row[10] or [])]
            tokens = row[11] or []
            items.append({
                "keyword": str(kw),
                "traffic": (f"{vol:,}+" if vol else "?"),
                "trafficNum": vol,
                "startedMs": int(started) * 1000,
                "topicIds": topic_ids,
                "topics": [TOPIC_NAMES.get(t, f"cat{t}") for t in topic_ids],
                "_newsTokens": tokens,
                "gnews": [],
            })
        except Exception as e:
            print(f"  ⚠ 항목 파싱 실패: {e}", file=sys.stderr)
    return items


def fetch_articles(trends, prev_gnews):
    """w4opAf → 구글이 키워드에 연결한 기사.
    ★실측: 한 호출 = 한 트렌드의 토큰 묶음만 처리(여러 트렌드 토큰을 섞으면 첫 것만 옴)
    → 트렌드별 개별 호출. 이전 실행에서 받은 기사는 재사용(키워드당 1회만 조회)."""
    calls = 0
    for t in trends:
        if t["econLevel"] not in ARTICLE_TIERS or not t["_newsTokens"]:
            continue
        # 이전 실행 기사 재사용 (아티클은 급등 원인이라 거의 안 변함)
        prev = prev_gnews.get(t["keyword"])
        if prev:
            t["gnews"] = prev
            continue
        if calls >= 40:  # 안전 상한 (구글 비공식 API 부담 최소화)
            continue
        try:
            res = batchexec("w4opAf", [t["_newsTokens"][:4]])
            calls += 1
        except Exception as e:
            print(f"  ⚠ 기사 조회 실패({t['keyword']}): {e}", file=sys.stderr)
            continue
        # 응답 구조(실측): [[ [title, url, source, [ts초], thumb], ... ]]
        for art in (res[0] if res and isinstance(res[0], list) else []):
            try:
                ts = (art[3] or [0])[0] if isinstance(art[3], list) else 0
                t["gnews"].append({
                    "title": strip_html(art[0]),
                    "link": art[1],
                    "sourceName": strip_html(art[2] or "뉴스"),
                    "pubTimestamp": int(ts) * 1000,
                })
            except Exception:
                continue
        t["gnews"] = t["gnews"][:4]
        time.sleep(0.25)


# ══════════════════════════════════════════════════════════════
# RSS 폴백 (내부 API가 막힐 경우 — 상위 ~10개 한계)
# ══════════════════════════════════════════════════════════════
def parse_traffic(s: str) -> int:
    digits = re.sub(r"[^0-9]", "", s or "")
    return int(digits) if digits else 0


def fetch_trends_rss():
    raw = http_get(TRENDS_RSS)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        title_el = it.find("title")
        keyword = (title_el.text or "").strip() if title_el is not None else ""
        if not keyword:
            continue
        traffic_el = it.find("{*}approx_traffic")
        traffic_raw = (traffic_el.text or "").strip() if traffic_el is not None else ""
        pub_el = it.find("pubDate")
        started_ms = 0
        if pub_el is not None and pub_el.text:
            try:
                started_ms = int(parsedate_to_datetime(pub_el.text).timestamp() * 1000)
            except Exception:
                pass
        gnews = []
        for ni in it.findall("{*}news_item"):
            def sub(tag):
                el = ni.find("{*}news_item_" + tag)
                return strip_html(el.text) if el is not None and el.text else ""
            t = sub("title")
            u = sub("url")
            if t and u:
                gnews.append({"title": t, "link": u, "sourceName": sub("source"), "pubTimestamp": 0})
        items.append({
            "keyword": keyword, "traffic": traffic_raw,
            "trafficNum": parse_traffic(traffic_raw), "startedMs": started_ms,
            "topicIds": [], "topics": [], "_newsTokens": [], "gnews": gnews[:5],
        })
    return items


# ══════════════════════════════════════════════════════════════
# 네이버 뉴스 보강 (high 등급만)
# ══════════════════════════════════════════════════════════════
def fetch_naver_news(query: str, cid: str, secret: str, display: int = 6):
    url = ("https://openapi.naver.com/v1/search/news.json?display=%d&sort=sim&query=%s"
           % (display, urllib.parse.quote(query)))
    try:
        raw = http_get(url, headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": secret}, timeout=10)
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print(f"  ⚠ 네이버 '{query}' 실패: {e}", file=sys.stderr)
        return []
    three_days_ago = (time.time() - 3 * 86400) * 1000
    result = []
    for it in data.get("items", []):
        title = strip_html(it.get("title", ""))
        link = it.get("originallink") or it.get("link", "")
        if not title or not link:
            continue
        try:
            ts = int(parsedate_to_datetime(it.get("pubDate", "")).timestamp() * 1000)
        except Exception:
            ts = int(time.time() * 1000)
        if ts < three_days_ago:
            continue
        host = (urllib.parse.urlparse(link).hostname or "").replace("www.", "")
        result.append({
            "title": title, "link": link, "pubTimestamp": ts,
            "sourceName": host.split(".")[0].upper() if host else "뉴스",
        })
    result.sort(key=lambda x: x["pubTimestamp"], reverse=True)
    return result[:5]


# ══════════════════════════════════════════════════════════════
# 경제성 판정 (1순위 구글 카테고리, 2순위 어휘 휴리스틱)
# ══════════════════════════════════════════════════════════════
def _term_in(term: str, text: str) -> bool:
    for bad in FALSE_FRIENDS.get(term, []):
        text = text.replace(bad, "")
    if re.fullmatch(r"[0-9A-Za-z&\s]+", term):
        # 영문·약어(AI, GDP...)는 단어 경계 + 대소문자 구분 (demain≠AI 오탐 방지)
        return re.search(r"(?<![0-9A-Za-z])" + re.escape(term) + r"(?![0-9A-Za-z])", text) is not None
    # 한글 어휘는 앞 경계 검사: "이유가/자유가"의 "유가" 오탐 차단 (뒤 조사는 허용)
    return re.search(r"(?<![가-힣])" + re.escape(term), text) is not None


def heuristic_score(keyword: str, news_titles: list):
    score = 0
    hits = []
    all_terms = ECON_TERMS + ECON_ENTITIES
    for term in all_terms:
        if _term_in(term, keyword):
            score += 3
            hits.append(term)
    for t in news_titles:
        if any(h in t for h in NON_ECON_CONTEXT):
            continue
        matched = False
        for term in all_terms:
            if _term_in(term, t):
                if term not in hits:
                    hits.append(term)
                matched = True
        if matched:
            score += 1
    return score, hits[:8]


def classify(t):
    """구글 공식 카테고리 우선, 휴리스틱은 보조. → (econLevel, econScore, econHits)"""
    topic_set = set(t["topicIds"])
    titles = [g["title"] for g in t["gnews"]]
    score, hits = heuristic_score(t["keyword"], titles)
    has_strong = any(h not in ECON_WEAK for h in hits)

    if topic_set & TOPIC_ECON_HIGH:
        return "high", max(score, 3), hits           # 구글: 비즈니스/금융
    if score >= 3 and has_strong:
        return "high", score, hits                    # 휴리스틱 강한 신호 (예: 록히드=기타 태그)
    if topic_set and not (topic_set - TOPIC_NOISE):
        return "low", score, hits                     # 스포츠·연예·날씨·게임뿐 → 무조건 low
    if topic_set & TOPIC_ECON_MID:
        return "mid", max(score, 1), hits             # 테크·과학·푸드
    if score >= 1 and has_strong:
        return "mid", score, hits
    return "low", score, hits


def load_prev(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    out_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "trends.json"))
    prev = load_prev(out_path)
    prev_history = {}
    prev_gnews = {}
    if prev:
        for t in prev.get("trends", []):
            prev_history[t.get("keyword", "")] = t.get("history", [])
            # 기사 재사용은 v2 스키마(개별 호출로 정확 귀속된 것)만 — v1 배치 오귀속 차단
            if prev.get("artSchema") == 2 and t.get("gnews"):
                prev_gnews[t.get("keyword", "")] = t["gnews"]

    print("📡 구글 트렌드 급상승(KR) 수집 — 내부 API...")
    source = "api"
    try:
        trends = fetch_trends_api()
    except Exception as e:
        print(f"  ⚠ 내부 API 실패({e}) → RSS 폴백", file=sys.stderr)
        source = "rss"
        try:
            trends = fetch_trends_rss()
        except Exception as e2:
            print(f"❌ RSS도 실패: {e2} — 기존 trends.json 유지", file=sys.stderr)
            sys.exit(0)

    if not trends:
        print("❌ 트렌드 0건 — 기존 파일 유지", file=sys.stderr)
        sys.exit(0)
    print(f"  ✓ {len(trends)}건 ({source})")

    # 1차 분류 (구글 카테고리 + 키워드 휴리스틱, 기사는 아직 없음)
    for t in trends:
        t["econLevel"], t["econScore"], t["econHits"] = classify(t)

    # 구글 연결 기사 (high/mid만) → 기사 반영해 재분류
    if source == "api":
        fetch_articles(trends, prev_gnews)
        n_arts = sum(len(t["gnews"]) for t in trends)
        print(f"  ✓ 구글 기사 {n_arts}건 (high/mid 등급)")
        for t in trends:
            if t["gnews"]:
                t["econLevel"], t["econScore"], t["econHits"] = classify(t)

    # 네이버 보강 (high만, 상한 20)
    cid = os.environ.get("NAVER_CLIENT_ID", "")
    secret = os.environ.get("NAVER_CLIENT_SECRET", "")
    use_naver = bool(cid and secret)
    if not use_naver:
        print("  (네이버 키 없음 — 구글 기사만 사용)")
    enriched = 0
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - HISTORY_RETENTION_MS

    for t in trends:
        if use_naver and t["econLevel"] == "high" and enriched < NAVER_ENRICH_CAP:
            t["news"] = fetch_naver_news(t["keyword"], cid, secret)
            enriched += 1
            time.sleep(0.25)
        else:
            t["news"] = []

        # 검색량 이력 (스파크라인용)
        hist = [p for p in prev_history.get(t["keyword"], []) if p.get("t", 0) >= cutoff]
        hist.append({"t": now_ms, "v": t["trafficNum"]})
        t["history"] = hist[-MAX_HISTORY_POINTS:]
        del t["_newsTokens"]  # 내부용 — 출력에서 제거

    # 경제성 → 검색량 순 정렬
    tier_order = {"high": 0, "mid": 1, "low": 2}
    trends.sort(key=lambda x: (tier_order[x["econLevel"]], -x["trafficNum"], -x["econScore"]))

    output = {
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "generated_at_ms": now_ms,
        "geo": "KR",
        "source": source,
        "artSchema": 2,
        "trends": trends,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=1)

    n_high = sum(1 for t in trends if t["econLevel"] == "high")
    n_mid = sum(1 for t in trends if t["econLevel"] == "mid")
    print(f"✅ 완료: 전체 {len(trends)}건 — 💰직결 {n_high} · 💡연관 {n_mid} · 기타 {len(trends) - n_high - n_mid}")


if __name__ == "__main__":
    main()
