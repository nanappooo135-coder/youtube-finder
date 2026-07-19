# -*- coding: utf-8 -*-
"""♻️ 역사(국내) 채널 자동 발굴·등록 — 해외 스윕(1,646개 등록 실적)과 동일 패턴의 국내 역사판.

배경(2026-07-19): 역사 등록 288채널 중 활동 채널이 적어 사냥터 파도가 2개뿐(경제 102개).
활발한 역사 채널을 키워드 대량 검색으로 발굴해 channels.json 역사/kr에 추가한다.

필터 원칙(메모리 '작은채널 떡상=먹잇감'): 구독자 컷 금지 — 활동성·정체성만 거른다.
- 활동성: 최근 90일 롱폼(8분+) 업로드 2개 이상
- 정체성: 최근 업로드 제목의 역사 키워드 매칭 (수면·낭독·게임 채널 제외)
쿼터: 검색 26키워드 × 100유닛 = 2,600 + 후보 검증(채널당 2유닛, 상한 400) ≈ 3,400유닛.
GitHub Actions(YT_KEYS)에서 실행, channels.json 커밋 → 앱은 새로고침 시 자동 로드.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = [k.strip() for k in (os.environ.get("YOUTUBE_API_KEY", "")).replace("\n", ",").split(",") if k.strip()]
_ki = 0

SEARCH_DAYS = 90           # 최근 90일 영상에서 발굴 = 활동 채널만 걸림
MIN_DURATION = 480         # 롱폼 기준(파인더 공통)
MIN_RECENT_LONGFORM = 2    # 활동성: 최근 90일 롱폼 2개+
IDENTITY_RATIO = 0.3       # 정체성: 최근 업로드 제목의 30%+ 가 역사 키워드 매칭
CAND_CAP = 400             # 검증 상한 (채널당 2유닛)

KEYWORDS = [
    "한국사", "조선시대 역사", "조선 왕조", "고려 역사", "삼국시대 역사", "세계사",
    "전쟁사", "근현대사", "일제강점기", "역사 다큐", "역사 이야기", "몰락의 역사",
    "중국 역사", "일본 역사", "로마 제국", "중세 유럽", "몽골 제국", "오스만 제국",
    "역사 미스터리", "역사 인물", "궁중 야사", "조선왕조실록", "6.25 전쟁 역사",
    "제2차 세계대전", "냉전 역사", "문명의 몰락",
]

# 정체성 판별용 역사 시그널 단어 (제목 매칭)
_HIST_WORDS = re.compile(
    r"역사|한국사|세계사|조선|고려|신라|백제|고구려|삼국|왕조|왕비|왕자|세종|세조|영조|정조|고종"
    r"|실록|야사|사대부|양반|노비|궁궐|궁녀|황제|황후|제국|왕국|중세|근대|근현대|일제|광복|전쟁사"
    r"|전투|장군|병사|기사단|로마|몽골|오스만|바이킹|십자군|파라오|문명|유적|고대|BC|서기"
    r"|세기|년대|시대|founding|dynasty|1[0-9]{3}년")
# 제외: 수면·낭독·게임·요약 채널 (소재 신호 낮음 — wave_engine 잡음 목록과 동일 계열)
_EXCLUDE = re.compile(
    r"수면|자장가|잠들기|잘 때|꿀잠|숙면|asmr|낭독|오디오북|읽어주|책읽|게임|롤플레이"
    r"|모드|공략|스팀|삼국지\s*게임|토탈워", re.I)


def api(endpoint, **params):
    global _ki
    if not KEYS:
        raise RuntimeError("YOUTUBE_API_KEY 없음")
    last = None
    for _ in range(len(KEYS) * 2):
        p = dict(params)
        p["key"] = KEYS[_ki]
        url = "https://www.googleapis.com/youtube/v3/" + endpoint + "?" + urllib.parse.urlencode(p)
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 403, 429):
                _ki = (_ki + 1) % len(KEYS)
                continue
            raise
    raise RuntimeError("모든 키 소진: %s" % last)


def parse_dur(iso):
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def discover_candidates(after_iso):
    """키워드 검색으로 후보 채널 수집 (채널ID → 검색에 걸린 횟수·채널명)"""
    cand = {}
    for i, kw in enumerate(KEYWORDS):
        try:
            r = api("search", part="snippet", type="video", q=kw, regionCode="KR",
                    relevanceLanguage="ko", order="relevance", maxResults=50,
                    publishedAfter=after_iso)
        except RuntimeError:
            raise
        except Exception as e:
            print("검색 실패 %s: %s" % (kw, e), file=sys.stderr)
            continue
        for it in r.get("items", []):
            cid = it["snippet"].get("channelId")
            if not cid:
                continue
            c = cand.setdefault(cid, {"id": cid, "title": it["snippet"].get("channelTitle", ""), "hits": 0})
            c["hits"] += 1
        print("[%d/%d] %s → 누적 후보 %d개" % (i + 1, len(KEYWORDS), kw, len(cand)), file=sys.stderr)
    return cand


def verify_channel(cid, now):
    """활동성·정체성 검증: 최근 90일 롱폼 2+ & 제목 역사 매칭 30%+ & 제외어 없음"""
    pl = "UU" + cid[2:]
    try:
        r = api("playlistItems", part="snippet,contentDetails", playlistId=pl, maxResults=15)
    except RuntimeError:
        raise
    except Exception:
        return None
    vids = []
    for it in r.get("items", []):
        pub = it["contentDetails"].get("videoPublishedAt") or it["snippet"].get("publishedAt")
        t = it["snippet"]["title"]
        if not pub or t in ("Private video", "Deleted video"):
            continue
        vids.append({"id": it["contentDetails"]["videoId"], "title": t,
                     "age": (now - datetime.fromisoformat(pub.replace("Z", "+00:00"))).days})
    if not vids:
        return None
    ids = ",".join(v["id"] for v in vids[:15])
    try:
        vr = api("videos", part="contentDetails", id=ids)
    except Exception:
        return None
    durs = {x["id"]: parse_dur(x["contentDetails"].get("duration")) for x in vr.get("items", [])}
    longform = [v for v in vids if durs.get(v["id"], 0) >= MIN_DURATION]
    recent_long = [v for v in longform if v["age"] <= SEARCH_DAYS]
    if len(recent_long) < MIN_RECENT_LONGFORM:
        return None  # 활동성 미달
    titles = [v["title"] for v in longform] or [v["title"] for v in vids]
    if any(_EXCLUDE.search(t) for t in titles[:8]):
        return None  # 수면·낭독·게임 채널
    hist_ratio = sum(1 for t in titles if _HIST_WORDS.search(t)) / len(titles)
    if hist_ratio < IDENTITY_RATIO:
        return None  # 역사 정체성 미달
    return {"recentLongform": len(recent_long), "histRatio": round(hist_ratio, 2)}


def main():
    now = datetime.now(timezone.utc)
    after_iso = (now - timedelta(days=SEARCH_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    path = os.path.join(BASE, "channels.json")
    channels = json.load(open(path, encoding="utf-8"))
    existing = {c["id"] for c in (channels.get("역사") or {}).get("kr") or []}
    print("기존 역사 채널 %d개" % len(existing), file=sys.stderr)

    cand = discover_candidates(after_iso)
    fresh = [c for c in cand.values() if c["id"] not in existing and c["id"].startswith("UC")]
    # 검색 다중 히트 채널 우선 검증 (역사 정체성 확률 높음)
    fresh.sort(key=lambda c: -c["hits"])
    fresh = fresh[:CAND_CAP]
    print("신규 후보 %d개 검증 시작" % len(fresh), file=sys.stderr)

    added = []
    for i, c in enumerate(fresh):
        v = verify_channel(c["id"], now)
        if v:
            added.append({"id": c["id"], "title": c["title"], "thumbnail": ""})
        if (i + 1) % 50 == 0:
            print("  검증 %d/%d — 합격 %d" % (i + 1, len(fresh), len(added)), file=sys.stderr)

    if not added:
        print("추가할 채널 없음", file=sys.stderr)
        return
    channels.setdefault("역사", {}).setdefault("kr", []).extend(added)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(channels, f, ensure_ascii=False, indent=2)
    print("역사 채널 %d개 신규 등록 → 총 %d개" % (len(added), len(existing) + len(added)), file=sys.stderr)
    for a in added[:30]:
        print("  +", a["title"], file=sys.stderr)


if __name__ == "__main__":
    main()
