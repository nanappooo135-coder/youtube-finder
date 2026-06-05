"""
최종 dataset.json 빌드 (유튜브 파인더 + 큐레이터 공용)

입력: dataset_metrics.json
출력:
  - dataset.json (전체, 유튜브 파인더용)
  - dataset_top.json (Hit Score 상위 1500개, 큐레이터 Knowledge용 — 크기 제약)
  - dataset_summary.md (사람이 읽기 좋은 요약, 큐레이터 보조용)

사용법:
  python build_dataset_json.py                    # 모두 빌드
  python build_dataset_json.py --top 2000          # 상위 N 변경
"""

import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).parent
METRICS_IN = BASE / "dataset_metrics.json"
FULL_OUT = BASE / "dataset.json"
TOP_OUT = BASE / "dataset_top.json"
SUMMARY_OUT = BASE / "dataset_summary.md"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--top", type=int, default=1500, help="dataset_top.json에 담을 영상 수")
    args = parser.parse_args()

    if not METRICS_IN.exists():
        print(f"Error: {METRICS_IN} 없음. compute_metrics.py 먼저 실행.")
        sys.exit(1)

    with open(METRICS_IN, "r", encoding="utf-8") as f:
        metrics = json.load(f)

    # 1) 전체 영상 평탄화 + 썸네일 URL 추가 + 중복 제거
    all_videos = []
    seen_ids = set()  # 영상 ID 중복 추적
    for ch_key, ch_data in metrics.items():
        for v in ch_data["videos"]:
            vid_id = v["id"]
            if vid_id in seen_ids:
                continue  # 같은 영상 ID 두 번째부터 건너뜀
            seen_ids.add(vid_id)
            v_full = dict(v)
            v_full["channel_name"] = ch_data["channel_name"]
            v_full["channel_id"] = ch_data["channel_id"]
            v_full["channel_subs"] = ch_data["subs"]
            v_full["channel_tier"] = ch_data["channel_tier"]
            v_full["channel_median_views"] = ch_data["stats"]["median_views"]
            # 썸네일 URL (video_id로 자동 생성)
            v_full["thumbnail_mq"] = f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg"
            v_full["thumbnail_hq"] = f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"
            v_full["video_url"] = f"https://www.youtube.com/watch?v={vid_id}"
            all_videos.append(v_full)

    # 2) 메타 정보
    meta = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "channel_count": len(metrics),
        "video_count": len(all_videos),
        "version": "v2",
        "schema": {
            "outperformance": "video views / channel median views",
            "outperf_vs_subs": "video views / channel subscriber count",
            "recency_weight": "1.0 (≤30일) / 0.7 (≤90일) / 0.4 (≤180일) / 0.2 (≤365일) / 0.1 (>365일)",
            "hit_score": "outperformance × recency_weight",
        },
    }

    # 3) 전체 JSON (파인더용)
    full = {"meta": meta, "videos": all_videos}
    with open(FULL_OUT, "w", encoding="utf-8") as f:
        json.dump(full, f, ensure_ascii=False, indent=2)
    print(f"✓ {FULL_OUT.name} : {len(all_videos):,}개 영상")

    # 4) 상위 N 추출 (큐레이터용)
    top_sorted = sorted(all_videos, key=lambda x: -x["hit_score"])
    top_videos = top_sorted[: args.top]
    top_payload = {
        "meta": {**meta, "filter": f"hit_score 상위 {args.top}", "video_count": len(top_videos)},
        "videos": top_videos,
    }
    with open(TOP_OUT, "w", encoding="utf-8") as f:
        json.dump(top_payload, f, ensure_ascii=False, indent=2)
    print(f"✓ {TOP_OUT.name} : 상위 {len(top_videos):,}개 (hit_score {top_videos[-1]['hit_score']:.2f} ~ {top_videos[0]['hit_score']:.2f})")

    # 5) 사람이 읽기 좋은 요약 (큐레이터 보조용)
    lines = []
    lines.append("# 푸짐한 경제학 - 벤치마크 데이터셋 요약")
    lines.append("")
    lines.append(f"- 생성: {meta['generated_at']}")
    lines.append(f"- 채널: {meta['channel_count']}개")
    lines.append(f"- 영상: {meta['video_count']:,}개")
    lines.append(f"- 버전: {meta['version']}")
    lines.append("")
    lines.append("## Hit Score 상위 50개 (전체)")
    lines.append("")
    lines.append("| # | Hit | Outperf | 조회수 | 날짜 | 채널 | 제목 |")
    lines.append("|---|---|---|---|---|---|---|")
    for i, v in enumerate(top_sorted[:50], 1):
        title = v["title"].replace("|", "\\|")[:60]
        lines.append(f"| {i} | {v['hit_score']:.1f} | {v['outperformance']:.1f}x | {v['views']:,} | {v['date']} | {v['channel_name']} | {title} |")
    lines.append("")
    lines.append("## 최근 30일 Outperformance 상위 30개")
    lines.append("")
    recent = [v for v in all_videos if v["days_old"] <= 30]
    recent_top = sorted(recent, key=lambda x: -x["outperformance"])[:30]
    lines.append("| # | Outperf | 조회수 | 날짜 | 채널 | 제목 |")
    lines.append("|---|---|---|---|---|---|")
    for i, v in enumerate(recent_top, 1):
        title = v["title"].replace("|", "\\|")[:60]
        lines.append(f"| {i} | {v['outperformance']:.1f}x | {v['views']:,} | {v['date']} | {v['channel_name']} | {title} |")
    lines.append("")
    lines.append("## 채널별 메가히트 (영상별 최고 조회수)")
    lines.append("")
    lines.append("| 채널 | 구독자 | 최고 조회수 | 그 영상 제목 |")
    lines.append("|---|---|---|---|")
    ch_top = []
    for ch_key, ch_data in metrics.items():
        videos = ch_data["videos"]
        if not videos: continue
        top_v = max(videos, key=lambda x: x["views"])
        ch_top.append({
            "name": ch_data["channel_name"],
            "subs": ch_data["subs"],
            "max_views": top_v["views"],
            "title": top_v["title"],
            "date": top_v["date"],
        })
    for c in sorted(ch_top, key=lambda x: -x["max_views"])[:40]:
        title = c["title"].replace("|", "\\|")[:55]
        lines.append(f"| {c['name']} | {c['subs']:,} | {c['max_views']:,} | {title} |")

    with open(SUMMARY_OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"✓ {SUMMARY_OUT.name} : 사람용 요약")

    print(f"\n=== 빌드 완료 ===")
    print(f"파인더용 (전체): {FULL_OUT}")
    print(f"큐레이터용 (압축): {TOP_OUT}")
    print(f"사람용 요약: {SUMMARY_OUT}")


if __name__ == "__main__":
    main()
