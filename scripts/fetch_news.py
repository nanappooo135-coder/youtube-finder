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
# Naver Search API는 OR 연산자 지원 안 함 → 단일 키워드 또는 여러 키워드 합성 (다중 호출 후 병합)
# 각 카테고리별로 여러 단일 키워드를 호출해서 결과 합치고 시간순 정렬
CATEGORIES = {
    "econ":   {"name": "경제 전반",   "queries": ["경제뉴스", "경제전망", "한국경제"]},
    "stock":  {"name": "주식/증시",   "queries": ["코스피", "코스닥", "증시"]},
    "real":   {"name": "부동산",      "queries": ["부동산", "아파트", "집값"]},
    "global": {"name": "글로벌",      "queries": ["미국경제", "연준", "환율", "중국경제"]},
    "policy": {"name": "금융정책",    "queries": ["한국은행", "기준금리", "통화정책"]},
    "crypto": {"name": "암호화폐",    "queries": ["비트코인", "이더리움", "암호화폐"]},
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

    # 최근 7일 이내만 유지 (오래된 뉴스 필터)
    week_ago_ms = int((time.time() - 7 * 86400) * 1000)

    for key, cat in CATEGORIES.items():
        queries = cat.get("queries", [cat.get("query", "")])
        print(f"  · {cat['name']} - 키워드 {len(queries)}개")
        all_news = []
        seen_links = set()

        for q in queries:
            print(f"    → '{q}' 검색 중...")
            news = fetch_naver_news(q, cid, secret, display=20)
            if news:
                # 7일 이내 + 중복 제거
                for item in news:
                    if item["pubTimestamp"] < week_ago_ms:
                        continue  # 너무 오래된 뉴스 스킵
                    if item["link"] in seen_links:
                        continue  # 중복 스킵
                    seen_links.add(item["link"])
                    all_news.append(item)
            time.sleep(0.3)  # API rate limit 보호

        # 시간 역순 정렬 (최신 먼저) + 30개로 제한
        all_news.sort(key=lambda x: x["pubTimestamp"], reverse=True)
        all_news = all_news[:30]

        output["categories"][key] = {
            "name": cat["name"],
            "queries": queries,
            "news": all_news,
        }
        print(f"    ✓ {len(all_news)}건 (최근 7일 이내, 중복 제거)")

    # news.json 저장 (저장소 루트)
    output_path = os.path.join(os.path.dirname(__file__), "..", "news.json")
    output_path = os.path.abspath(output_path)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    total = sum(len(v.get("news", [])) for v in output["categories"].values())
    print(f"✅ 완료: {output_path} ({total}건 총)")


if __name__ == "__main__":
    main()
