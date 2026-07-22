# -*- coding: utf-8 -*-
"""♻️ 에버그린 스캔 — "예전에 크게 터진 소재를 재탕용으로 발굴". 주간 Actions 배치.

★2026-07-22 전면 개편 (사용자 지시): 복잡한 '재탕 검증(같은 소재 2번+ 터짐)' 클러스터링을 폐기하고,
단순·직관 모델로 교체 — "최근에 만들 주제가 없을 때, 예전에 터진 영상을 들고와 재탕/변형한다."

  1. 등록 채널 전체(경제·역사, 500+개)의 과거 영상을 훑는다.
  2. 나이 구간 = 60~365일 (2개월~1년): 2개월 이내는 아직 '진행형 핫이슈'라 제외,
     1년 넘게 지난 건 이번 개편 범위 밖(원하면 MAX_AGE_DAYS 조정).
  3. '구독자 대비 조회수(효율 = 조회수 ÷ 구독자수)' 2배+ 인 것만 = 구독자 밖으로 퍼진 진짜 터짐.
     (daily_briefing의 '떡상' 지표와 동일 — 작은 채널 대박까지 잡는다.)
  4. 효율 높은 순으로 쭉 정렬 → 제일 잘 터진 게 맨 위. UI에서 안 할 영상은 개별 숨김.

이전 버전(재탕 60일+ 간격 2히트·wave_engine 클러스터링·단독/활동중 구분)은 git 히스토리에 있음.

비용: 채널당 channels.list 지분(1/50유닛) + playlistItems 최대 8페이지 + videos.list.
1,000여 채널 주 1회 = 무시할 수준(5키). 산출: evergreen.json (git-scraping 패턴).
"""
import json
import os
import re
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wave_engine import _JUNK_TITLE  # noqa: E402  (쓰레기 제목 필터만 재사용)

KEYS = [k.strip() for k in (os.environ.get("YOUTUBE_API_KEY", "")).replace("\n", ",").split(",") if k.strip()]
_ki = 0

# ── 판별 기준 (2026-07-22 사용자 확정) ──
MIN_DURATION = 480         # 숏폼 제외 (파인더 공통 8분+ 롱폼만)
MIN_AGE_DAYS = 60          # ★2개월 이내 제외 — 아직 '진행형 핫이슈'지 재탕 소재가 아님
MAX_AGE_DAYS = 365         # ★1년까지만 — '1년~최근2개월' 구간 (넓히려면 이 값만 올리면 됨)
MIN_EFF = 2.0              # ★효율(조회÷구독) 2배+ = 구독자의 2배 이상 봤다 = 확실히 터진 것만
MIN_VIEWS = 30000          # 절대 조회수 하한 3만+ (효율만 높고 실체 없는 소형 채널 노이즈 차단)
COHORT_DAYS = 90           # 참고 지표(배수)용 연령 보정: 같은 채널 ±3개월 이웃과 비교
PER_PAGE = 50
MAX_PAGES = 8              # 채널당 최대 8페이지(400편) — 다작 채널도 1년치 커버, 슬로우 채널은 조기 종료
AGE_BUFFER = 30            # 마지막 페이지가 (최대나이+버퍼)보다 오래되면 그만 페이징
TOP_N = 1500              # 카테고리당 상위 1500편까지 노출 (효율 순). 사용자: "500채널인데 이거뿐이냐"
                          #   — 옛 200 상한이 효율 11배+에서 잘라 2~11배 대량을 숨김. 크게 올림.
                          #   프론트는 60개씩 '더 보기' 페이지네이션이라 폰 DOM 부담 없음.


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
            if e.code in (400, 403, 429):  # 무효 키·할당량 → 다음 키 (daily_briefing과 동일)
                _ki = (_ki + 1) % len(KEYS)
                continue
            raise
    raise RuntimeError("모든 키 소진: %s" % last)


def parse_dur(iso):
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def _median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return 0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _age(pub, now):
    try:
        return (now - datetime.fromisoformat(pub.replace("Z", "+00:00"))).days
    except Exception:
        return 99999


def cohort_median(target, siblings):
    """참고 배수(mult)용 — 같은 채널에서 그 영상 ±COHORT_DAYS에 올라온 이웃들의 중앙값.
    (vidIQ 'similar timeframe' 방식. 효율의 함정[구독자 많고 평소 조회 낮은 채널]을 보완하는 보조 지표)"""
    for window in (COHORT_DAYS, COHORT_DAYS * 2):
        pool = [s["viewCount"] for s in siblings
                if s["videoId"] != target["videoId"] and abs(s["age"] - target["age"]) <= window]
        if len(pool) >= 5:
            return _median(pool)
    pool = [s["viewCount"] for s in siblings if s["videoId"] != target["videoId"]]
    return _median(pool) if pool else 0


