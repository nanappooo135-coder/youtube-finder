"""
수집된 raw 데이터에 성과 메트릭 추가
- outperformance: 채널 중앙값 대비 조회수 배수 (진짜 '히트' 신호)
- recency_weight: 최근 영상에 가중치
- engagement_rate: 좋아요/조회수 비율
- days_old: 며칠 전 영상인지
- 영상 길이 카테고리

입력: dataset_raw.json
출력: dataset_metrics.json
"""

import json
import sys
import statistics
from datetime import datetime, date
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
if sys.stderr.encoding != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8")

BASE = Path(__file__).parent
RAW = BASE / "dataset_raw.json"
OUT = BASE / "dataset_metrics.json"


def compute_recency_weight(days_old):
    """오래된 영상일수록 가중치 감소. 무너짐 패턴 분석에서 최근 트렌드를 우선시."""
    if days_old <= 30: return 1.0
    if days_old <= 90: return 0.7
    if days_old <= 180: return 0.4
    if days_old <= 365: return 0.2
    return 0.1


def duration_tier(seconds):
    if seconds < 60: return "쇼츠"
    if seconds < 300: return "짧음(<5분)"
    if seconds < 900: return "중간(5-15분)"
    if seconds < 1800: return "긴편(15-30분)"
    return "롱폼(30분+)"


def channel_tier(subs):
    if subs < 10_000: return "초소(5K미만)"
    if subs < 50_000: return "소형(10-50K)"
    if subs < 200_000: return "중소(50-200K)"
    if subs < 1_000_000: return "중형(200K-1M)"
    return "대형(1M+)"


def main():
    if not RAW.exists():
        print(f"Error: {RAW} 없음. fetch_dataset.py 먼저 실행 필요.")
        sys.exit(1)

    with open(RAW, "r", encoding="utf-8") as f:
        raw = json.load(f)

    today = date.today()
    result = {}

    # 예능·오락·결 안 맞는 채널 블랙리스트
    BLACKLIST_CHANNELS = [
        "tvN", "tvN Joy", "디글", "잠뜰", "1급 비밀", "KTV", "14F",
        "압권", "Kkuk", "꾹TV", "스포일러", "교양만두", "VIDEOMUG", "비디오머그",
        # v2 추가 - 결 명백히 다름
        "EBSCulture", "EBSDocumentary", "EBS 교양", "EBS 다큐",
        "연예 뒤통령", "이진호", "셀레나이민", "꿀잼쓰토리",
        # v3 추가 - 방송사·뉴스 채널 (1~3분 클립 위주, 작가 채널 결과 다름)
        "한국경제TV", "한국경제TV뉴스", "한국경제 ", "채널A News", "채널A뉴스",
        "JTBC News", "JTBC뉴스", "JTV뉴스", "뉴스1TV", "뉴스토마토",
        "MTN 머니투데이방송", "매일경제TV", "머니투데이방송", "서울경제TV",
        "한국광해광업", "광화문스퀘어",  # 정부·시사 단편
        "연합뉴스경제TV", "KBS 경제한방", "CBS 경제연구실", "딜사이트경제TV",
        "TV조선경제", "MBN뉴스", "SBS뉴스",
    ]

    for ch_key, ch_data in raw.items():
        name = ch_data.get("channel_name", "")
        if any(b in name for b in BLACKLIST_CHANNELS):
            continue  # 채널 자체 제외

        videos = ch_data.get("videos", [])
        if not videos:
            continue

        # 숏폼·뉴스클립 제외 (3분 미만)
        videos = [v for v in videos if (v.get("duration", 0) or 0) >= 180]
        if not videos:
            continue

        # 채널 통계 계산
        view_list = [v["views"] for v in videos if v["views"] > 0]
        if not view_list:
            continue

        median_views = statistics.median(view_list)
        mean_views = statistics.mean(view_list)
        max_views = max(view_list)
        subs = ch_data.get("subs", 0)

        # 각 영상에 메트릭 부여
        enriched_videos = []
        for v in videos:
            views = v["views"]
            likes = v.get("likes", 0)
            comments = v.get("comments", 0)
            date_str = v.get("date", "")

            # 며칠 전?
            days_old = 9999
            if date_str:
                try:
                    pub = datetime.strptime(date_str, "%Y-%m-%d").date()
                    days_old = (today - pub).days
                except: pass

            outperf = round(views / median_views, 2) if median_views > 0 else 0
            outperf_vs_subs = round(views / subs, 3) if subs > 0 else 0
            engagement = round((likes + comments * 3) / views, 4) if views > 0 else 0
            recency_w = compute_recency_weight(days_old)

            # 핵심 점수: 성과 × 시간 가중치
            hit_score = round(outperf * recency_w, 2)

            enriched_videos.append({
                "id": v["id"],
                "title": v["title"],
                "date": date_str,
                "days_old": days_old,
                "views": views,
                "likes": likes,
                "comments": comments,
                "duration": v.get("duration", 0),
                "duration_tier": duration_tier(v.get("duration", 0)),
                "outperformance": outperf,        # 채널 중앙값 대비
                "outperf_vs_subs": outperf_vs_subs,  # 구독자 대비
                "engagement_rate": engagement,
                "recency_weight": recency_w,
                "hit_score": hit_score,            # 종합: outperf × recency
            })

        result[ch_key] = {
            "channel_id": ch_data.get("channel_id", ""),
            "channel_name": ch_data.get("channel_name", ""),
            "subs": subs,
            "channel_tier": channel_tier(subs),
            "stats": {
                "video_count": len(videos),
                "median_views": int(median_views),
                "mean_views": int(mean_views),
                "max_views": max_views,
            },
            "videos": enriched_videos,
        }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    total_videos = sum(len(c["videos"]) for c in result.values())
    print(f"=== 메트릭 계산 완료 ===")
    print(f"채널: {len(result)}개")
    print(f"영상: {total_videos:,}개")
    print(f"출력: {OUT}")

    # 상위 히트 미리보기
    all_videos = []
    for ch_key, ch_data in result.items():
        for v in ch_data["videos"]:
            v_copy = dict(v)
            v_copy["channel_name"] = ch_data["channel_name"]
            all_videos.append(v_copy)

    print(f"\n=== Hit Score 상위 15개 미리보기 ===")
    top = sorted(all_videos, key=lambda x: -x["hit_score"])[:15]
    for v in top:
        print(f"  {v['hit_score']:>6.1f} | {v['outperformance']:>5.1f}x | {v['views']:>9,}회 | {v['date']} | {v['channel_name'][:18]:<18} | {v['title'][:50]}")


if __name__ == "__main__":
    main()
