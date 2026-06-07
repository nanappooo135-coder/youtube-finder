#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
오버레이 영상 생성기 (녹화 아님 — 프레임 단위 결정적 캡처)

흐름: 장면 이미지 + overlay 스펙 → overlay.html에 주입 → Playwright로
      0,1/fps,2/fps… 시점을 seek하며 한 프레임씩 스크린샷 → imageio로 mp4 합성.
      이미지 위에 오버레이가 얹힌 "움직이는 클립"이 장면별로 나온다.

전제: validate_overlays.py를 먼저 통과한 JSON만 넣는다(지어낸 숫자 0 보장).

사용:
  python generate_overlays.py scenes_validated.json --images-dir images --out-dir clips
  python generate_overlays.py scenes_validated.json --images-dir images --out-dir clips --scene 5 --fps 24
"""
import sys, os, io, json, base64, argparse, glob

def log(*a):
    print(*a); sys.stdout.flush()

def img_to_datauri(path, w=1920):
    from PIL import Image
    im = Image.open(path).convert('RGB')
    if im.width != w:
        im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=88)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()

def find_image(scene, images_dir):
    if scene.get('image') and os.path.exists(scene['image']):
        return scene['image']
    no = scene.get('sceneNo', scene.get('scene'))
    if images_dir and no is not None:
        for pat in ('scene_%d*.png' % no, 'scene_%02d*.png' % no, '장면%d*.png' % no, '%d*.png' % no):
            hits = sorted(glob.glob(os.path.join(images_dir, pat)))
            if hits:
                return hits[0]
    return None

def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('json_file')
    ap.add_argument('--images-dir', default='images')
    ap.add_argument('--out-dir', default='overlay_clips')
    ap.add_argument('--fps', type=int, default=24)
    ap.add_argument('--scene', type=int, default=None, help='특정 장면만 렌더(테스트용)')
    args = ap.parse_args()

    import imageio
    from playwright.sync_api import sync_playwright

    here = os.path.dirname(os.path.abspath(__file__))
    overlay_html = 'file:///' + os.path.join(here, 'overlay.html').replace('\\', '/')

    data = json.load(open(args.json_file, encoding='utf-8-sig'))
    scenes = data.get('scenes', data)
    os.makedirs(args.out_dir, exist_ok=True)

    todo = [s for s in scenes if s.get('overlay') and (args.scene is None or s.get('sceneNo', s.get('scene')) == args.scene)]
    if not todo:
        log('렌더할 오버레이 장면이 없습니다.'); return

    log('=' * 60)
    log('  오버레이 영상 생성 — %d개 장면, %dfps' % (len(todo), args.fps))
    log('=' * 60)

    made, failed = 0, 0
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--force-color-profile=srgb'])
        page = browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        page.goto(overlay_html)
        for s in todo:
            no = s.get('sceneNo', s.get('scene'))
            ov = s['overlay']
            img = find_image(s, args.images_dir)
            if not img:
                log('  ⚠️  #%s 이미지 못 찾음 → 건너뜀' % no); failed += 1; continue
            ov = dict(ov); ov['image'] = img_to_datauri(img)
            dur = float(ov.get('duration', s.get('duration', 8)))
            nframes = max(1, int(dur * args.fps))
            try:
                page.evaluate('(ov)=>window.render(ov)', ov)
                page.evaluate('async()=>{ if(document.fonts&&document.fonts.ready) await document.fonts.ready; }')
                page.wait_for_timeout(250)
                out = os.path.join(args.out_dir, 'scene_%s.mp4' % no)
                writer = imageio.get_writer(out, fps=args.fps, codec='libx264',
                                            macro_block_size=1, ffmpeg_params=['-pix_fmt', 'yuv420p', '-crf', '18'])
                for f in range(nframes):
                    t = f / args.fps * 1000.0
                    page.evaluate('(t)=>window.seek(t)', t)
                    jpg = page.screenshot(type='jpeg', quality=90)
                    writer.append_data(imageio.imread(jpg))
                writer.close()
                sz = os.path.getsize(out)
                log('  ✅ #%s [%s] → %s (%d프레임, %.1fs, %dKB)' % (no, ov.get('type'), out, nframes, dur, sz // 1024))
                made += 1
            except Exception as e:
                log('  ❌ #%s 실패: %s' % (no, e)); failed += 1
        browser.close()

    log('-' * 60)
    log('  완료: %d개 생성, %d개 실패' % (made, failed))
    log('  → 셀팟에 scene_N.mp4를 해당 장면 이미지 대신 올리세요.')

if __name__ == '__main__':
    main()