def fetch_subs(ch_ids):
    """채널별 구독자수 (효율 계산의 분모). 비공개 구독자는 0 → 효율 None 처리."""
    subs = {}
    for i in range(0, len(ch_ids), 50):
        try:
            r = api("channels", part="statistics", id=",".join(ch_ids[i:i + 50]))
        except RuntimeError:
            raise
        except Exception:
            continue
        for c in r.get("items", []):
            st = c.get("statistics", {})
            subs[c["id"]] = 0 if st.get("hiddenSubscriberCount") else int(st.get("subscriberCount", 0))
    return subs


def scan_channel(ch, now, sub):
    """채널 1개 → 나이 창을 덮을 만큼 페이징 수집 + 효율(조회÷구독)·참고 배수(조회÷평소중앙값)"""
    cid = ch.get("id")
    if not cid or not cid.startswith("UC"):
        return []
    pl = "UU" + cid[2:]
    items, token = [], None
    for _pg in range(MAX_PAGES):
        p = dict(part="snippet,contentDetails", playlistId=pl, maxResults=PER_PAGE)
        if token:
            p["pageToken"] = token
        try:
            r = api("playlistItems", **p)
        except RuntimeError:
            raise
        except Exception:
            break
        page = r.get("items", [])
        items += page
        token = r.get("nextPageToken")
        # 마지막 항목이 이미 (최대나이+버퍼)보다 오래됐으면 그 뒤는 전부 더 오래됨 → 그만 (슬로우 채널 과다수집 방지)
        if page:
            lp = page[-1]["contentDetails"].get("videoPublishedAt") or page[-1]["snippet"].get("publishedAt")
            if lp and _age(lp, now) > MAX_AGE_DAYS + AGE_BUFFER:
                break
        if not token:
            break
    vids = []
    for it in items:
        pub = it["contentDetails"].get("videoPublishedAt") or it["snippet"].get("publishedAt")
        t = it["snippet"]["title"]
        if not pub or t in ("Private video", "Deleted video"):
            continue
        vids.append({"videoId": it["contentDetails"]["videoId"], "title": t, "publishedAt": pub,
                     "channelId": cid, "channelTitle": ch.get("title") or "",
                     "thumbnail": (it["snippet"].get("thumbnails", {}).get("medium", {}) or {}).get("url", "")})
    # 통계
    stats = {}
    ids = [v["videoId"] for v in vids]
    for i in range(0, len(ids), 50):
        try:
            r = api("videos", part="statistics,contentDetails", id=",".join(ids[i:i + 50]))
        except RuntimeError:
            raise
        except Exception:
            continue
        for x in r.get("items", []):
            stats[x["id"]] = x
    out = []
    for v in vids:
        s = stats.get(v["videoId"])
        if not s or parse_dur(s["contentDetails"].get("duration")) < MIN_DURATION:
            continue
        v["viewCount"] = int(s["statistics"].get("viewCount", 0))
        v["age"] = _age(v["publishedAt"], now)
        out.append(v)
    for v in out:
        v["chMedian"] = max(1, cohort_median(v, out))
        v["mult"] = round(v["viewCount"] / v["chMedian"], 1)          # 참고: 평소 대비 배수
        v["subscriberCount"] = sub
        v["efficiency"] = round(v["viewCount"] / sub, 1) if sub > 0 else None  # ★주 지표: 구독 대비 조회
    return out


# ★시황·단타 콘텐츠 제외 (사용자 실물검사: "하이닉스 시황·코스피 매도가 왜 에버그린이냐")
#   시황은 매일 갱신되는 뉴스 소비재 — 재탕할 '소재'가 아니라 그냥 장세.
_MARKET_NOISE = re.compile(
    r"매도|매수|팔아야|사야|사세요|파세요|상한가|하한가|주가\s*전망|목표가|매매|대응\s*전략|손절|익절"
    r"|비중\s*확대|줍줍|분할\s*매수|급등주|테마주|수급|기술적\s*분석|차트\s*분석|지지선|저항선"
    r"|내일\s*(장|증시|주가)|이번\s*주\s*증시|월요일|화요일|수요일|목요일|금요일")

# ★순수 속보 마커만 제외 (2026-07-22 완화): 재탕 불가능한 실시간 중계류만 거른다.
#   구간이 이미 60일+라 '오늘/어제/올해·연도' 같은 소프트 마커는 굳이 안 거름(넓은 그물 + 개별 숨김으로 큐레이션).
_NEWS_MARKER = re.compile(r"속보|긴급|실시간|생중계|라이브|현장\s*중계")


def attach_weekly_gain(all_videos, prev_map):
    """★조회수 감쇠 곡선 신호 (PNAS Crane&Sornette 근거): 지난주 스캔 조회수와 차분.
    옛(90일+) 영상이 지난주에도 조회수를 벌면 stillEarning=True = 소재가 살아있다는 직접 증거.
    첫 실행 주엔 prev가 없어 전부 None — 다음 주부터 쌓인다."""
    for v in all_videos:
        prev = prev_map.get(v["videoId"])
        if prev is None:
            v["weekGain"] = None
            v["stillEarning"] = False
            continue
        gain = v["viewCount"] - prev
        v["weekGain"] = gain if gain >= 0 else None  # 감소는 집계 오차 — 무시
        v["stillEarning"] = bool(
            v["age"] >= 90 and gain is not None
            and gain >= max(1000, int(v["viewCount"] * 0.01)))


