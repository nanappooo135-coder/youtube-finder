#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
오버레이 기계적 검증기 (Mechanical Overlay Validator)

원칙: LLM이 만든 오버레이를 "믿지 않는다". 글자 단위로 대조해서
      - 출처(source)가 나레이션에 실재하는지
      - 오버레이에 쓰인 모든 숫자가 출처 안에 글자 그대로 있는지
      - 파생값(증감 %, 차이)은 다시 계산해서 맞는지
      - 타입이 데이터 모양과 맞는지
검증한다. 하나라도 실패하면 그 오버레이는 DROP(폐기). 통과한 것만 남긴다.

→ "틀린 오버레이가 영상에 나가는 일"을 0으로 만드는 안전장치.

사용:
  python validate_overlays.py scenes_classified.json
  python validate_overlays.py scenes_classified.json --out scenes_validated.json
종료코드: DROP이 하나라도 있으면 1, 전부 통과면 0.
"""
import sys, json, re, argparse, io

def norm(s):
    """비교용 정규화: 콤마·공백 제거, 소문자."""
    return re.sub(r'[\s,]', '', str(s)).lower()

def digits_in(text):
    """문자열에서 숫자 토큰(정수/소수) 추출."""
    return re.findall(r'\d+(?:\.\d+)?', str(text).replace(',', ''))

def collect_values(data):
    """data 딕셔너리/리스트를 재귀적으로 훑어 문자열 값을 전부 모음."""
    out = []
    if isinstance(data, dict):
        for v in data.values():
            out += collect_values(v)
    elif isinstance(data, list):
        for v in data:
            out += collect_values(v)
    elif data is not None:
        out.append(str(data))
    return out

# 타입별 최소 데이터 요건 (타입↔데이터 모양 일치 검사)
TYPE_RULES = {
    'single_stat_card': {'need_number': True},
    'hero_stat':        {'need_number': True},
    'stat_change':      {'need_number': True, 'min_numbers': 2},  # from→to
    'versus':           {'need_number': False, 'min_sides': 2},
    'bar_chart':        {'need_number': True, 'min_items': 3},
    'donut':            {'need_percent': True},
    'ranking':          {'min_items': 2},
    'timeline':         {'min_years': 2},
    'route':            {'need_endpoints': True},
    'headline':         {},
    'quote':            {'need_quote': True},
    'nametag':          {'need_name': True},
    'bullets':          {'min_items': 2},
}

def validate_overlay(ov, narration):
    """단일 오버레이 검증. (ok, problems[]) 반환."""
    problems = []
    typ = ov.get('type', '')
    data = ov.get('data', {})
    source = ov.get('source', '')
    derived = ov.get('derived', []) or []

    nnorm = norm(narration)

    # 1) 출처가 실제 나레이션에 있는가
    if not source:
        problems.append('source 없음(출처 미인용) → 검증 불가')
    elif norm(source) not in nnorm:
        problems.append('source가 나레이션에 없음(인용 조작): "%s"' % source[:40])

    # 2) 파생값으로 설명되는 숫자 목록 만들기 (재계산 검증)
    derived_ok_numbers = set()
    for d in derived:
        val = str(d.get('value', ''))
        ops = d.get('from', [])
        formula = d.get('formula', '')
        # 피연산자는 반드시 출처(또는 나레이션)에 있어야 함
        if not all(any(o_d in digits_in(source) or o_d in digits_in(narration) for o_d in digits_in(o)) for o in ops):
            problems.append('파생값 피연산자가 출처에 없음: %s' % val)
            continue
        # 재계산
        try:
            safe = re.sub(r'[^0-9+\-*/().]', '', formula)
            calc = eval(safe, {'__builtins__': {}})
            claimed = digits_in(val)
            if claimed:
                cv = float(claimed[0])
                # %면 0~1 결과를 100배 비교 허용
                if abs(calc - cv) <= max(1.0, cv * 0.02) or abs(calc * 100 - cv) <= max(1.0, cv * 0.02):
                    for dd in digits_in(val):
                        derived_ok_numbers.add(dd)
                else:
                    problems.append('파생값 계산 불일치: 주장 %s vs 계산 %.2f' % (val, calc))
            else:
                problems.append('파생값에 숫자 없음: %s' % val)
        except Exception as e:
            problems.append('파생 수식 오류(%s): %s' % (val, e))

    # 3) data 안의 모든 숫자가 출처/나레이션에 글자 그대로 있는가 (핵심)
    for v in collect_values(data):
        for dnum in digits_in(v):
            if dnum in derived_ok_numbers:
                continue
            if dnum not in digits_in(source) and dnum not in digits_in(narration):
                problems.append('지어낸 숫자 의심: "%s" (출처에 없음)' % dnum)

    # 4) 타입↔데이터 모양 일치
    rule = TYPE_RULES.get(typ)
    if rule is None:
        problems.append('알 수 없는 타입: %s' % typ)
    else:
        allnums = [n for v in collect_values(data) for n in digits_in(v)]
        if rule.get('need_number') and not allnums:
            problems.append('%s인데 숫자가 없음' % typ)
        if rule.get('need_percent') and '%' not in json.dumps(data, ensure_ascii=False) and '퍼센트' not in narration:
            problems.append('donut인데 비율(%)이 없음')
        if rule.get('min_numbers') and len(allnums) < rule['min_numbers']:
            problems.append('%s인데 숫자 %d개 미만' % (typ, rule['min_numbers']))
        if rule.get('min_items'):
            items = data.get('items') or data.get('events') or []
            if len(items) < rule['min_items']:
                problems.append('%s인데 항목 %d개 미만' % (typ, rule['min_items']))
        if rule.get('min_years'):
            yrs = re.findall(r'(?:19|20)\d{2}', json.dumps(data, ensure_ascii=False))
            if len(set(yrs)) < rule['min_years']:
                problems.append('timeline인데 연도 2개 미만')
        if rule.get('min_sides') and not (data.get('left') and data.get('right')):
            problems.append('versus인데 좌/우 2개가 없음')

    return (len(problems) == 0, problems)


def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('json_file')
    ap.add_argument('--out', default=None, help='검증 통과본 저장 경로')
    args = ap.parse_args()

    data = json.load(open(args.json_file, encoding='utf-8-sig'))
    scenes = data.get('scenes', data)

    total = passed = dropped = 0
    print('=' * 60)
    print('  오버레이 기계 검증 (출처 인용 + 숫자 글자대조 + 재계산)')
    print('=' * 60)
    for s in scenes:
        ov = s.get('overlay')
        if not ov:
            continue
        total += 1
        narr = s.get('narration', '') or s.get('text', '')
        ok, probs = validate_overlay(ov, narr)
        tag = '#%s [%s]' % (s.get('sceneNo', s.get('scene', '?')), ov.get('type', '?'))
        if ok:
            passed += 1
            print('  ✅ PASS  %s' % tag)
        else:
            dropped += 1
            s['overlay'] = None  # 폐기 (안전 실패)
            s['_overlay_dropped'] = probs
            print('  ❌ DROP  %s' % tag)
            for p in probs:
                print('         - ' + p)

    print('-' * 60)
    print('  오버레이 %d개 중 통과 %d · 폐기 %d' % (total, passed, dropped))
    if total:
        print('  통과율 %.0f%% (폐기된 것은 영상에 안 나감 = 안전)' % (passed / total * 100))

    if args.out:
        json.dump(data, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('  검증 통과본 저장: %s' % args.out)

    sys.exit(1 if dropped else 0)


if __name__ == '__main__':
    main()
