# -*- coding: utf-8 -*-
"""♻️ 에버그린 스캔 — "재탕해도 또 터지는 검증된 소재" 발굴. 주간 Actions 배치.

★2026-07-19 신설 (사용자 관찰: "예전에 터졌던 영상 재탕해서 또 폭파한 게 꽤 많다" — 중국 고속열차 실사례).
사냥터(briefing)는 최근 14일 파도만 봄 → 이 스크립트가 반대쪽을 본다:

- 에버그린 아웃라이어: 올라온 지 30일+ 인데 그 채널 평소의 3배+ = 반짝 이슈가 아니라 수요 증명.
  ※연령 보정: 옛 영상은 조회수가 누적돼 유리하므로 같은 연령대(코호트)끼리 중앙값 비교
  (vidIQ 'similar timeframe' 방식 — 신작과 구작을 직접 비교하지 않음).
- 재탕 검증 소재: 같은 소재가 60일+ 간격으로 2번 이상 터짐 = "재탕해도 터진다"가 이미 실험으로 증명.
  최상급 신호. 소재 묶기는 wave_engine(Kiwi 명사 클러스터링) 재사용.

비용: 채널당 playlistItems 2페이지(2유닛) + videos.list 2회(2유닛) ≈ 4유닛.
563채널 ≈ 2,300유닛/회 — 주 1회면 무시할 수준. 산출: evergreen.json (git-scraping 패턴).
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
from wave_engine import cluster, extract_nouns, _JUNK_TITLE  # noqa: E402

KEYS = [k.strip() for k in (os.environ.get("YOUTUBE_API_KEY", "")).replace("\n", ",").split(",") if k.strip()]
_ki = 0

# ── 판별 기준 (2026-07-19 외부 리서치로 확정 — 출처는 파일 하단 주석) ──
PER_CHANNEL = 100          # 채널당 최근 100편 (2페이지)
MIN_DURATION = 480         # 숏폼 제외 (파인더 공통 8분 — 리서치 권고 3분보다 엄격하게 유지)
MIN_AGE_DAYS = 30          # 30일 안 지난 건 '핫이슈'지 에버그린이 아님
HIT_MULT = 5.0             # 히트 = 코호트 평소의 5배+ (업계: 3배 표준이지만 벤치 채널이 커서
                           #   3배는 노이즈 위험 → 5배 하한. 10배+=강함, vidIQ purple/red 구간)
MIN_VIEWS = 30000          # 히트 최소 조회수 3만+ (소재게이트 v2 수요증명 기준과 정합)
COHORT_DAYS = 90           # ★연령 보정: 같은 채널에서 그 영상 ±3개월에 올라온 이웃들과만 비교
                           #   (vidIQ 'similar timeframe' 방식 — 전체 중앙값은 옛 영상 과대평가)
REMAKE_GAP_DAYS = 60       # 재탕 인정: 히트 사이 60일+ (한 시점에 몰린 건 시의성 트렌드일 뿐)
STRONG_CHANNELS = 3        # 서로 다른 채널 3개+ 수렴 = '운이 아니라 패턴' (업계 공통 결정 신호)
SATURATION_WEEKS = 8       # 최근 8주 내 재탕 히트 2개+ = 포화 임박 (1of10: 모멘텀 2~6주 후 포화)
TOP_N = 40


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
    """★연령 보정 중앙값 — 같은 채널에서 그 영상 ±COHORT_DAYS에 올라온 이웃들의 중앙값.
    (vidIQ 'similar timeframe' 방식. 고정 구간 대신 영상별 이웃 창 — 경계 왜곡 없음)
    이웃 5개 미만이면 ±창을 2배로 넓히고, 그래도 부족하면 채널 전체로 폴백."""
    for window in (COHORT_DAYS, COHORT_DAYS * 2):
        pool = [s["viewCount"] for s in siblings
                if s["videoId"] != target["videoId"] and abs(s["age"] - target["age"]) <= window]
        if len(pool) >= 5:
            return _median(pool)
    pool = [s["viewCount"] for s in siblings if s["videoId"] != target["videoId"]]
    return _median(pool) if pool else 0


def scan_channel(ch, now):
    """채널 1개 → 최근 PER_CHANNEL편 수집 + 코호트 중앙값 대비 배수"""
    cid = ch.get("id")
    if not cid or not cid.startswith("UC"):
        return []
    pl = "UU" + cid[2:]
    items, token = [], None
    for _ in range(PER_CHANNEL // 50):
        p = dict(part="snippet,contentDetails", playlistId=pl, maxResults=50)
        if token:
            p["pageToken"] = token
        try:
            r = api("playlistItems", **p)
        except RuntimeError:
            raise
        except Exception:
            return []
        items += r.get("items", [])
        token = r.get("nextPageToken")
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
        v["mult"] = round(v["viewCount"] / v["chMedian"], 1)
    return out


def find_evergreen(all_videos, now):
    """①에버그린 히트 목록 ②재탕 검증 소재(60일+ 간격 2히트+) — wave_engine cluster 재사용"""
    hits = [v for v in all_videos
            if v["age"] >= MIN_AGE_DAYS and v["mult"] >= HIT_MULT and v["viewCount"] >= MIN_VIEWS
            and not _JUNK_TITLE.search(v["title"])]
    # 재탕 감지: 최근(30일 미만) 히트도 클러스터 입력에는 포함 — "옛 히트 + 이번 주 재탕" 조합을 잡아야 함
    recent_hits = [v for v in all_videos
                   if v["age"] < MIN_AGE_DAYS and v["mult"] >= HIT_MULT and v["viewCount"] >= MIN_VIEWS
                   and not _JUNK_TITLE.search(v["title"])]
    pool = hits + recent_hits
    # anchor_pct=0.03: 공유 명사 중 1개+는 풀의 3% 이하 희귀어여야 — '삼성'류 접착제 오묶임 차단
    waves = cluster(pool, anchor_pct=0.03)
    remakes = []
    for w in waves:
        vs = [pool[i] for i in w["video_idx"]]
        if len(vs) < 2:
            continue
        ages = sorted(v["age"] for v in vs)
        gap = ages[-1] - ages[0]
        if gap < REMAKE_GAP_DAYS:
            continue  # 같은 주에 우르르 = 핫이슈지 재탕이 아님
        vs.sort(key=lambda v: v["age"])  # 최신 먼저
        n_ch = len({v["channelId"] for v in vs})
        recent_8w = sum(1 for v in vs if v["age"] <= SATURATION_WEEKS * 7)
        remakes.append({
            "label": w["label"],
            "hits": len(vs),
            "gapDays": gap,
            "lastHitDays": ages[0],
            "channels": n_ch,
            "strong": n_ch >= STRONG_CHANNELS,     # 채널 3개+ 수렴 = 운이 아니라 패턴 (최상급)
            "saturated": recent_8w >= 2,           # 최근 8주에 2개+ 재탕 = 포화 임박 — 각도 재설계 필수
            "bestMult": max(v["mult"] for v in vs),
            "videos": [{k: v[k] for k in ("videoId", "title", "channelId", "channelTitle",
                                          "publishedAt", "viewCount", "mult", "thumbnail", "age")} for v in vs[:6]],
        })
    # 정렬: 강한 검증(3채널+) 먼저 → 히트 수 → 배수
    remakes.sort(key=lambda r: (not r["strong"], -r["hits"], -r["bestMult"]))
    # 단독 에버그린 (재탕엔 안 걸렸지만 오래됐는데 크게 터진 소재)
    remake_ids = {v["videoId"] for r in remakes for v in r["videos"]}
    singles = sorted([v for v in hits if v["videoId"] not in remake_ids], key=lambda v: -v["mult"])[:TOP_N]
    singles = [{k: v[k] for k in ("videoId", "title", "channelId", "channelTitle",
                                  "publishedAt", "viewCount", "mult", "thumbnail", "age")} for v in singles]
    return remakes[:TOP_N], singles


def main():
    channels = json.load(open(os.path.join(BASE, "channels.json"), encoding="utf-8"))
    now = datetime.now(timezone.utc)
    result = {"generatedAt": now.isoformat(), "perChannel": PER_CHANNEL, "categories": {}}
    for cat in ("경제", "역사"):
        chs = (channels.get(cat) or {}).get("kr") or []
        if not chs:
            continue
        all_videos = []
        for i, ch in enumerate(chs):
            try:
                all_videos += scan_channel(ch, now)
            except RuntimeError:
                raise
            except Exception as e:
                print("채널 실패 %s: %s" % (ch.get("title"), e), file=sys.stderr)
            if (i + 1) % 50 == 0:
                print("[%s] %d/%d 채널..." % (cat, i + 1, len(chs)), file=sys.stderr)
        remakes, singles = find_evergreen(all_videos, now)
        result["categories"][cat] = {"remakes": remakes, "singles": singles, "scannedVideos": len(all_videos)}
        print("[%s] 채널 %d개 → 영상 %d개 → 재탕검증 %d소재 · 단독 에버그린 %d개" %
              (cat, len(chs), len(all_videos), len(remakes), len(singles)), file=sys.stderr)
    total = sum(c.get("scannedVideos", 0) for c in result["categories"].values())
    if result["categories"] and total == 0:
        print("전 카테고리 0개 — 키 장애 의심. 미저장.", file=sys.stderr)
        sys.exit(1)
    with open(os.path.join(BASE, "evergreen.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("evergreen.json 저장 완료", file=sys.stderr)


if __name__ == "__main__":
    main()

# ── 판별 기준 출처 (2026-07-19 외부 리서치) ──
# - 배수 임계·색 구간: vidIQ Outliers(2~5/5~10/10+), OutlierKit(3=표준·5=강함·10+=슈퍼)
#   https://support.vidiq.com/en/articles/9660010-outliers
#   https://outlierkit.com/resources/how-to-find-outlier-videos/
# - 연령 보정 = same-timeframe 코호트 비교: vidIQ 'similar timeframe', Overseeros time-window bucketing
#   (전체평균 비교는 옛 영상 과대평가 — views/month 정규화는 급성장 채널 왜곡)
# - 채널 3개+ 수렴 = 패턴: OutlierKit·1of10 ("1편은 운, 여러 채널 반복이면 패턴")
#   https://1of10.com/blog/how-to-find-viral-youtube-videos/
# - 시간 간격 재탕 = 에버그린 증거: Mittalmar 'Outlier Transfer' (캡슐호텔 4년 뒤 재탕 히트)
# - 포화: 1of10 "아웃라이어 모멘텀 2~6주 후 포화" → 최근 8주 급증 = 진입 위험
# - 재탕 정책 리스크: YouTube 2025-07 'inauthentic content' — 각도·리서치 추가 없는 복제 금지
