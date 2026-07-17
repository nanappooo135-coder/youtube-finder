# -*- coding: utf-8 -*-
"""채널 조회수 진단용 데이터 수집 — 유정경제학 + 벤치 채널들의 최근 업로드 전수(조회수·길이·게시일).

GitHub Actions(YT_KEYS)로 실행 → scripts/economy/channel_audit.json 커밋.
쿼터: 채널당 (1 + 업로드페이지 + 영상통계 배치) ≈ 10유닛 미만, 경쟁채널 검색 3×100유닛.
"""
import json
import os
import urllib.request
import urllib.parse
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = [k.strip() for k in (os.environ.get("YOUTUBE_API_KEY", "")).replace("\n", ",").split(",") if k.strip()]
_ki = 0

TARGET = "UCk1xIGPS2Sory5JT-oc74zQ"  # 유정경제학
COMPETITOR_QUERIES = ["김재민TV", "팬더경제학", "박기자의 심층분석"]
OUT = os.path.join(BASE, "scripts", "economy", "channel_audit.json")


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
            body = ""
            try:
                body = e.read().decode("utf-8", "ignore")
            except Exception:
                pass
            if e.code in (403, 429) or (e.code == 400 and "API key not valid" in body):
                _ki = (_ki + 1) % len(KEYS)
                continue
            print("API ERROR", e.code, endpoint, body[:200])
            raise
    raise RuntimeError("모든 키 소진: %s" % last)


def fetch_channel(cid, max_videos):
    ch = api("channels", part="snippet,statistics,contentDetails", id=cid)["items"]
    if not ch:
        return None
    ch = ch[0]
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    items, token = [], None
    while len(items) < max_videos:
        p = {"part": "snippet,contentDetails", "playlistId": uploads, "maxResults": 50}
        if token:
            p["pageToken"] = token
        r = api("playlistItems", **p)
        items.extend(r.get("items", []))
        token = r.get("nextPageToken")
        if not token:
            break
    items = items[:max_videos]
    vids = [it["contentDetails"]["videoId"] for it in items]
    stats = {}
    for b in range(0, len(vids), 50):
        r = api("videos", part="statistics,contentDetails,snippet", id=",".join(vids[b:b + 50]))
        for v in r.get("items", []):
            stats[v["id"]] = v
    videos = []
    for it in items:
        vid = it["contentDetails"]["videoId"]
        v = stats.get(vid)
        if not v:
            continue
        videos.append({
            "id": vid,
            "title": v["snippet"].get("title", ""),
            "publishedAt": it["contentDetails"].get("videoPublishedAt") or v["snippet"].get("publishedAt", ""),
            "duration": v["contentDetails"].get("duration", ""),
            "views": int(v["statistics"].get("viewCount", 0) or 0),
            "likes": int(v["statistics"].get("likeCount", 0) or 0),
            "comments": int(v["statistics"].get("commentCount", 0) or 0),
        })
    return {
        "id": cid,
        "title": ch["snippet"].get("title", ""),
        "subs": int(ch["statistics"].get("subscriberCount", 0) or 0),
        "totalViews": int(ch["statistics"].get("viewCount", 0) or 0),
        "videoCount": int(ch["statistics"].get("videoCount", 0) or 0),
        "videos": videos,
    }


def main():
    out = {"fetchedAt": datetime.now(timezone.utc).isoformat(), "target": None, "competitors": []}
    print("target 수집:", TARGET)
    out["target"] = fetch_channel(TARGET, 120)
    print("target 영상:", len(out["target"]["videos"]) if out["target"] else 0)

    for q in COMPETITOR_QUERIES:
        try:
            r = api("search", part="snippet", q=q, type="channel", maxResults=3)
            cid = None
            for it in r.get("items", []):
                title = it["snippet"].get("channelTitle") or it["snippet"].get("title", "")
                cid = it["snippet"].get("channelId") or (it.get("id") or {}).get("channelId")
                print("경쟁채널 후보:", q, "->", title, cid)
                if cid:
                    break
            if not cid:
                continue
            data = fetch_channel(cid, 60)
            if data:
                out["competitors"].append(data)
                print("경쟁채널 수집:", data["title"], len(data["videos"]))
        except Exception as e:
            print("경쟁채널 실패:", q, e)

    if not out["target"] or not out["target"]["videos"]:
        raise SystemExit("target 수집 실패 — 깡통 커밋 방지")
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("saved:", OUT)


if __name__ == "__main__":
    main()
