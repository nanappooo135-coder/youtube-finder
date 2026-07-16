# -*- coding: utf-8 -*-
"""해외(경제) 등록 채널 메타데이터 보강 — 정리(활동성·정체성 필터)용 원자료 수집.

channels.json의 경제.foreign 전체에 대해:
- channels.list(50개 배치): 구독자·영상수·설명·국가
- uploads playlistItems(채널당 1콜): 최근 영상 5개 제목+게시일
결과를 scripts/economy/foreign_enriched.json으로 저장. GitHub Actions(YT_KEYS)로 실행.
쿼터: 배치 28유닛 + 채널당 1유닛 ≈ 1,400유닛 (검색 스윕과 달리 저렴).
"""
import json
import os
import urllib.request
import urllib.parse

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = [k.strip() for k in (os.environ.get("YOUTUBE_API_KEY", "")).replace("\n", ",").split(",") if k.strip()]
_ki = 0

OUT = os.path.join(BASE, "scripts", "economy", "foreign_enriched.json")


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


def main():
    chs = json.load(open(os.path.join(BASE, "channels.json"), encoding="utf-8"))["경제"]["foreign"]
    ids = [c["id"] for c in chs if c.get("id", "").startswith("UC")]
    print("foreign channels:", len(ids), "keys:", len(KEYS))

    meta = {}
    for b in range(0, len(ids), 50):
        r = api("channels", part="snippet,statistics", id=",".join(ids[b:b + 50]), maxResults=50)
        for it in r.get("items", []):
            sn, st = it["snippet"], it.get("statistics", {})
            meta[it["id"]] = {
                "id": it["id"],
                "title": sn.get("title", ""),
                "desc": (sn.get("description", "") or "")[:300],
                "country": sn.get("country", ""),
                "subs": int(st.get("subscriberCount", 0) or 0),
                "videoCount": int(st.get("videoCount", 0) or 0),
            }
    print("meta:", len(meta))

    results = []
    for i, cid in enumerate(ids):
        m = meta.get(cid)
        if not m:
            results.append({"id": cid, "missing": True})
            continue
        rec = dict(m)
        try:
            r = api("playlistItems", part="snippet,contentDetails", playlistId="UU" + cid[2:], maxResults=5)
            rec["recent"] = [
                {
                    "t": it["snippet"].get("title", ""),
                    "d": it["contentDetails"].get("videoPublishedAt") or it["snippet"].get("publishedAt", ""),
                }
                for it in r.get("items", [])
            ]
        except RuntimeError:
            raise
        except Exception:
            rec["recent"] = []  # 재생목록 없음(빈 채널) 등
        results.append(rec)
        if (i + 1) % 200 == 0:
            print("progress:", i + 1)

    json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("saved:", OUT, len(results))


if __name__ == "__main__":
    main()
