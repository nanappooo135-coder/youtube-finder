"""
Grok Video Auto - grok.com/imagine 도입부 영상 자동 생성 + 다운로드

이 스크립트 하나로 전부 처리:
1. websocket-client 자동 설치
2. Chrome을 디버깅 모드로 자동 실행 (별도 프로필, 기존 프로필 안 건드림)
3. grok.com 로그인 확인 (최초 1회만 수동 로그인, 이후 자동 유지)
4. scenes_classified.json의 isIntro 장면 이미지 → 영상 자동 생성 + 다운로드

사용법:
  python scripts/grok_video_auto.py <scenes_classified.json> <images_dir> [output_dir]
  python scripts/grok_video_auto.py projects/carbon-fiber/scenes_classified.json projects/carbon-fiber/images --resolution 720p --duration 6s --limit 3

필요 조건: Python 3, Chrome 설치. 그 외 전부 자동.
"""

import json
import sys
import time
import base64
import os
import re
import subprocess
import platform
import urllib.request

# --- 1. 의존성 자동 설치 ---
try:
    import websocket
except ImportError:
    print("[설치] websocket-client 패키지 설치 중...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client", "-q"])
    import websocket

CHROME_DEBUG_URL = "http://localhost:9222"
GROK_PROFILE_DIR = os.path.join(os.path.expanduser("~"), "GrokAutoProfile")


# --- 2. Chrome 자동 실행 ---
def find_chrome_path():
    """OS별 Chrome 실행 파일 경로 찾기"""
    if platform.system() == "Windows":
        candidates = [
            os.path.join(os.environ.get("ProgramFiles", ""), "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
        ]
    elif platform.system() == "Darwin":
        candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:
        candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]

    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def is_chrome_debug_running():
    """Chrome 디버깅 포트가 열려있는지 확인"""
    try:
        urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json/version", timeout=3)
        return True
    except Exception:
        return False


def launch_chrome_debug():
    """Chrome을 디버깅 모드로 실행 (별도 프로필)"""
    chrome_path = find_chrome_path()
    if not chrome_path:
        print("[ERROR] Chrome을 찾을 수 없습니다. Chrome을 설치해주세요.")
        sys.exit(1)

    os.makedirs(GROK_PROFILE_DIR, exist_ok=True)

    args = [
        chrome_path,
        "--remote-debugging-port=9222",
        "--remote-allow-origins=*",
        f"--user-data-dir={GROK_PROFILE_DIR}",
        "https://grok.com/imagine"
    ]

    print(f"[Chrome] 디버깅 모드로 실행 중...")
    print(f"[Chrome] 프로필: {GROK_PROFILE_DIR}")
    if platform.system() == "Windows":
        subprocess.Popen(args, creationflags=subprocess.DETACHED_PROCESS)
    else:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 연결 대기
    for i in range(30):
        time.sleep(1)
        if is_chrome_debug_running():
            print("[Chrome] 연결 성공!")
            return True
    print("[ERROR] Chrome 디버깅 포트 연결 실패")
    return False


def ensure_chrome_ready():
    """Chrome 디버깅 모드 확인, 없으면 자동 실행"""
    if is_chrome_debug_running():
        print("[Chrome] 이미 실행 중")
        return True
    print("[Chrome] 디버깅 모드가 아닙니다. 자동 실행합니다...")
    return launch_chrome_debug()


def check_grok_login(cdp):
    """grok.com 로그인 상태 확인"""
    current_url = cdp.evaluate("window.location.href") or ""
    if "grok.com" not in current_url:
        cdp.navigate("https://grok.com/imagine")
        time.sleep(3)
        current_url = cdp.evaluate("window.location.href") or ""

    is_logged_in = cdp.evaluate("""
    (() => {
        const url = window.location.href;
        if (url.includes('accounts.x.ai') || url.includes('/login') || url.includes('/signin')) return false;
        const btns = Array.from(document.querySelectorAll('button, a'));
        const hasLogin = btns.some(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('sign in') || t.includes('log in') || t.includes('로그인');
        });
        const hasInput = !!document.querySelector('textarea, div[role="textbox"], div[contenteditable="true"]');
        return hasInput && !hasLogin;
    })()
    """)
    return is_logged_in


