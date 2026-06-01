"""
이미지 프롬프트 검수기 — JSON 생성 후, 이미지 생성 전에 실행
FAIL이 하나라도 있으면 이미지 생성 차단

사용법:
  python _시스템/scripts/validators/image_prompt_validator.py scenes_classified.json

종료 코드:
  0 = 통과 (이미지 생성 가능)
  1 = FAIL 있음 (이미지 생성 차단)
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("scenes", data if isinstance(data, list) else [])


def validate(scenes):
    fails = []
    warnings = []

    for s in scenes:
        sid = s.get("sceneNo") or s.get("scene") or s.get("id") or "?"
        stype = s.get("type", "ai")
        narration = s.get("narration", "")
        nano = s.get("nano_prompt", "") or ""
        is_intro = s.get("isIntro", False)

        prefix = "Scene {}".format(sid)

        # === 1. 영어 텍스트 오버레이 위험 감지 ===
        overlay_patterns = [
            r'\btitle\s+(reading|saying|showing)',
            r'\bheader\b',
            r'\bcaption\b',
            r'\bbanner\s+(reading|saying|with text)',
            r'\blabeled\s+(as|with|in)',
            r'\btext\s+(reading|saying|overlay)',
            r'\btitle\s+at\s+top',
            r'\btop.*reading',
            r'\bbottom.*reading',
        ]
        for pat in overlay_patterns:
            if re.search(pat, nano, re.IGNORECASE):
                fails.append("{} [FAIL] 제목/헤더 오버레이 위험: '{}'".format(prefix, pat))
                break

        # === 2. 대문자 영어 문장 감지 (제목처럼 보이는 것) ===
        upper_matches = re.findall(r'[A-Z][A-Z\s]{10,}', nano)
        if upper_matches:
            for m in upper_matches:
                if m.strip() not in ("ABSOLUTE RULE", "NO", "STRICT RULES"):
                    warnings.append("{} [WARN] 대문자 영어 제목 감지: '{}'".format(prefix, m.strip()[:40]))

        # === 3. 설명형 장면이 ai로 분류됐는지 감지 ===
        if stype == "ai":
            explain_patterns = [
                r'\bcomparison\b', r'\bchart\b', r'\bdiagram\b',
                r'\binfographic\b', r'\btimeline\b', r'\bbar graph\b',
                r'\bpie chart\b', r'\bflowchart\b', r'\bvs\b',
                r'\bstatistics\b', r'\bdata visualization\b',
            ]
            for pat in explain_patterns:
                if re.search(pat, nano, re.IGNORECASE):
                    fails.append("{} [FAIL] 설명/차트형 장면인데 ai로 분류됨 → claude_design으로 변경 필요: '{}'".format(prefix, pat))
                    break

        # === 3.5 과장 톤 키워드 감지 (dramatic/cinematic 등) ===
        dramatic_words = [
            r'\bdramatic\b', r'\bcinematic\b', r'\bblazing\b', r'\bbrilliant\b',
            r'\bfierce\b', r'\bdevastating\b', r'\bgut-wrenching\b', r'\bbreathtaking\b',
            r'\bepic\b', r'\bmajestic\b', r'\bmagnificent\b', r'\btremendous\b',
        ]
        for pat in dramatic_words:
            if re.search(pat, nano, re.IGNORECASE):
                fails.append("{} [FAIL] 과장 톤 키워드 '{}' — 다큐멘터리 톤으로 차분하게 수정 필요".format(prefix, pat.replace(r'\b', '')))
                break

        # === 4. ABSOLUTE RULE 없고 한국어 지시도 없는 장면 ===
        has_absolute = "ABSOLUTE RULE" in nano
        has_korean_instruction = bool(re.search(r'[가-힣]', nano)) or "Korean" in nano or "한국" in nano or "한글" in nano
        if not has_absolute and not has_korean_instruction and stype == "ai":
            warnings.append("{} [WARN] 텍스트 금지도 없고 한국어 지시도 없음 → 영어로 채워질 위험".format(prefix))

        # === 5. 대본 맥락: 한국 장면인데 Korean 미명시 ===
        korea_keywords = ["한국", "조선소", "서울", "부산", "거제", "울산", "통영", "제주", "전주", "효성", "삼성중공업", "현대중공업", "대우조선", "가스공사"]
        is_korea_scene = any(kw in narration for kw in korea_keywords)
        if is_korea_scene and "Korean" not in nano and "한국" not in nano and "Korea" not in nano and stype == "ai":
            fails.append("{} [FAIL] 한국 장면인데 nano_prompt에 Korean/Korea 미명시".format(prefix))

        # === 6. 시대 명시 확인 ===
        year_in_narration = re.search(r'(19\d{2}|20\d{2})년', narration)
        if year_in_narration:
            year = year_in_narration.group(1)
            if year not in nano and "{}0s".format(year[:3]) not in nano:
                fails.append("{} [FAIL] 나레이션에 {}년인데 nano_prompt에 시대 미반영".format(prefix, year))

        # === 7. nano_prompt 비어있거나 placeholder ===
        if stype == "ai" and (not nano or nano == "null" or nano == "placeholder" or len(nano) < 30):
            fails.append("{} [FAIL] nano_prompt가 비어있거나 너무 짧음".format(prefix))

        # === 8. sceneNo/scene 필드 존재 확인 ===
        if sid == "?":
            fails.append("{} [FAIL] scene 번호 필드 없음 (sceneNo/scene/id)".format(prefix))

        # === 9. intro 장면 규칙 ===
        if is_intro:
            if stype != "ai":
                fails.append("{} [FAIL] 도입부인데 type이 '{}' (ai여야 함)".format(prefix, stype))
            if s.get("duration") != 6:
                warnings.append("{} [WARN] 도입부인데 duration이 {} (6이어야 함)".format(prefix, s.get("duration")))

        # === 10. 스타일 라인 누락 체크 (어떤 그림체든 스타일 지시가 있는지만 확인) ===
        if stype == "ai" and nano and len(nano) > 30:
            style_indicators = ["illustration", "style", "texture", "linework", "painted", "watercolor", "pastel", "cartoon", "realistic", "hand-drawn"]
            has_style = any(kw in nano.lower() for kw in style_indicators)
            if not has_style:
                warnings.append("{} [WARN] 스타일 라인 누락 — 그림체 지시 없으면 AI가 맘대로 그림".format(prefix))

        # === 11. 특정 브랜드/인물 미반영 ===
        brand_map = {
            "GTT": ["GTT", "gtt", "French", "france"],
            "삼성중공업": ["Samsung", "samsung", "Korean shipyard"],
            "현대중공업": ["Hyundai", "hyundai", "Korean shipyard"],
            "한진평택호": ["Hanjin", "hanjin"],
            "KC-1": ["KC-1", "KC1", "cargo containment"],
            "KC-2C": ["KC-2C", "KC2C", "cargo containment"],
            "SK세레니티": ["SK Serenity", "serenity"],
        }
        for brand, checks in brand_map.items():
            if brand in narration:
                found = any(c.lower() in nano.lower() for c in checks)
                if not found and stype == "ai":
                    warnings.append("{} [WARN] 나레이션에 '{}'가 있는데 프롬프트에 미반영".format(prefix, brand))

        # === 12. real 장면 필수 필드 체크 ===
        if stype == "real":
            if not s.get("real_keywords"):
                fails.append("{} [FAIL] real 장면인데 real_keywords 없음".format(prefix))
            elif len(s.get("real_keywords", [])) != 3:
                warnings.append("{} [WARN] real_keywords가 3개가 아님 (현재 {}개)".format(prefix, len(s.get("real_keywords", []))))
            if not s.get("real_subject"):
                fails.append("{} [FAIL] real 장면인데 real_subject 없음".format(prefix))

        # === 13. claude_design 장면 필수 필드 체크 ===
        if stype == "claude_design":
            if not s.get("claude_prompt"):
                fails.append("{} [FAIL] claude_design 장면인데 claude_prompt 없음".format(prefix))
            if not s.get("claude_kind"):
                fails.append("{} [FAIL] claude_design 장면인데 claude_kind 없음".format(prefix))

    # === 14. 구도 반복 체크 ===
    looking_up_count = 0
    sitting_office_count = 0
    for s in scenes:
        nano = s.get("nano_prompt", "") or ""
        if re.search(r'looking up at.{0,30}(building|tower|structure|gate|pyramid)', nano, re.IGNORECASE):
            looking_up_count += 1
        if re.search(r'sitting.{0,20}(office|desk|chair)', nano, re.IGNORECASE):
            sitting_office_count += 1
    if looking_up_count > 1:
        fails.append("[FAIL] '올려다봄' 구도 {}회 반복 (1회만 허용)".format(looking_up_count))
    if sitting_office_count > 3:
        warnings.append("[WARN] '사무실 앉아있기' 구도 {}회 반복 (3회 이하 권장)".format(sitting_office_count))

    # === 14.5 같은 엔티티 real 3회 초과 체크 ===
    real_subjects = [s.get("real_subject", "") for s in scenes if s.get("type") == "real"]
    for subj, cnt in Counter(real_subjects).items():
        if cnt > 3 and subj:
            fails.append("[FAIL] real_subject '{}' {}회 반복 (3회 초과 금지)".format(subj, cnt))

    # === 15. type 비율 체크 ===
    # (기존 14.5에서 이어짐)
    total = len(scenes)
    intro_count = sum(1 for s in scenes if s.get("isIntro"))
    body_count = total - intro_count
    if body_count > 0:
        real_count = sum(1 for s in scenes if s.get("type") == "real")
        cd_count = sum(1 for s in scenes if s.get("type") == "claude_design")
        real_pct = real_count / total * 100
        cd_pct = cd_count / total * 100
        if real_pct < 5:
            warnings.append("[WARN] real 비율 {:.1f}% — 너무 낮음 (7~15% 권장)".format(real_pct))
        elif real_pct > 20:
            warnings.append("[WARN] real 비율 {:.1f}% — 너무 높음 (7~15% 권장)".format(real_pct))
        if cd_pct < 3:
            warnings.append("[WARN] claude_design 비율 {:.1f}% — 너무 낮음 (7~10% 권장)".format(cd_pct))
        elif cd_pct > 20:
            warnings.append("[WARN] claude_design 비율 {:.1f}% — 너무 높음 (강의 느낌 위험)".format(cd_pct))

    # === 16. 총 장면 수 확인 ===
    scene_nums = [s.get("sceneNo") or s.get("scene") or s.get("id") for s in scenes]
    scene_nums = [n for n in scene_nums if n is not None]
    if len(scene_nums) != len(set(scene_nums)):
        fails.append("[FAIL] 중복된 scene 번호 존재")
    expected_max = max(scene_nums) if scene_nums else 0
    if len(scenes) != expected_max:
        warnings.append("[WARN] 장면 수({})와 최대 번호({})가 불일치 — 빠진 장면 있을 수 있음".format(len(scenes), expected_max))

    return fails, warnings


def main():
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    if len(sys.argv) < 2:
        print("사용법: python image_prompt_validator.py <scenes_classified.json>")
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print("[!] 파일 없음: {}".format(path))
        sys.exit(1)

    scenes = load_json(path)
    print("[*] {} scenes 검수 중...".format(len(scenes)))
    print()

    fails, warnings = validate(scenes)

    # 결과 출력
    if warnings:
        print("=== 경고 ({}) ===".format(len(warnings)))
        for w in warnings:
            print("  " + w)
        print()

    if fails:
        print("=== FAIL ({}) ===".format(len(fails)))
        for f in fails:
            print("  " + f)
        print()
        print("[!] FAIL {}개 발견. 이미지 생성 차단.".format(len(fails)))
        print("[!] JSON을 수정한 뒤 다시 검수하세요.")
        sys.exit(1)
    else:
        print("[OK] FAIL 없음. 이미지 생성 가능.")
        if warnings:
            print("[*] 경고 {}개 — 확인 권장.".format(len(warnings)))
        sys.exit(0)


if __name__ == "__main__":
    main()
