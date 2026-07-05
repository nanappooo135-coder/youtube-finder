# -*- coding: utf-8 -*-
"""아침 자동 브리핑 — 등록 벤치 채널 전체(경제+역사)의 최근 24시간 영상을 스캔해
'오늘의 먹잇감'(급상승·떡상 Top)을 briefing.json으로 저장. GitHub Actions가 매일 아침 실행.

지표:
- 급상승(velocity) = 조회수 ÷ 게시 후 경과시간(시간당 조회수) — "지금 뜨는 중"
- 떡상(efficiency) = 조회수 ÷ 구독자수 — "채널 체급 대비 터짐" (작은 채널 떡상 = 소재의 힘)
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
            if e.code in (403, 429):
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
    """채널 목록 → 최근 24h 영상 수집 (채널당 playlistItems 1페이지 = 1유닛)"""
    items = []
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
        for it in r.get("items", []):
            pub = it["contentDetails"].get("videoPublishedAt") or it["snippet"].get("publishedAt")
            if not pub:
                continue
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            if dt < cutoff:
                break  # 업로드목록은 최신순 — 창 밖이면 이 채널 끝
            t = it["snippet"]["title"]
            if t in ("Private video", "Deleted video"):
                continue
            items.append({
                "videoId": it["contentDetails"]["videoId"],
                "title": t,
                "channelId": cid,
                "channelTitle": ch.get("title") or it["snippet"].get("channelTitle", ""),
                "publishedAt": pub,
                "thumbnail": (it["snippet"].get("thumbnails", {}).get("medium", {}) or {}).get("url", ""),
            })
    return items


def enrich(items):
    """조회수·길이·구독자 붙이고 필터"""
    ids = [x["videoId"] for x in items]
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
        out.append({
            **x,
            "viewCount": views,
            "subscriberCount": sub,
            "efficiency": round(views / sub, 1) if sub > 0 else None,
            "velocity": int(views / hours),
        })
    return out


def top_lists(vids):
    rising = sorted(vids, key=lambda x: -x["velocity"])[:TOP_N]
    viral = sorted([v for v in vids if v["efficiency"] is not None], key=lambda x: -x["efficiency"])[:TOP_N]
    return {"rising": rising, "viral": viral, "scanned": len(vids)}


def main():
    channels = json.load(open(os.path.join(BASE, "channels.json"), encoding="utf-8"))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS)
    result = {"generatedAt": datetime.now(timezone.utc).isoformat(), "hours": HOURS, "categories": {}}
    for cat in ("경제", "역사"):
        chs = (channels.get(cat) or {}).get("kr") or []
        if not chs:
            continue
        raw = scan_category(chs, cutoff)
        vids = enrich(raw)
        result["categories"][cat] = top_lists(vids)
        print("[%s] 채널 %d개 → 24h 영상 %d개 → 필터 후 %d개" % (cat, len(chs), len(raw), len(vids)), file=sys.stderr)
    with open(os.path.join(BASE, "briefing.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("briefing.json 저장 완료", file=sys.stderr)


if __name__ == "__main__":
    main()
