# -*- coding: utf-8 -*-
"""아침 자동 브리핑 — 등록 벤치 채널 전체(경제+역사)의 최근 24시간 영상을 스캔해
'오늘의 먹잇감'(급상승·떡상 Top)을 briefing.json으로 저장. GitHub Actions가 매일 아침 실행.

지표:
- 급상승(velocity) = 조회수 ÷ 게시 후 경과시간(시간당 조회수) — "지금 뜨는 중"
- 떡상(efficiency) = 조회수 ÷ 구독자수 — "채널 체급 대비 터짐" (작은 채널 떡상 = 소재의 힘)
- ★배수(mult) = 조회수 ÷ 그 채널 평소 중앙값 (2026-07-19) — 효율의 함정 보완:
  구독자 많은데 평소 조회 낮은 채널의 대박(효율은 낮게 나옴)·유령구독 채널의 진짜 터짐을 잡는다.
  평소 중앙값 = 최근 20개 중 3~90일 지난 성숙 영상(숏폼 제외) 중앙값. 1of10/ViewStats 업계 표준 방식.
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

HOURS = 24                 # 스캔 창: 최근 24시간
MIN_VIEWS = 1000           # 최소 조회수 (잡음 컷)
MIN_DURATION = 480         # 8분 미만(숏폼) 제외 — 파인더와 동일
TOP_N = 10


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
            # ★2026-07-17: 400(무효 키)도 키 로테이션 대상 — 7/5 유출사고 정리 때 삭제된 키가
            #   목록 첫 번째에 있어서, 400에서 즉시 raise → 전 채널 침묵 실패 12일(스캔 0개인데 워크플로 성공).
            #   무효 키 하나가 전체를 죽이면 안 되므로 quota(403/429)와 똑같이 다음 키로 넘어간다.
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


def scan_category(channels, cutoff):
    """채널 목록 → 최근 24h 영상 수집 (채널당 playlistItems 1페이지 = 1유닛)
    ★2026-07-19: 같은 1페이지(20개)를 채널 '평소 성적' 표본으로도 재활용 — baseline에 전량 보존."""
    items = []
    baseline = {}  # channelId -> [(videoId, publishedAt)] 최근 20개 (평소 중앙값 계산용)
    for ch in channels:
        cid = ch.get("id")
        if not cid or not cid.startswith("UC"):
            continue
        pl = "UU" + cid[2:]
        try:
            r = api("playlistItems", part="snippet,contentDetails", playlistId=pl, maxResults=20)
        except RuntimeError:
            raise
        except Exception:
            continue  # 재생목록 없음(빈 채널) 등
        base = []
        for it in r.get("items", []):
            pub = it["contentDetails"].get("videoPublishedAt") or it["snippet"].get("publishedAt")
            if not pub:
                continue
            t = it["snippet"]["title"]
            if t in ("Private video", "Deleted video"):
                continue
            base.append((it["contentDetails"]["videoId"], pub))
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            if dt < cutoff:
                continue  # 창 밖 영상도 baseline엔 남긴다 (break 금지)
            items.append({
                "videoId": it["contentDetails"]["videoId"],
                "title": t,
                "channelId": cid,
                "channelTitle": ch.get("title") or it["snippet"].get("channelTitle", ""),
                "publishedAt": pub,
                "thumbnail": (it["snippet"].get("thumbnails", {}).get("medium", {}) or {}).get("url", ""),
            })
        if base:
            baseline[cid] = base
    return items, baseline


def _median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return 0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def channel_medians(baseline, stats, now):
    """채널별 평소 중앙값 — 3~90일 성숙 영상(숏폼 제외) 중앙값, 5개 미만이면 전체로 폴백"""
    med = {}
    for cid, vids in baseline.items():
        matured, allv = [], []
        for vid, pub in vids:
            v = stats.get(vid)
            if not v:
                continue
            if parse_dur(v["contentDetails"].get("duration")) < MIN_DURATION:
                continue  # 숏폼이 중앙값을 끌어내리는 것 방지
            views = int(v["statistics"].get("viewCount", 0))
            allv.append(views)
            age = (now - datetime.fromisoformat(pub.replace("Z", "+00:00"))).days
            if 3 <= age <= 90:
                matured.append(views)
        src = matured if len(matured) >= 5 else allv
        if len(src) >= 3:  # 표본 3개 미만이면 중앙값 무의미 — 배수 미계산
            med[cid] = max(1, _median(src))
    return med


def enrich(items, baseline):
    """조회수·길이·구독자 붙이고 필터 + ★평소 대비 배수(mult)"""
    # 24h 영상 + 채널 평소표본(최근 20개) 통계를 한 번에 (50개 배치 = 1유닛)
    base_ids = [vid for vids in baseline.values() for vid, _ in vids]
    ids = list(dict.fromkeys([x["videoId"] for x in items] + base_ids))
    stats = {}
    for i in range(0, len(ids), 50):
        r = api("videos", part="statistics,contentDetails", id=",".join(ids[i:i + 50]))
        for v in r.get("items", []):
            stats[v["id"]] = v
    ch_ids = list({x["channelId"] for x in items})
    subs = {}
    for i in range(0, len(ch_ids), 50):
        r = api("channels", part="statistics", id=",".join(ch_ids[i:i + 50]))
        for c in r.get("items", []):
            st = c["statistics"]
            subs[c["id"]] = 0 if st.get("hiddenSubscriberCount") else int(st.get("subscriberCount", 0))
    now = datetime.now(timezone.utc)
    med = channel_medians(baseline, stats, now)
    out = []
    for x in items:
        v = stats.get(x["videoId"])
        if not v:
            continue
        if parse_dur(v["contentDetails"].get("duration")) < MIN_DURATION:
            continue
        views = int(v["statistics"].get("viewCount", 0))
        if views < MIN_VIEWS:
            continue
        sub = subs.get(x["channelId"], 0)
        hours = max(1.0, (now - datetime.fromisoformat(x["publishedAt"].replace("Z", "+00:00"))).total_seconds() / 3600)
        m = med.get(x["channelId"], 0)
        out.append({
            **x,
            "viewCount": views,
            "subscriberCount": sub,
            "efficiency": round(views / sub, 1) if sub > 0 else None,
            "velocity": int(views / hours),
            "chMedian": m or None,
            "mult": round(views / m, 1) if m else None,
        })
    return out


def top_lists(vids):
    rising = sorted(vids, key=lambda x: -x["velocity"])[:TOP_N]
    viral = sorted([v for v in vids if v["efficiency"] is not None], key=lambda x: -x["efficiency"])[:TOP_N]
    # ★배수 Top(2026-07-19): 그 채널 평소 대비 몇 배 터졌나 — 효율(구독자 함정)의 진짜 보정판
    outlier = sorted([v for v in vids if v["mult"] is not None], key=lambda x: -x["mult"])[:TOP_N]
    # ★2026-07-17 파도 레이더 광각 그물용: 상위 20개만 남기고 버리던 하루치 수확 전량을 보존
    #   (업계 표준 = DB 전량에 아웃라이어 점수 — 1of10/TubeLab 방식. 208개×300B ≈ 60KB라 부담 없음)
    allv = sorted(vids, key=lambda x: -(x["mult"] or x["efficiency"] or 0))
    return {"rising": rising, "viral": viral, "outlier": outlier, "scanned": len(vids), "videos": allv}


def main():
    channels = json.load(open(os.path.join(BASE, "channels.json"), encoding="utf-8"))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS)
    result = {"generatedAt": datetime.now(timezone.utc).isoformat(), "hours": HOURS, "categories": {}}
    for cat in ("경제", "역사"):
        chs = (channels.get(cat) or {}).get("kr") or []
        if not chs:
            continue
        raw, baseline = scan_category(chs, cutoff)
        vids = enrich(raw, baseline)
        result["categories"][cat] = top_lists(vids)
        print("[%s] 채널 %d개 → 24h 영상 %d개 → 필터 후 %d개" % (cat, len(chs), len(raw), len(vids)), file=sys.stderr)
    # ★침묵 실패 방지(2026-07-17): 7/5~7/16 12일간 API 키가 죽어 전 카테고리 0개를
    #   저장하면서도 워크플로는 '성공'이었다 — 등록채널 800개+가 24h에 영상 0개일 수는 없으므로
    #   전 카테고리 0개면 키/네트워크 장애로 보고 exit 1 → Actions가 빨간불 → 즉시 발견.
    #   (빈 briefing.json은 저장하지 않음 — 마지막 정상본 유지가 빈 깡통보다 낫다)
    total_scanned = sum((c or {}).get("scanned", 0) for c in result["categories"].values())
    if result["categories"] and total_scanned == 0:
        print("★전 카테고리 스캔 0개 — API 키 장애 의심. briefing.json 미갱신, 실패 처리.", file=sys.stderr)
        sys.exit(1)
    with open(os.path.join(BASE, "briefing.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("briefing.json 저장 완료", file=sys.stderr)


if __name__ == "__main__":
    main()
