"""
유튜브 영상 자산 생성 환경 세팅 스크립트

다른 컴퓨터에서 이것만 실행하면 끝:
  git clone https://github.com/nanappooo135-coder/youtube-finder.git
  python youtube-finder/scripts/setup.py

또는 이미 clone했으면:
  python scripts/setup.py
"""

import os
import shutil
import sys
from pathlib import Path


def main():
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    print("=" * 50)
    print("  유튜브 영상 자산 생성 환경 세팅")
    print("=" * 50)
    print()

    script_dir = Path(__file__).parent
    repo_root = script_dir.parent
    cwd = Path.cwd()

    errors = []
    done = []

    # 1. scripts 폴더 확인/복사
    print("[1/4] 스크립트 확인...")
    local_scripts = cwd / "scripts"
    gen_script = local_scripts / "generate_images.py"
    val_script = local_scripts / "validators" / "image_prompt_validator.py"

    if gen_script.exists() and val_script.exists():
        done.append("scripts/ 이미 있음")
    else:
        src_scripts = repo_root / "scripts"
        if src_scripts.exists():
            if local_scripts.exists():
                shutil.rmtree(local_scripts)
            shutil.copytree(src_scripts, local_scripts)
            done.append("scripts/ 복사 완료")
        else:
            errors.append("scripts/ 폴더를 찾을 수 없음. youtube-finder 레포를 clone했는지 확인")

    # 2. style.txt 확인
    print("[2/4] style.txt 확인...")
    style_file = cwd / "style.txt"
    if style_file.exists() and style_file.stat().st_size > 100:
        done.append("style.txt 이미 있음 ({}자)".format(style_file.stat().st_size))
    else:
        errors.append("style.txt 없음. 유튜브파인더 올인원에서 [그림체] 섹션을 style.txt로 저장해야 함")
        # 기본 템플릿 생성
        style_file.write_text(
            "# 이 파일에 그림체 프롬프트 전문을 붙여넣으세요\n"
            "# 유튜브파인더 올인원 화면의 [그림체 프롬프트] 텍스트 전체를 복사해서 이 파일에 덮어쓰기\n"
            "# 예시:\n"
            "# semi-realistic 2D editorial illustration,\n"
            "# hand-drawn illustration style, not rendered, not photographic,\n"
            "# ...\n",
            encoding="utf-8",
        )
        done.append("style.txt 템플릿 생성됨 (그림체 붙여넣기 필요)")

    # 3. KIE_API_KEY 확인
    print("[3/4] KIE_API_KEY 확인...")
    kie_key = os.environ.get("KIE_API_KEY", "")
    if kie_key:
        done.append("KIE_API_KEY 설정됨 (길이: {})".format(len(kie_key)))
    else:
        errors.append("KIE_API_KEY 환경변수 없음. kie.ai에서 API 키 발급 후 설정 필요")

    # 4. Python 버전 확인
    print("[4/4] Python 확인...")
    ver = sys.version_info
    if ver.major >= 3 and ver.minor >= 8:
        done.append("Python {}.{}.{} OK".format(ver.major, ver.minor, ver.micro))
    else:
        errors.append("Python 3.8+ 필요 (현재: {}.{})".format(ver.major, ver.minor))

    # 결과 출력
    print()
    print("-" * 50)
    if done:
        print("✅ 완료 ({})".format(len(done)))
        for d in done:
            print("   " + d)
    print()
    if errors:
        print("❌ 미완료 ({})".format(len(errors)))
        for e in errors:
            print("   " + e)
        print()
        print("위 항목을 해결한 뒤 다시 실행하세요:")
        print("  python scripts/setup.py")
        sys.exit(1)
    else:
        print("🎉 환경 세팅 완료! 이미지 생성 준비 OK.")
        print()
        print("사용법:")
        print("  1. 유튜브파인더에서 올인원 프롬프트 복사 → Claude에 붙여넣기")
        print("  2. Claude가 JSON 생성 → 검수기 자동 실행")
        print("  3. 이미지 테스트: python scripts/generate_images.py scenes.json output --style-file style.txt --limit 1")
        print("  4. 전체 생성:   python scripts/generate_images.py scenes.json output --style-file style.txt --parallel 5")
        sys.exit(0)


if __name__ == "__main__":
    main()
