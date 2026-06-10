# -*- coding: utf-8 -*-
"""
클로드디자인 HTML → 애니메이션 영상(WebM) 녹화
CSS 애니메이션이 살아있는 채로 장면 길이만큼 실시간 녹화한다.
프리뷰 플레이어가 html_clips/를 자동 로드해 영상 장면처럼 재생 (내보내기 포함).

사용:
  python scripts/render_html.py <scenes_classified.json> --html-dir <images/html> --out-dir <html_clips> [--scene N]
전제: pip install playwright && playwright install chromium
"""
import os, sys, json, argparse, shutil, tempfile

W, H = 1920, 1080


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('json_file')
    ap.add_argument('--html-dir', default='images/html')
    ap.add_argument('--out-dir', default='html_clips')
    ap.add_argument('--scene', type=int, default=None)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    data = json.load(open(args.json_file, encoding='utf-8-sig'))
    scenes = data.get('scenes', data)
    targets = []
    for s in scenes:
        if s.get('type') != 'claude_design':
            continue
        no = s.get('sceneNo', s.get('scene'))
        if args.scene is not None and no != args.scene:
            continue
        targets.append((no, float(s.get('duration', 8))))

    if not targets:
        print('claude_design 대상 장면 없음')
        return

    os.makedirs(args.out_dir, exist_ok=True)
    tmp = tempfile.mkdtemp()
    made = skipped = failed = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--force-color-profile=srgb'])
        for no, dur in targets:
            html = os.path.join(args.html_dir, f'scene_{no}.html')
            out = os.path.join(args.out_dir, f'scene_{no}.webm')
            if not os.path.exists(html):
                print(f'  skip #{no} (HTML 없음: {html})')
                continue
            if os.path.exists(out) and os.path.getsize(out) > 1000:
                print(f'  skip #{no} (이미 있음)')
                skipped += 1
                continue
            try:
                ctx = browser.new_context(
                    viewport={'width': W, 'height': H},
                    record_video_dir=tmp,
                    record_video_size={'width': W, 'height': H},
                )
                pg = ctx.new_page()
                pg.goto('file:///' + os.path.abspath(html).replace('\\', '/'))
                # 폰트/레이아웃 안정 후 애니메이션을 처음부터 다시 시작
                pg.wait_for_timeout(400)
                pg.evaluate("document.getAnimations().forEach(a => { try { a.cancel(); a.play(); } catch(e) {} })")
                pg.wait_for_timeout(int((dur + 0.4) * 1000))
                video = pg.video
                pg.close()
                ctx.close()
                video.save_as(out)
                print(f'  OK #{no} ({dur:.0f}초) -> {out}')
                made += 1
            except Exception as e:
                failed += 1
                print(f'  ! #{no} 실패: {e}')
            sys.stdout.flush()
        browser.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print(f'완료: 녹화 {made} / 스킵 {skipped} / 실패 {failed}')


if __name__ == '__main__':
    main()