_FIELDS = ("videoId", "title", "channelId", "channelTitle", "publishedAt", "viewCount",
           "subscriberCount", "efficiency", "mult", "age", "thumbnail", "weekGain", "stillEarning")


def pick(all_videos):
    """나이 창(60~365일) + 효율 2배+ + 조회 3만+ 필터 → 효율 내림차순 상위 TOP_N."""
    def ok(v):
        eff = v.get("efficiency")
        if eff is None:
            return False
        return (eff >= MIN_EFF and v["viewCount"] >= MIN_VIEWS
                and MIN_AGE_DAYS <= v["age"] <= MAX_AGE_DAYS
                and not _JUNK_TITLE.search(v["title"])
                and not _MARKET_NOISE.search(v["title"])
                and not _NEWS_MARKER.search(v["title"]))
    picked = [v for v in all_videos if ok(v)]
    # ★정렬은 반올림 전 원본 비율(조회÷구독)로 — 표시용 efficiency(소수1자리)로 정렬하면
    #   상위에서 반올림 동률이 생겨 순서가 원본순으로 밀린다. 동률이면 참고 배수(mult).
    picked.sort(key=lambda v: (-(v["viewCount"] / v["subscriberCount"]), -(v["mult"] or 0)))
    return [{k: v.get(k) for k in _FIELDS} for v in picked[:TOP_N]]


def main():
    channels = json.load(open(os.path.join(BASE, "channels.json"), encoding="utf-8"))
    now = datetime.now(timezone.utc)
    # ★지난주 스캔의 조회수 스냅샷 (감쇠곡선 신호용). 신·구 구조 모두 읽어 하위호환.
    prev_map = {}
    try:
        prev = json.load(open(os.path.join(BASE, "evergreen.json"), encoding="utf-8"))
        for c in (prev.get("categories") or {}).values():
            for v in c.get("videos", []):                       # 신 구조
                prev_map[v["videoId"]] = v.get("viewCount", 0)
            for r in c.get("remakes", []):                      # 구 구조 하위호환
                for v in r.get("videos", []):
                    prev_map[v["videoId"]] = v.get("viewCount", 0)
            for v in c.get("singles", []):
                prev_map[v["videoId"]] = v.get("viewCount", 0)
    except Exception:
        pass
    result = {"generatedAt": now.isoformat(),
              "window": {"minAgeDays": MIN_AGE_DAYS, "maxAgeDays": MAX_AGE_DAYS,
                         "minEff": MIN_EFF, "minViews": MIN_VIEWS},
              "categories": {}}
    for cat in ("경제", "역사"):
        chs = (channels.get(cat) or {}).get("kr") or []
        if not chs:
            continue
        ch_ids = [c["id"] for c in chs if (c.get("id") or "").startswith("UC")]
        subs = fetch_subs(ch_ids)
        all_videos = []
        for i, ch in enumerate(chs):
            try:
                all_videos += scan_channel(ch, now, subs.get(ch.get("id"), 0))
            except RuntimeError:
                raise
            except Exception as e:
                print("채널 실패 %s: %s" % (ch.get("title"), e), file=sys.stderr)
            if (i + 1) % 50 == 0:
                print("[%s] %d/%d 채널..." % (cat, i + 1, len(chs)), file=sys.stderr)
        attach_weekly_gain(all_videos, prev_map)
        videos = pick(all_videos)
        result["categories"][cat] = {"videos": videos, "scannedVideos": len(all_videos)}
        print("[%s] 채널 %d개 → 영상 %d개 → 효율 2배+ 노출 %d편" %
              (cat, len(chs), len(all_videos), len(videos)), file=sys.stderr)
    total = sum(c.get("scannedVideos", 0) for c in result["categories"].values())
    if result["categories"] and total == 0:
        print("전 카테고리 0개 — 키 장애 의심. 미저장.", file=sys.stderr)
        sys.exit(1)
    with open(os.path.join(BASE, "evergreen.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("evergreen.json 저장 완료", file=sys.stderr)


if __name__ == "__main__":
    main()

# ── 판별 기준 출처 ──
# - 효율(조회÷구독) = '떡상'/breakout 지표: daily_briefing.py와 동일. 구독자 밖으로 퍼진 것 = 소재의 힘.
# - 배수(조회÷평소중앙값) 보조 지표·연령 보정 코호트: vidIQ 'similar timeframe', OutlierKit.
#   (효율은 구독자 많고 평소 조회 낮은 채널의 진짜 대박을 저평가 → 배수를 참고로 병기)
# - 나이 창 60~365일: 60일 미만은 진행형 핫이슈(에버그린 확정 불가), 1년까지가 이번 개편 범위.
