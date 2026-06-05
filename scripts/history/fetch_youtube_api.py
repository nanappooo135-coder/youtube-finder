"""
YouTube Data API v3 기반 채널 데이터 수집 (yt-dlp 대안)

yt-dlp 대비:
- 30배 빠름 (영상당 100ms vs 5~9초)
- Rate limit 없음 (일일 quota만)
- 공식 API라 안정적

사용법:
  1. .env 에 YOUTUBE_API_KEY=... 추가
  2. pip install google-api-python-client
  3. python fetch_youtube_api.py --per-channel 50
  4. --resume 으로 중단된 곳부터 이어서

Quota 비용:
- 채널당: ~3 units (channels.list + playlistItems.list + videos.list 배치)
- 160채널 × 3 units = ~480 units (일일 quota 10,000 중 5%)
"""

import sys
import os
import json
import time
import argparse
import re
from pathlib import Path
from datetime import datetime

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
if sys.stderr.encoding != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8")

BASE = Path(__file__).parent
CHANNELS_FILE = BASE / "channels.txt"
RAW_OUTPUT = BASE / "dataset_raw.json"
ENV_FILE = BASE / ".env"


def load_api_key():
    key = os.environ.get("YOUTUBE_API_KEY")
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("YOUTUBE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    print("❌ YOUTUBE_API_KEY 없음. .env에 추가 필요.")
    sys.exit(1)


def parse_channels_file():
    """channels.txt에서 채널 핸들/ID 추출"""
    lines = CHANNELS_FILE.read_text(encoding="utf-8").splitlines()
    channels = []
    seen = set()
    for line in lines:
        line = line.split("#")[0].strip()
        if not line or line.startswith("##"):
            continue
        if line.startswith("@"):
            key = line.lower()
            if key in seen: continue
            seen.add(key)
            channels.append({"type": "handle", "value": line[1:]})
        elif line.startswith("UC") and len(line) >= 20:
            cid = line.split()[0]
            if cid in seen: continue
            seen.add(cid)
            channels.append({"type": "id", "value": cid})
    return channels


def get_channel_info(youtube, channel_ref):
    """채널 핸들 → 채널 ID + 업로드 플레이리스트 ID 가져오기"""
    try:
        if channel_ref["type"] == "handle":
            resp = youtube.channels().list(
                part="snippet,contentDetails,statistics",
                forHandle=channel_ref["value"]
            ).execute()
        else:
            resp = youtube.channels().list(
                part="snippet,contentDetails,statistics",
                id=channel_ref["value"]
            ).execute()
        items = resp.get("items", [])
        if not items:
            return None, "채널 못 찾음"
        ch = items[0]
        return {
            "channel_id": ch["id"],
            "channel_name": ch["snippet"]["title"],
            "subs": int(ch["statistics"].get("subscriberCount", 0)),
            "uploads_playlist_id": ch["contentDetails"]["relatedPlaylists"]["uploads"],
        }, None
    except Exception as e:
        return None, str(e)[:120]


def get_video_ids(youtube, uploads_playlist_id, max_results=50):
    """업로드 플레이리스트에서 최근 영상 ID 추출 (1 unit)"""
    try:
        resp = youtube.playlistItems().list(
            part="contentDetails",
            playlistId=uploads_playlist_id,
            maxResults=max_results,
        ).execute()
        return [item["contentDetails"]["videoId"] for item in resp.get("items", [])], None
    except Exception as e:
        return [], str(e)[:120]


def get_top_video_ids(youtube, channel_id, max_results=20):
    """채널의 조회수 Top 영상 ID 추출 (search.list = 100 units!)"""
    try:
        resp = youtube.search().list(
            part="id",
            channelId=channel_id,
            order="viewCount",
            type="video",
            maxResults=max_results,
        ).execute()
        return [item["id"]["videoId"] for item in resp.get("items", []) if item.get("id",{}).get("videoId")], None
    except Exception as e:
        return [], str(e)[:120]


def get_videos_details(youtube, video_ids):
    """영상 ID 리스트 → 상세 정보 (50개씩 배치)"""
    if not video_ids: return [], None
    try:
        results = []
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i+50]
            resp = youtube.videos().list(
                part="snippet,statistics,contentDetails",
                id=",".join(batch),
            ).execute()
            for v in resp.get("items", []):
                snippet = v.get("snippet", {})
                stats = v.get("statistics", {})
                cd = v.get("contentDetails", {})
                # duration ISO 8601 → seconds
                dur = cd.get("duration", "PT0S")
                duration_sec = iso_duration_to_seconds(dur)
                ud_full = snippet.get("publishedAt", "")  # 2026-06-04T12:34:56Z
                ud = ud_full[:10] if ud_full else ""
                results.append({
                    "id": v["id"],
                    "title": snippet.get("title", ""),
                    "date": ud,
                    "views": int(stats.get("viewCount", 0)),
                    "likes": int(stats.get("likeCount", 0)),
                    "comments": int(stats.get("commentCount", 0)),
                    "duration": duration_sec,
                })
        return results, None
    except Exception as e:
        return [], str(e)[:120]


