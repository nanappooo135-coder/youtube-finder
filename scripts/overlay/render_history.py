# -*- coding: utf-8 -*-
"""
역사 장면 합성기 — scenes_classified.json → 장면별 최종 mp4
레이어: [DepthFlow 패럴랙스 베이스] + [무드 파티클 + 오버레이 투명 레이어] 합성

각 scene이 가진 필드(역사 MATCHING_HISTORY.md 규칙으로 Claude가 채움):
  motion: {preset:"dolly"|"none", intensity:0.35~0.55}
  mood:   {fog,ember,dust,godray, grade:"warm"|"cool"|"desat"}
  overlay:{type,data,...} | null

사용:
  python render_history.py scenes.json --images-dir images --out-dir clips --dur 8
전제: pip install depthflow torch playwright imageio imageio-ffmpeg pillow numpy  +  playwright install chromium
GPU(NVIDIA)면 CUDA torch로 ~10배 빠름. 없으면 CPU(개당 ~50초).
"""
import os, io, sys, json, glob, argparse, subprocess, tempfile
import numpy as np
from PIL import Image, ImageOps
import imageio

HERE = os.path.dirname(os.path.abspath(__file__))
OVHTML = 'file:///' + os.path.join(HERE, 'history_overlay.html').replace('\\', '/')
W, H = 1920, 1080

# 시대 그레이딩 (PIL — 패럴랙스 프레임에 적용)
def grade(arr, kind):
    if not kind: return arr
    im = Image.fromarray(arr)
    from PIL import ImageEnhance
    if kind == 'warm':
        im = ImageEnhance.Color(im).enhance(0.92); im = ImageEnhance.Contrast(im).enhance(1.06)
        ov = Image.new('RGB', im.size, (40, 24, 8)); im = Image.blend(im, Image.composite(ov, im, Image.new('L', im.size, 26)), 0.0)
    elif kind == 'cool':
        im = ImageEnhance.Color(im).enhance(0.9); im = ImageEnhance.Contrast(im).enhance(1.05)
    elif kind == 'desat':
        im = ImageEnhance.Color(im).enhance(0.62); im = ImageEnhance.Contrast(im).enhance(1.08)
    return np.asarray(im)

def find_image(scene, images_dir):
    if scene.get('image') and os.path.exists(scene['image']): return scene['image']
    no = scene.get('sceneNo', scene.get('scene'))
    for pat in ('scene_%d*.png' % no, 'scene_%02d*.png' % no, '%d*.png' % no):
        hits = sorted(glob.glob(os.path.join(images_dir, pat)))
        if hits: return hits[0]
    return None

def run_depthflow(img, out_mp4, intensity, dur, fps, ssaa=2):
    # 옵션 위치 주의: --intensity는 dolly 옵션, -t/-o/-f/-w/-h/-s는 main 옵션 (섞으면 에러)
    cmd = [sys.executable, '-m', 'depthflow', 'input', '-i', img, 'dolly', '--intensity', str(intensity),
           'main', '-r', '-o', out_mp4, '-t', str(dur), '-f', str(fps), '-w', str(W), '-h', str(H), '-s', str(ssaa)]
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    # DEVNULL이면 depthflow 로깅(rich)이 깨져 렌더 중단 → 실제 로그파일로 받음
    with open(out_mp4 + '.log', 'w', encoding='utf-8', errors='replace') as lf:
        subprocess.run(cmd, env=env, stdout=lf, stderr=subprocess.STDOUT, check=True)

def read_frames(mp4, n):
    rd = imageio.get_reader(mp4); fr = []
    for im in rd:
        a = np.asarray(im)
        if a.shape[0] != H or a.shape[1] != W:
            a = np.asarray(Image.fromarray(a).resize((W, H), Image.LANCZOS))
        fr.append(a[:, :, :3])
        if len(fr) >= n: break
    rd.close()
    while len(fr) < n: fr.append(fr[-1])
    return fr

