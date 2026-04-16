#!/usr/bin/env python3
"""
Naver News Search API로 경제 뉴스 수집 → news.json 저장
GitHub Actions에서 10분마다 자동 실행됨.
환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
"""
import os
import json
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

# 카테고리 설정
CATEGORIES = {
    "econ":   {"name": "경제 전반",   "query": "경제"},
    "stock":  {"name": "주식/증시",   "query": "코스피 OR 증시 OR 주가"},
    "real":   {"name": "부동산",      "query": "부동산 OR 아파트 OR 집값"},
    "global": {"name": "글로벌",      "query": "미국경제 OR 연준 OR 환율 OR 중국경제"},
    "policy": {"name": "금융정책",    "query": "한국은행 OR 기준금리 OR 통화정책"},
    "crypto": {"name": "암호화폐",    "query": "비트코인 OR 암호화폐"},
}

# 도메인 → 매체명 매핑
PRESS_MAP = {
    "yna.co.kr": "연합뉴스", "hankyung.com": "한국경제", "mk.co.kr": "매일경제",
    "edaily.co.kr": "이데일리", "sedaily.com": "서울경제", "mt.co.kr": "머니투데이",
    "news.mt.co.kr": "머니투데이", "chosun.com": "조선일보", "biz.chosun.com": "조선비즈",
    "donga.com": "동아일보", "joongang.co.kr": "중앙일보", "hani.co.kr": "한겨레",
    "kmib.co.kr": "국민일보", "khan.co.kr": "경향신문", "nocutnews.co.kr": "노컷뉴스",
    "ohmynews.com": "오마이뉴스", "kbs.co.kr": "KBS", "news.kbs.co.kr": "KBS",
    "imbc.com": "MBC", "sbs.co.kr": "SBS", "ytn.co.kr": "YTN", "mbn.co.kr": "MBN",
    "fnnews.com": "파이낸셜뉴스", "biz.heraldcorp.com": "헤럴드경제",
    "heraldcorp.com": "헤럴드", "news1.kr": "뉴스1", "newsis.com": "뉴시스",
    "zdnet.co.kr": "ZDNet", "etnews.com": "전자신문",
}


def strip_html(s: str) -> str:
    """HTML 태그 + 엔티티 정리"""
    import re
    s = re.sub(r"<[^>]+>", "", s)
    s = (s.replace("&lt;", "<").replace("&gt;", ">")
          .replace("&amp;", "&").replace("&quot;", '"')
          .replace("&#39;", "'").replace("&apos;", "'"))
    return s.strip()


def get_source_name(link: str) -> str:
    """링크 도메인에서 매체명 추출"""
    try:
        host = urllib.parse.urlparse(link).hostname or ""
        host = host.replace("www.", "")
        if host in PRESS_MAP:
            return PRESS_MAP[host]
        # n.news.naver.com 같은 경우 → 도메인 첫 부분
        return host.split(".")[0].upper() if host else "뉴스"
    except Exception:
        return "뉴스"


def fetch_naver_news(query: str, client_id: str, client_secret: str, display: int = 30):
    """Naver 뉴스 검색 API 호출"""
    encoded = urllib.parse.quote(query)
    url = f"https://openapi.naver.com/v1/search/news.json?display={display}&sort=date&query={encoded}"

    req = urllib.request.Request(url)
    req.add_header("X-Naver-Client-Id", client_id)
    req.add_header("X-Naver-Client-Secret", client_secret)

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        print(f"  ❌ HTTP {e.code}: {body[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  ❌ Error: {e}", file=sys.stderr)
        return None

    items = data.get("items", [])
    result = []
    for it in items:
        title = strip_html(it.get("title", ""))
        link = it.get("originallink") or it.get("link", "")
        pub_date = it.get("pubDate", "")
        if not title or not link:
            continue
        # pubDate를 ISO timestamp로 변환
        try:
            from email.utils import parsedate_to_datetime
            ts = int(parsedate_to_datetime(pub_date).timestamp() * 1000)
        except Exception:
            ts = int(time.time() * 1000)
        result.append({
            "title": title,
            "link": link,
            "pubDate": pub_date,
            "pubTimestamp": ts,
            "sourceName": get_source_name(link),
        })
    # 시간 역순 정렬 (최신 먼저)
    result.sort(key=lambda x: x["pubTimestamp"], reverse=True)
    return result


def main():
    cid = os.environ.get("NAVER_CLIENT_ID")
    secret = os.environ.get("NAVER_CLIENT_SECRET")
    if not cid or not secret:
        print("❌ NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 필요", file=sys.stderr)
        sys.exit(1)

    print(f"📡 뉴스 수집 시작 ({len(CATEGORIES)}개 카테고리)")
    output = {
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "generated_at_ms": int(time.time() * 1000),
        "categories": {},
    }

    for key, cat in CATEGORIES.items():
        print(f"  · {cat['name']} ({cat['query']})")
        news = fetch_naver_news(cat["query"], cid, secret)
        if news is None:
            output["categories"][key] = {"name": cat["name"], "query": cat["query"], "news": [], "error": "fetch failed"}
        else:
            output["categories"][key] = {"name": cat["name"], "query": cat["query"], "news": news}
            print(f"    ✓ {len(news)}건 수집")
        time.sleep(0.3)  # API rate limit 보호

    # news.json 저장 (저장소 루트)
    output_path = os.path.join(os.path.dirname(__file__), "..", "news.json")
    output_path = os.path.abspath(output_path)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    total = sum(len(v.get("news", [])) for v in output["categories"].values())
    print(f"✅ 완료: {output_path} ({total}건 총)")


if __name__ == "__main__":
    main()
