#!/usr/bin/env python3
"""
구글 트렌드 급상승 검색어(KR) + 네이버 뉴스 교차 → trends.json 저장
GitHub Actions에서 10분마다 자동 실행됨 (fetch-news.yml에 포함).

- 구글 트렌드 RSS: 키워드·검색량(approx_traffic)·급등 시작 시간·구글뉴스 기사
- 네이버 뉴스 검색: 키워드별 최신 한국 기사 (뜨는 이유 보강) — 키 없으면 스킵
- 경제성 점수: 키워드·기사 제목을 경제 어휘와 대조 (high/mid/low)
- 이력(history): 실행마다 검색량 스냅샷 누적 → 프론트 스파크라인 그래프 재료
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
HISTORY_RETENTION_MS = 48 * 3600 * 1000  # 48시간
MAX_HISTORY_POINTS = 300

# ── 경제성 판정 어휘 ──────────────────────────────────────────
# 키워드 자체에 있으면 +3, 기사 제목 1건당 +1. 합산: 3+ = high, 1~2 = mid, 0 = low
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
    # 기업·인물 (등장 자체가 경제 뉴스일 확률 높음)
    "삼성", "현대차", "현대자동차", "SK", "LG", "한화", "포스코", "롯데",
    "셀트리온", "네이버", "카카오", "쿠팡", "HD현대", "두산", "기아",
    "테슬라", "엔비디아", "애플", "구글", "아마존", "마이크로소프트", "메타",
    "TSMC", "인텔", "브로드컴", "AMD", "오픈AI", "OpenAI",
    "록히드", "보잉", "도요타", "폭스바겐", "머스크", "젠슨 황", "젠슨황",
    "버핏", "월가", "월스트리트",
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


def parse_traffic(s: str) -> int:
    """'20,000+' → 20000"""
    digits = re.sub(r"[^0-9]", "", s or "")
    return int(digits) if digits else 0


def fetch_google_trends():
    """구글 트렌드 RSS → [{keyword, traffic, trafficNum, startedMs, gnews:[...]}]"""
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
                gnews.append({"title": t, "link": u, "sourceName": sub("source")})

        items.append({
            "keyword": keyword,
            "traffic": traffic_raw,
            "trafficNum": parse_traffic(traffic_raw),
            "startedMs": started_ms,
            "gnews": gnews[:5],
        })
    return items


def fetch_naver_news(query: str, cid: str, secret: str, display: int = 6):
    """네이버 뉴스 검색 (관련도순) → 최근 3일 기사만"""
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


# 동형어 오탐 차단: term을 찾기 전에 이 문구들을 제거
FALSE_FRIENDS = {
    "유가": ["유가족"],
    "인상": ["인상적", "인상착의", "인상파", "첫인상"],
    "경기": ["경기도", "경기장", "경기북부", "경기남부"],
    "투자": ["투자자문 사칭"],
    "코인": ["코인노래"],
    "공모": ["공모전", "공모혐의", "범행 공모", "공모한", "공모자"],
}

# 약한 어휘: 비경제 문맥에도 흔함(축구 "계약", 감독 "경질"...) — 이것만으로는 high 불가
ECON_WEAK = {
    "계약", "인상", "인하", "가격", "투자", "경기", "협약", "공급", "출시",
    "생산", "공장", "고용", "임금", "규제", "AI", "인공지능", "로봇", "공모",
}


def _term_in(term: str, text: str) -> bool:
    for bad in FALSE_FRIENDS.get(term, []):
        text = text.replace(bad, "")
    if re.fullmatch(r"[0-9A-Za-z&\s]+", term):
        # 영문·약어(AI, GDP, S&P...)는 단어 경계 + 대소문자 구분 (demain≠AI 오탐 방지)
        return re.search(r"(?<![0-9A-Za-z])" + re.escape(term) + r"(?![0-9A-Za-z])", text) is not None
    # 한글 어휘는 앞 경계 검사: "이유가/자유가"의 "유가", "산유국"류 합성 오탐 차단
    # (뒤는 조사가 붙으므로 검사 안 함: "금리를" OK)
    return re.search(r"(?<![가-힣])" + re.escape(term), text) is not None


# 스포츠·연예 문맥 기사는 스코어링에서 제외 (축구 이적 "계약" 등 오탐 방지)
NON_ECON_CONTEXT = [
    "축구", "야구", "농구", "배구", "골프", "리그", "감독", "선수단",
    "이적", "골", "홈런", "우승", "결승", "예선", "국가대표", "대표팀",
    "드라마", "예능", "배우", "아이돌", "콘서트", "팬미팅", "열애", "결혼발표",
]


def econ_score(keyword: str, news_titles: list):
    """(점수, 매칭어휘목록) — 키워드 매칭 +3, 기사 제목 매칭 건당 +1"""
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
    if prev:
        for t in prev.get("trends", []):
            prev_history[t.get("keyword", "")] = t.get("history", [])

    print("📡 구글 트렌드 급상승(KR) 수집...")
    try:
        trends = fetch_google_trends()
    except Exception as e:
        print(f"❌ 트렌드 RSS 실패: {e} — 기존 trends.json 유지", file=sys.stderr)
        sys.exit(0)  # 기존 파일 보존 (Actions 커밋 단계에서 변경 없음 처리)

    if not trends:
        print("❌ 트렌드 0건 — 기존 파일 유지", file=sys.stderr)
        sys.exit(0)
    print(f"  ✓ {len(trends)}건")

    cid = os.environ.get("NAVER_CLIENT_ID", "")
    secret = os.environ.get("NAVER_CLIENT_SECRET", "")
    use_naver = bool(cid and secret)
    if not use_naver:
        print("  (네이버 키 없음 — 구글뉴스 기사만 사용)")

    now_ms = int(time.time() * 1000)
    cutoff = now_ms - HISTORY_RETENTION_MS

    for t in trends:
        # 네이버 뉴스 보강
        if use_naver:
            t["news"] = fetch_naver_news(t["keyword"], cid, secret)
            time.sleep(0.25)
        else:
            t["news"] = []

        # 경제성 점수 (high는 강한 어휘 1개+ 필수 — 축구 "계약"만으로 high 방지)
        titles = [n["title"] for n in t["news"]] + [g["title"] for g in t["gnews"]]
        score, hits = econ_score(t["keyword"], titles)
        has_strong = any(h not in ECON_WEAK for h in hits)
        t["econScore"] = score
        t["econLevel"] = ("high" if score >= 3 and has_strong
                          else ("mid" if score >= 1 else "low"))
        t["econHits"] = hits

        # 검색량 이력 (스파크라인용)
        hist = [p for p in prev_history.get(t["keyword"], []) if p.get("t", 0) >= cutoff]
        hist.append({"t": now_ms, "v": t["trafficNum"]})
        t["history"] = hist[-MAX_HISTORY_POINTS:]

    # 경제성 높은 순 → 검색량 순 정렬
    trends.sort(key=lambda x: (-x["econScore"], -x["trafficNum"]))

    output = {
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "generated_at_ms": now_ms,
        "geo": "KR",
        "trends": trends,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    econ_n = sum(1 for t in trends if t["econLevel"] != "low")
    print(f"✅ 완료: {out_path} (전체 {len(trends)}건, 경제 관련 {econ_n}건)")


if __name__ == "__main__":
    main()