def kenburns(img, p):  # motion none/대체용 — 정적 이미지 느린 줌 (패럴랙스 안 쓸 때)
    im = ImageOps.fit(Image.open(img).convert('RGB'), (int(W*1.12), int(H*1.12)), Image.LANCZOS)
    arr = np.asarray(im); s = 1.05 + 0.06*p; cw, ch = int(W/s), int(H/s)
    ox, oy = (arr.shape[1]-cw)//2, (arr.shape[0]-ch)//2
    return np.asarray(Image.fromarray(arr[oy:oy+ch, ox:ox+cw]).resize((W, H), Image.LANCZOS))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('json_file'); ap.add_argument('--images-dir', default='images')
    ap.add_argument('--out-dir', default='history_clips'); ap.add_argument('--dur', type=float, default=8.0)
    ap.add_argument('--fps', type=int, default=24); ap.add_argument('--ssaa', type=float, default=2.0)
    ap.add_argument('--scene', type=int, default=None)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    data = json.load(open(args.json_file, encoding='utf-8-sig'))
    scenes = data.get('scenes', data)
    os.makedirs(args.out_dir, exist_ok=True)
    todo = [s for s in scenes if (args.scene is None or s.get('sceneNo', s.get('scene')) == args.scene)]

    tmp = tempfile.mkdtemp()
    # 유효 장면 + 메타 수집
    jobs = []
    for s in todo:
        no = s.get('sceneNo', s.get('scene'))
        img = find_image(s, args.images_dir)
        if not img: print('  skip #%s (이미지 없음)' % no); continue
        dur = float(s.get('duration', args.dur))
        jobs.append({'no': no, 'img': img, 'dur': dur, 'n': int(dur*args.fps),
                     'motion': s.get('motion') or {}, 'mood': s.get('mood') or {}, 'ov': s.get('overlay')})

    # ===== PHASE 1: DepthFlow 패럴랙스 (브라우저 안 켠 채 — GPU 충돌 방지) =====
    for j in jobs:
        if j['motion'].get('preset', 'dolly') == 'none': j['base_mp4'] = None; continue
        pmp4 = os.path.join(tmp, 'p_%s.mp4' % j['no'])
        try:
            run_depthflow(j['img'], pmp4, j['motion'].get('intensity', 0.4), max(8, int(j['dur'])), args.fps, args.ssaa)
            j['base_mp4'] = pmp4 if os.path.exists(pmp4) else None
        except Exception as e:
            print('  ! #%s depthflow 실패 → 켄번즈 폴백 (%s)' % (j['no'], e)); j['base_mp4'] = None
        if not j.get('base_mp4'): print('  ~ #%s 패럴랙스 폴백(켄번즈)' % j['no'])
        else: print('  · #%s 패럴랙스 OK' % j['no'])
        sys.stdout.flush()

    # ===== PHASE 2: 오버레이+무드 합성 (playwright) =====
    made = 0
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--force-color-profile=srgb'])
        pg = br.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1); pg.goto(OVHTML)
        for j in jobs:
            no, img, dur, n = j['no'], j['img'], j['dur'], j['n']
            mood, ov = j['mood'], j['ov']
            base = read_frames(j['base_mp4'], n) if j.get('base_mp4') else \
                   ([kenburns(img, i/(n-1) if n > 1 else 0) for i in range(n)] if j['motion'].get('preset','dolly') != 'none'
                    else [np.asarray(ImageOps.fit(Image.open(img).convert('RGB'), (W, H), Image.LANCZOS))]*n)
            g = mood.get('grade')
            if g: base = [grade(b, g) for b in base]
            if ov or any(mood.get(k) for k in ('fog', 'ember', 'dust', 'godray')):
                o = {'transparent': True, 'duration': dur, 'mood': mood}
                if ov: o['type'] = ov['type']; o['data'] = ov.get('data', {})
                else: o['type'] = '__moodonly__'
                pg.evaluate("(o)=>window.render(o)", o)
                pg.evaluate("async()=>{if(document.fonts&&document.fonts.ready)await document.fonts.ready;}")
                pg.wait_for_timeout(280)
                frames = []
                for i in range(n):
                    pg.evaluate("(t)=>window.seek(t)", i/args.fps*1000.0)
                    png = pg.screenshot(type='png', omit_background=True)
                    layer = np.asarray(Image.open(io.BytesIO(png)).convert('RGBA')).astype(np.float32)
                    a = layer[:, :, 3:4]/255.0
                    frames.append((base[i].astype(np.float32)*(1-a) + layer[:, :, :3]*a).astype(np.uint8))
            else:
                frames = base
            out = os.path.join(args.out_dir, 'scene_%s.mp4' % no)
            wr = imageio.get_writer(out, fps=args.fps, codec='libx264', macro_block_size=1,
                                    ffmpeg_params=['-pix_fmt', 'yuv420p', '-crf', '19'])
            for f in frames: wr.append_data(np.asarray(f))
            wr.close(); made += 1
            tag = (ov or {}).get('type') if ov else ('mood' if any(mood.get(k) for k in ('fog','ember','dust','godray')) else 'motion')
            moods = '+'.join(k for k in ('fog','ember','dust','godray') if mood.get(k)) or '-'
            print('  OK #%s  overlay=%s  mood=%s  -> %s' % (no, tag, moods, out)); sys.stdout.flush()
        br.close()
    print('완료: %d개 장면 → %s' % (made, args.out_dir))

if __name__ == '__main__':
    main()