def iso_duration_to_seconds(iso):
    """ISO 8601 duration → 초"""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m: return 0
    h, mi, s = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + int(s or 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-channel", type=int, default=50, help="채널당 최근 영상 수")
    parser.add_argument("--top-per-channel", type=int, default=0, help="채널당 Top 조회수 영상 수 (search API, 100 units/콜)")
    parser.add_argument("--resume", action="store_true", help="기존 데이터에 합침 (중복 ID 제외)")
    parser.add_argument("--merge", action="store_true", help="기존 영상과 신규 합쳐서 유지 (1년치 누적용)")
    args = parser.parse_args()

    api_key = load_api_key()
    print(f"✓ API 키 로드")

    try:
        from googleapiclient.discovery import build
    except ImportError:
        print("❌ google-api-python-client 미설치. pip install google-api-python-client")
        sys.exit(1)

    youtube = build("youtube", "v3", developerKey=api_key)

    channels = parse_channels_file()
    print(f"채널 풀: {len(channels)}개")

    # 기존 데이터 로드 (resume 또는 merge)
    result = {}
    if (args.resume or args.merge) and RAW_OUTPUT.exists():
        with open(RAW_OUTPUT, "r", encoding="utf-8") as f:
            result = json.load(f)
        print(f"기존 수집: {len(result)}개 채널 (resume={args.resume}, merge={args.merge})")

    failed = []
    start_t = time.time()

    for i, ch in enumerate(channels):
        key = f"{ch['type']}:{ch['value']}"
        # --resume만: 이미 있으면 skip / --merge: 있어도 신규 fetch + 합치기
        if args.resume and not args.merge and key in result:
            print(f"[{i+1}/{len(channels)}] SKIP {key}", flush=True)
            continue

        info, err = get_channel_info(youtube, ch)
        if err:
            print(f"[{i+1}/{len(channels)}] ❌ {key}: {err}", flush=True)
            failed.append({"channel": key, "error": err})
            continue

        # 1. 최근 영상 fetch (cheap)
        video_ids, err = get_video_ids(youtube, info["uploads_playlist_id"], args.per_channel)
        if err:
            print(f"[{i+1}/{len(channels)}] ❌ {info['channel_name']}: {err}", flush=True)
            failed.append({"channel": key, "error": err})
            continue

        # 2. Top 조회수 영상 fetch (expensive, optional)
        top_ids = []
        if args.top_per_channel > 0:
            top_ids, top_err = get_top_video_ids(youtube, info["channel_id"], args.top_per_channel)
            if top_err:
                print(f"  ⚠ Top fetch 실패: {top_err}", flush=True)

        # 3. 중복 제거하고 합치기
        all_ids = list(dict.fromkeys(video_ids + top_ids))  # 순서 유지 + 중복 제거

        # 4. 상세 정보
        videos, err = get_videos_details(youtube, all_ids)
        if err:
            print(f"  ⚠ 영상 일부 실패: {err}", flush=True)

        # 5. --merge면 기존과 합치기
        if args.merge and key in result:
            existing = result[key].get("videos", [])
            existing_ids = {v["id"] for v in existing}
            new_only = [v for v in videos if v["id"] not in existing_ids]
            from datetime import date as _d, datetime as _dt
            today = _d.today()
            # 365일 넘은 거 제거
            keep_existing = []
            for v in existing:
                if v.get("date"):
                    try:
                        pub = _dt.strptime(v["date"], "%Y-%m-%d").date()
                        if (today - pub).days <= 365:
                            keep_existing.append(v)
                    except: pass
            videos = keep_existing + new_only

        result[key] = {
            "channel_id": info["channel_id"],
            "channel_name": info["channel_name"],
            "subs": info["subs"],
            "videos": videos,
        }
        print(f"[{i+1}/{len(channels)}] ✓ {info['channel_name']} ({info['subs']:,}) — {len(videos)}개 영상", flush=True)

        # 10채널마다 중간 저장
        if (i + 1) % 10 == 0:
            with open(RAW_OUTPUT, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

    # 최종 저장
    with open(RAW_OUTPUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_t
    total_videos = sum(len(c["videos"]) for c in result.values())
    print(f"\n=== 완료 ({elapsed:.0f}초) ===")
    print(f"채널: {len(result)}/{len(channels)}")
    print(f"영상: {total_videos:,}개")
    if failed:
        print(f"실패: {len(failed)}개")
        for f_item in failed[:10]:
            print(f"  - {f_item['channel']}: {f_item['error']}")
    print(f"출력: {RAW_OUTPUT}")


if __name__ == "__main__":
    main()