def get_ws_url(target_url_fragment="grok.com"):
    """디버깅 포트에서 grok.com 탭의 WebSocket URL을 찾거나 기존 탭 활용"""
    resp = urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json").read()
    tabs = json.loads(resp)

    for tab in tabs:
        if target_url_fragment in tab.get("url", "") and tab.get("webSocketDebuggerUrl"):
            return tab["webSocketDebuggerUrl"], tab["id"]

    # grok.com 탭이 없으면 /json/new 시도, 실패 시 브라우저 레벨 CDP로 새 탭 생성
    try:
        resp = urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json/new?https://grok.com/imagine").read()
        tab = json.loads(resp)
        time.sleep(3)
        return tab["webSocketDebuggerUrl"], tab["id"]
    except Exception:
        browser_resp = json.loads(urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json/version").read())
        browser_ws = browser_resp.get("webSocketDebuggerUrl")
        if not browser_ws:
            raise Exception("브라우저 WebSocket URL을 찾을 수 없습니다")
        ws = websocket.create_connection(browser_ws, timeout=30)
        msg = json.dumps({"id": 1, "method": "Target.createTarget", "params": {"url": "https://grok.com/imagine"}})
        ws.send(msg)
        result = json.loads(ws.recv())
        ws.close()
        target_id = result.get("result", {}).get("targetId")
        if not target_id:
            raise Exception("새 탭 생성 실패")
        time.sleep(3)
        resp = urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json").read()
        tabs = json.loads(resp)
        for tab in tabs:
            if tab.get("id") == target_id and tab.get("webSocketDebuggerUrl"):
                return tab["webSocketDebuggerUrl"], tab["id"]
        raise Exception("생성된 탭의 WebSocket을 찾을 수 없습니다")


class CDPSession:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=300)
        self.msg_id = 0

    def send(self, method, params=None):
        self.msg_id += 1
        msg = {"id": self.msg_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(msg))

        while True:
            resp = json.loads(self.ws.recv())
            if resp.get("id") == self.msg_id:
                if "error" in resp:
                    raise Exception(f"CDP error: {resp['error']}")
                return resp.get("result", {})

    def send_no_wait(self, method, params=None):
        self.msg_id += 1
        msg = {"id": self.msg_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(msg))

    def recv_until(self, check_fn, timeout=180):
        """이벤트를 받으면서 check_fn이 True 반환할 때까지 대기"""
        start = time.time()
        while time.time() - start < timeout:
            self.ws.settimeout(5)
            try:
                resp = json.loads(self.ws.recv())
                if check_fn(resp):
                    return resp
            except websocket.WebSocketTimeoutException:
                continue
        raise TimeoutError("CDP recv timeout")

    def navigate(self, url):
        self.send("Page.navigate", {"url": url})
        time.sleep(4)

    def evaluate(self, expression):
        result = self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True
        })
        return result.get("result", {}).get("value")

    def click(self, x, y):
        self.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        time.sleep(0.05)
        self.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(0.05)
        self.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

    def type_text(self, text):
        self.send("Input.insertText", {"text": text})

    def press_enter(self):
        self.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 13, "key": "Enter", "code": "Enter"})
        time.sleep(0.03)
        self.send("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 13, "key": "Enter", "code": "Enter"})

    def set_file_input(self, selector, file_paths):
        """input[type=file]에 파일 직접 설정 (파일 선택 다이얼로그 우회)"""
        doc = self.send("DOM.getDocument")
        node = self.send("DOM.querySelector", {
            "nodeId": doc["root"]["nodeId"],
            "selector": selector
        })
        if node and node.get("nodeId"):
            self.send("DOM.setFileInputFiles", {
                "nodeId": node["nodeId"],
                "files": file_paths
            })
            return True
        return False

    def close(self):
        self.ws.close()


def find_compose_bar_button(cdp, exact_texts):
    """하단 compose bar에서 정확한 텍스트 매치로 버튼 찾기"""
    js = f"""
    (() => {{
        const matches = {json.dumps(exact_texts)};
        const btns = Array.from(document.querySelectorAll('button')).filter(b => {{
            if (!b.offsetParent) return false;
            if (b.closest('nav') || b.closest('aside') || b.closest('[role="navigation"]')) return false;
            const rect = b.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.8) return false;
            const t = (b.innerText || b.textContent || '').trim().toLowerCase();
            return matches.some(m => t === m.toLowerCase());
        }});
        if (!btns.length) return null;
        const b = btns[0];
        const r = b.getBoundingClientRect();
        return {{x: r.left + r.width/2, y: r.top + r.height/2, text: (b.innerText||'').trim().substring(0,30)}};
    }})()
    """
    return cdp.evaluate(js)


def find_button_pos(cdp, text_match, exclude_nav=True):
    """버튼 텍스트로 찾아서 좌표 반환"""
    js = f"""
    (() => {{
        const btns = Array.from(document.querySelectorAll('button')).filter(b => {{
            if (!b.offsetParent) return false;
            {'if (b.closest("nav") || b.closest("aside") || b.closest("[role=navigation]")) return false;' if exclude_nav else ''}
            const t = (b.innerText || b.textContent || b.ariaLabel || b.title || '').toLowerCase();
            const matches = {json.dumps(text_match)};
            return matches.some(m => t.includes(m));
        }});
        if (!btns.length) return null;
        const b = btns[0];
        const r = b.getBoundingClientRect();
        return {{x: r.left + r.width/2, y: r.top + r.height/2, text: (b.innerText||'').trim().substring(0,30)}};
    }})()
    """
    return cdp.evaluate(js)


def find_input_pos(cdp):
    """텍스트 입력란 좌표 반환"""
    js = """
    (() => {
        let el = document.querySelector('div[role="textbox"]')
            || document.querySelector('textarea')
            || document.querySelector('div[contenteditable="true"]');
        if (!el) {
            const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], div[contenteditable="true"]'))
                .filter(e => e.offsetParent !== null);
            el = candidates.find(e => {
                const ph = (e.placeholder || e.getAttribute('aria-placeholder') || '').toLowerCase();
                return ph.includes('video') || ph.includes('customize') || ph.includes('imagin');
            }) || candidates[0];
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {x: r.left + r.width/2, y: r.top + r.height/2};
    })()
    """
    return cdp.evaluate(js)


def wait_for_video(cdp, existing_srcs, timeout=600):
    """영상 URL이 나타날 때까지 폴링 (post 페이지 포함)"""
    existing = set(existing_srcs) if existing_srcs else set()
    start = time.time()
    post_detected = False

    while time.time() - start < timeout:
        # post 페이지로 이동했는지 확인
        url = cdp.evaluate("window.location.href") or ""
        if "/post/" in url and not post_detected:
            post_detected = True
            elapsed = int(time.time() - start)
            print(f"  post 페이지 감지 ({elapsed}s), 영상 렌더 대기...")

        result = cdp.evaluate("""
        (() => {
            const videos = Array.from(document.querySelectorAll('video'));
            const srcs = videos.map(v => v.src || v.currentSrc).filter(s => s && s.startsWith('http'));
            const links = Array.from(document.querySelectorAll('a[href*=".mp4"], a[download]'));
            const hrefs = links.map(a => a.href).filter(s => s);
            const sources = Array.from(document.querySelectorAll('video source')).map(s => s.src).filter(s => s);
            return {videos: srcs, links: hrefs, sources: sources};
        })()
        """)

        if result:
            for src in (result.get("videos", []) + result.get("links", []) + result.get("sources", [])):
                if src and src not in existing and "assets.grok.com" in src:
                    return src

        # post 페이지에서 API로도 확인 (assets.grok.com URL이 HTML에 있을 수 있음)
        if post_detected:
            html_check = cdp.evaluate("""
            (() => {
                const m = document.body.innerHTML.match(/https:\\/\\/assets\\.grok\\.com[^"'\\s]+generated_video\\.mp4[^"'\\s]*/);
                return m ? m[0] : null;
            })()
            """)
            if html_check and html_check not in existing:
                return html_check

        time.sleep(5)

    raise TimeoutError("영상 생성 타임아웃")


def get_existing_video_srcs(cdp):
    return cdp.evaluate("""
    Array.from(document.querySelectorAll('video')).map(v => v.src || v.currentSrc).filter(s => s && s.startsWith('http'))
    """) or []


def download_video_cdp(cdp, video_url, save_path):
    """브라우저 쿠키로 다운로드 (fetch → 실패 시 Network.getCookies + urllib)"""
    b64 = cdp.evaluate(f"""
    (async () => {{
        try {{
            const resp = await fetch("{video_url}", {{credentials: 'include', mode: 'cors'}});
            if (!resp.ok) return null;
            const blob = await resp.blob();
            if (blob.size === 0) return null;
            return new Promise(resolve => {{
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
            }});
        }} catch(e) {{ return null; }}
    }})()
    """)
    if b64 and len(b64) > 100:
        with open(save_path, "wb") as f:
            f.write(base64.b64decode(b64))
        print(f"  [OK] 다운로드 완료: {os.path.basename(save_path)} ({len(b64)//1024}KB)")
        return True

    # fallback: 쿠키 추출 후 urllib
    print("  [INFO] fetch 실패, 쿠키 방식 시도...")
    cookies = cdp.send("Network.getCookies", {"urls": [video_url, "https://grok.com"]})
    cookie_list = cookies.get("cookies", [])
    cookie_str = "; ".join(c["name"] + "=" + c["value"] for c in cookie_list)
    try:
        req = urllib.request.Request(video_url)
        req.add_header("Cookie", cookie_str)
        req.add_header("Referer", "https://grok.com/")
        resp = urllib.request.urlopen(req, timeout=30)
        data = resp.read()
        if len(data) > 1000:
            with open(save_path, "wb") as f:
                f.write(data)
            print(f"  [OK] 쿠키 다운로드 완료: {os.path.basename(save_path)} ({len(data)//1024}KB)")
            return True
    except Exception as e:
        print(f"  [WARN] 쿠키 다운로드 실패: {e}")

    print(f"  [WARN] 다운로드 실패 — 수동 저장 필요: {video_url}")
    return False


def process_scene(cdp, scene, image_path, output_dir, is_first=False, resolution="720p", duration="6s"):
    scene_no = scene.get("sceneNo") or scene.get("scene") or scene.get("id")
    prompt = scene.get("grok_prompt", "")
    print(f"\n[Scene {scene_no}] 시작...")

    # 0. post 뷰 탈출
    current_url = cdp.evaluate("window.location.pathname") or ""
    if "/post/" in current_url:
        print("  post 뷰 탈출...")
        cdp.evaluate("window.history.back()")
        time.sleep(3)

    # 1. 비디오 모드 + 해상도/길이 (매 장면마다 확인)
    if is_first:
        print("  비디오 모드 설정...")
        btn = find_compose_bar_button(cdp, ["비디오", "video"])
        if btn:
            cdp.click(btn["x"], btn["y"])
            time.sleep(1.5)
            print(f"  비디오 클릭: {btn.get('text', '')}")
        else:
            print("  [WARN] 비디오 버튼 못 찾음 (이미 비디오 모드?)")

    # 해상도/길이는 매 장면마다 확인 (Grok이 리셋할 수 있음)
    btn = find_compose_bar_button(cdp, [resolution.lower()])
    if btn:
        cdp.click(btn["x"], btn["y"])
        time.sleep(0.5)
        print(f"  해상도 설정: {resolution}")

    btn = find_compose_bar_button(cdp, [duration.lower()])
    if btn:
        cdp.click(btn["x"], btn["y"])
        time.sleep(0.5)
        print(f"  길이 설정: {duration}")

    # 화면비 16:9 강제 — Grok UI가 마지막 설정(9:16 등)을 기억하므로 매번 명시적으로 선택
    btn = find_compose_bar_button(cdp, ["16:9"])
    if btn:
        cdp.click(btn["x"], btn["y"])
        time.sleep(0.5)
        print("  화면비 설정: 16:9")
    else:
        print("  ! 16:9 버튼 못 찾음 — 현재 UI 설정 그대로 진행 (영상 비율 확인 필요)")

    # 2. 이미지 업로드 (DOM.setFileInputFiles - 파일 다이얼로그 우회)
    print(f"  이미지 업로드: {os.path.basename(image_path)}")
    abs_path = os.path.abspath(image_path).replace("\\", "/")

    # + 버튼 클릭해서 file input 노출
    plus_btn = cdp.evaluate("""
    (() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => {
            if (!b.offsetParent) return false;
            if (b.closest('nav') || b.closest('aside') || b.closest('[role="navigation"]')) return false;
            const rect = b.getBoundingClientRect();
            return rect.top > window.innerHeight * 0.5 && b.querySelector('svg') && (b.textContent||'').trim().length < 3;
        });
        if (!btns.length) return null;
        const r = btns[0].getBoundingClientRect();
        return {x: r.left + r.width/2, y: r.top + r.height/2};
    })()
    """)
    if plus_btn:
        cdp.click(plus_btn["x"], plus_btn["y"])
        time.sleep(1)

    # file input에 파일 직접 설정
    success = cdp.set_file_input('input[type="file"]', [abs_path])
    if not success:
        raise Exception("파일 input을 찾을 수 없음")
    time.sleep(3)

    # 업로드 완료 대기
    print("  업로드 대기...")
    for i in range(30):
        ready = cdp.evaluate("""
        (() => {
            const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
            return inputs.some(el => {
                const ph = (el.getAttribute('placeholder') || el.innerText || '').toLowerCase();
                return ph.includes('customize') || ph.includes('imagin') || ph.includes('video');
            });
        })()
        """)
        if ready:
            print("  업로드 확인됨")
            break
        time.sleep(1)
    else:
        print("  [WARN] 업로드 확인 타임아웃, 계속 진행...")

    # 3. 프롬프트 입력
    print("  프롬프트 입력...")
    input_pos = find_input_pos(cdp)
    if input_pos:
        cdp.click(input_pos["x"], input_pos["y"])
        time.sleep(0.3)
    cdp.type_text(prompt)
    time.sleep(0.5)

    # 4. 전송
    print("  전송...")
    existing_srcs = get_existing_video_srcs(cdp)

    send_btn = find_button_pos(cdp, ["send", "make video", "generate", "create", "만들기", "전송", "보내기"])
    if send_btn:
        cdp.click(send_btn["x"], send_btn["y"])
    else:
        cdp.press_enter()
    time.sleep(2)

    # 5. 영상 대기
    print("  영상 생성 대기 (최대 3분)...")
    video_url = wait_for_video(cdp, existing_srcs)
    print(f"  영상 감지: {video_url[:80]}...")

    # 6. 다운로드
    save_path = os.path.join(output_dir, f"intro_scene_{scene_no}.mp4")
    print(f"  다운로드: {save_path}")
    download_video_cdp(cdp, video_url, save_path)

    # 7. 다음 장면 준비
    print("  돌아가기...")
    cdp.evaluate("window.history.back()")
    time.sleep(3)

    print(f"  [OK] Scene {scene_no} 완료!")
    return save_path


def main():
    if len(sys.argv) < 3:
        print("사용법: python grok_video_auto.py <scenes_classified.json> <images_dir> [output_dir] [--resolution 720p] [--duration 6s]")
        print("예시:   python grok_video_auto.py projects/carbon-fiber/scenes_classified.json projects/carbon-fiber/images projects/carbon-fiber/videos")
        sys.exit(1)

    json_path = sys.argv[1]
    images_dir = sys.argv[2]
    output_dir = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else os.path.join(os.path.dirname(json_path), "videos")

    resolution = "720p"
    duration = "6s"
    limit = 0
    scene_filter = None
    for i, arg in enumerate(sys.argv):
        if arg == "--resolution" and i + 1 < len(sys.argv):
            resolution = sys.argv[i + 1]
        if arg == "--duration" and i + 1 < len(sys.argv):
            duration = sys.argv[i + 1]
        if arg == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])
        if arg == "--scenes" and i + 1 < len(sys.argv):
            scene_filter = set(int(x) for x in sys.argv[i + 1].split(","))

    os.makedirs(output_dir, exist_ok=True)

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    scenes = data.get("scenes", data) if isinstance(data, dict) else data
    targets = [s for s in scenes if s.get("isIntro") and s.get("grok_prompt")]
    if scene_filter:
        targets = [s for s in targets if (s.get("sceneNo") or s.get("scene")) in scene_filter]
    if limit > 0:
        targets = targets[:limit]

    print(f"총 {len(targets)}개 도입부 영상 생성")
    print(f"화질: {resolution}, 길이: {duration}")
    if scene_filter:
        print(f"대상 장면: {sorted(scene_filter)}")
    print(f"이미지: {images_dir}")
    print(f"출력: {output_dir}")

    # 이미지 파일 확인
    for s in targets:
        sno = s.get("sceneNo") or s.get("scene") or s.get("id")
        img = os.path.join(images_dir, f"scene_{sno}.png")
        if not os.path.exists(img):
            print(f"[ERROR] 이미지 없음: {img}")
            sys.exit(1)

    # Chrome 자동 실행 + 연결
    print("\nChrome 확인 중...")
    if not ensure_chrome_ready():
        sys.exit(1)

    time.sleep(3)
    try:
        ws_url, tab_id = get_ws_url()
    except Exception as e:
        print(f"[ERROR] Chrome 연결 실패: {e}")
        sys.exit(1)

    cdp = CDPSession(ws_url)
    print(f"연결 성공: {ws_url[:60]}...")

    # 로그인 확인
    if not check_grok_login(cdp):
        print("\n" + "="*50)
        print("grok.com 로그인이 필요합니다!")
        print("Chrome에서 grok.com에 SuperGrok 계정으로 로그인해주세요.")
        print("로그인 후 이 스크립트를 다시 실행하세요.")
        print("(로그인은 최초 1회만 필요합니다)")
        print("="*50)
        cdp.close()
        sys.exit(1)

    print("grok.com 로그인 확인됨!")

    # grok.com/imagine으로 이동
    current_url = cdp.evaluate("window.location.href") or ""
    if "grok.com/imagine" not in current_url:
        print("grok.com/imagine으로 이동...")
        cdp.navigate("https://grok.com/imagine")

    results = []
    first_real = True
    for i, scene in enumerate(targets):
        sno = scene.get("sceneNo") or scene.get("scene") or scene.get("id")
        img_path = os.path.join(images_dir, f"scene_{sno}.png")
        out_path = os.path.join(output_dir, f"intro_scene_{sno}.mp4")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
            print(f"\n[Scene {sno}] 이미 존재 ({os.path.getsize(out_path)//1024}KB) → 스킵")
            results.append(out_path)
            continue

        try:
            saved = process_scene(cdp, scene, img_path, output_dir, is_first=first_real, resolution=resolution, duration=duration)
            first_real = False
            results.append(saved)
        except Exception as e:
            print(f"  [FAIL] Scene {sno}: {e}")
            if "rate limit" in str(e).lower() or "Rate" in str(e):
                print("  레이트 리밋! 60초 대기...")
                time.sleep(60)

        # 다음 장면 대기
        if i < len(targets) - 1:
            print("  다음 장면 대기 (10초)...")
            time.sleep(10)

    cdp.close()

    print(f"\n=== 완료! {len(results)}/{len(targets)}개 생성됨 ===")
    for r in results:
        print(f"  {r}")


if __name__ == "__main__":
    main()
