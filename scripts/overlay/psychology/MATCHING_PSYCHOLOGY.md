# 심리 채널 오버레이 매칭 규칙 (MATCHING_PSYCHOLOGY)

심리학 채널 영상의 오버레이 자동 매칭 규칙. 렌더러는 경제 채널과 같은 `overlay.html`(글래스모피즘)을 쓰되, **타입 구성·매칭 기준·색 의미가 다르다.** 역사 규칙(MATCHING_HISTORY.md) 적용 금지.

## 절대 원칙 (경제·역사와 동일)

- **핵심만**: 문장 통째 자막 금지. 한 화면 한 초점
- **타이밍 = 말하는 순간**: overlay.source에 나레이션 원문(부분 문자열 그대로)
- **정보 없는 장면은 overlay:null** — 감정·비유·연결 장면은 비움 (절반 이상이 null인 게 정상)
- **숫자·이름·용어는 나레이션에 글자 그대로 있는 것만** (배경지식으로 채우면 검수기가 DROP)
- **★도입부(isIntro:true) 전면 금지**: overlay·popup_text·mood·motion 전부 불가 (그록 영상 전용)
- claude_design 장면도 전면 금지 (자체 정보+애니메이션)

## 타입 12종 — "나레이션에 이런 내용이 나오면 이 타입"

| 타입 | 매칭 조건 (나레이션 기준) | data 필드 | accent |
|------|------------------------|-----------|--------|
| **term** ★심리 전용 | 심리학 용어가 처음 정의될 때 ("이걸 가스라이팅이라고 합니다") | term, def(한 문장) | cyan |
| **experiment** ★심리 전용 | 실험이 처음 소개될 때 ("1961년 예일대에서 실험이") | year, place, subject(피험자/규모) | amber |
| **nametag** | 학자·연구자 첫 등장 ("심리학자 밀그램은") | name, title(직함/소속) | amber |
| **quote** | 학자·피험자의 실제 발언 직접 인용 | quote, by | amber |
| **versus** | 실험군 vs 대조군, A성향 vs B성향 비교 | label, left{value,label}, right{value,label} | cyan |
| **donut** | 비율 1개가 핵심 ("65%가 끝까지 복종했습니다") | value(%), label, legend, rest | red(충격)/cyan |
| **single_stat_card** | 단일 충격 수치 ("피험자 40명 중 26명") | value, label | red |
| **stat_change** | 전후 변화 ("실험 전 10%에서 실험 후 70%로") | from, to, pct, dir, label | amber |
| **bullets** | 신호·증상·단계 나열 ("이런 신호 3가지가 보이면") | title, items | cyan |
| **timeline** | 연구사·발전사 흐름 (연도 2개 이상) | title, events[{year,label}] | amber |
| **ranking** | 순위 ("스트레스 요인 1위는") | title, unit, items | amber |
| **headline** | 숫자 없는 핵심 반전 — **최후의 선택지** | text, highlight | red |

## 타입 우선순위 (시청 유지 효과순)

①실험 수치(donut/single_stat_card/stat_change) → ②비교(versus) → ③용어 정의(term) → ④실험·학자 소개(experiment/nametag) → ⑤인용(quote) → ⑥나열(bullets/timeline/ranking). headline은 마지막.

## 심리 전용 규칙

- **term은 그 용어가 처음 정의되는 장면 1회만.** 같은 용어 재등장 시 term 금지 (인물 카드와 동일 원칙)
- **experiment는 실험당 1회만.** 같은 실험 재언급 시 수치 타입(donut 등)으로
- **nametag은 학자 첫 등장 1회만** (역사 figure와 동일 원칙)
- **def(정의)는 나레이션의 설명을 압축한 한 문장** — 사전적 정의를 지어내지 말 것
- 증상·신호 bullets는 나레이션에 실제 나열된 항목만 (항목 추가 금지)

## accent 색 의미 (심리 채널)

- **cyan** (기본): 정보·정의·차분한 분석 — 심리 채널의 기본 톤
- **red**: 충격 수치·위험 신호·경고
- **amber**: 실험·학자·역사적 맥락
- **green**: 회복·개선·긍정 결과

## 비율·리듬 (공통 규칙 그대로)

- overlay 적용: 전체 장면의 **25~35%** (40% 초과 = 검수기 FAIL)
- 연속 3장면 초과 금지 (3연속 후 1~2장면 강제 공백)
- headline은 전체 오버레이의 25% 이하
- 단일 타입 40% 초과 금지, 8개 이상이면 최소 4종 사용
- popup_text와 같은 장면 동시 사용 금지

## 검증 (필수 실행)

```
python scripts/overlay/validate_overlays.py scenes_classified.json
```
- 출처(source) 나레이션 대조 + 숫자 글자 대조 + term 용어/정의 존재 검사
- DROP이 하나라도 있으면 exit 1 → 해당 오버레이 수정 후 재실행
