"""
Kie AI 이미지 자동 생성 + 다운로드 스크립트 (동시 생성 지원)
scenes_classified.json에서 ai 장면의 nano_prompt를 읽어 Kie AI API로 이미지 생성

사용법:
  python _시스템/scripts/generate_images.py <scenes_json> <output_folder> [--style-prompt "..."] [--resolution 2K] [--api-key KEY] [--parallel 5]

예시:
  python _시스템/scripts/generate_images.py scenes_classified.json projects/test/images --resolution 2K --parallel 5
"""

import argparse
import json
import os
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import urlopen, Request

API_BASE = "https://api.kie.ai/api/v1/jobs"
DEFAULT_API_KEY = os.environ.get("KIE_API_KEY", "")


def api_request(endpoint, api_key, method="GET", data=None):
    url = f"{API_BASE}/{endpoint}"
    headers = {"Authorization": f"Bearer {api_key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
        req = Request(url, data=json.dumps(data).encode("utf-8"), headers=headers, method="POST")
    else:
        req = Request(url, headers=headers)
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_balance(api_key):
    url = "https://api.kie.ai/api/v1/chat/credit"
    req = Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("data", 0)


def create_task(api_key, prompt, resolution="2K", aspect_ratio="16:9"):
    data = {
        "model": "nano-banana-2",
        "input": {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "output_format": "png"
        }
    }
    result = api_request("createTask", api_key, method="POST", data=data)
    if result.get("code") != 200:
        raise Exception(f"Task creation failed: {result.get('msg', 'unknown error')}")
    return result["data"]["taskId"]


def poll_result(api_key, task_id, max_wait=300):
    for i in range(max_wait // 3):
        time.sleep(3)
        result = api_request(f"recordInfo?taskId={task_id}", api_key)
        state = result.get("data", {}).get("state", "")
        if state == "success":
            result_json = json.loads(result["data"]["resultJson"])
            urls = result_json.get("resultUrls", [])
            return urls[0] if urls else None
        if state == "fail":
            msg = result.get("data", {}).get("failMsg", "unknown")
            raise Exception(f"Generation failed: {msg}")
    raise Exception("Timeout waiting for result")


def download_image(url, output_path, max_retries=3):
    for attempt in range(max_retries):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req) as resp:
                with open(output_path, "wb") as f:
                    f.write(resp.read())
            return True
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2)
            else:
                raise Exception(f"Download failed after {max_retries} attempts: {e} | URL: {url}")


def generate_one(scene, api_key, style_prompt, resolution, aspect_ratio, output_folder):
    full_prompt = scene["prompt"]
    if style_prompt:
        full_prompt = style_prompt + ", " + full_prompt

    scene_id = scene["id"]
    filename = f"scene_{scene_id}.png"
    output_path = output_folder / filename

    task_id = create_task(api_key, full_prompt, resolution, aspect_ratio)
    image_url = poll_result(api_key, task_id)
    if image_url:
        try:
            download_image(image_url, output_path)
            size_kb = output_path.stat().st_size / 1024
            return {"id": scene_id, "path": output_path, "size_kb": size_kb, "ok": True, "url": image_url}
        except Exception as e:
            return {"id": scene_id, "ok": False, "error": str(e), "url": image_url}
    return {"id": scene_id, "ok": False, "error": "No image URL"}


def make_zip(image_folder, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(image_folder.glob("scene_*.png")):
            zf.write(f, f.name)
    return zip_path


def main():
    parser = argparse.ArgumentParser(description="Kie AI batch image generator")
    parser.add_argument("scenes_json", help="scenes_classified.json path")
    parser.add_argument("output_folder", help="output folder for images")
    parser.add_argument("--style-prompt", default="", help="style prompt to prepend")
    parser.add_argument("--style-file", default="", help="read style prompt from file")
    parser.add_argument("--resolution", default="2K", help="resolution (1K/2K/4K)")
    parser.add_argument("--aspect-ratio", default="16:9", help="aspect ratio")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY, help="Kie AI API key")
    parser.add_argument("--zip", action="store_true", help="create ZIP after download")
    parser.add_argument("--types", default="ai", help="scene types to generate (comma-separated)")
    parser.add_argument("--parallel", type=int, default=5, help="concurrent generations (default: 5)")
    parser.add_argument("--limit", type=int, default=0, help="max images to generate (0=all)")
    parser.add_argument("--scenes", default="", help="specific scene numbers to generate (comma-separated, e.g. 1,5,10)")
    args = parser.parse_args()

    if args.style_file:
        sf = Path(args.style_file)
        if not sf.exists():
            print("[!] style file not found: {}".format(args.style_file))
            sys.exit(1)
        content = sf.read_text(encoding="utf-8").strip()
        if len(content) < 50 or content.startswith("#"):
            print("[!] style file is empty or template only. Paste the full art style prompt into {}".format(args.style_file))
            sys.exit(1)
        args.style_prompt = content
    elif not args.style_prompt:
        print("[!] --style-file or --style-prompt required. Art style must be applied.")
        print("[!] Create style.txt with the full art style prompt, then use --style-file style.txt")
        sys.exit(1)

    if not args.api_key:
        print("[!] API key required. Use --api-key or set KIE_API_KEY env var.")
        sys.exit(1)

    scenes_path = Path(args.scenes_json)
    output_folder = Path(args.output_folder)
    output_folder.mkdir(parents=True, exist_ok=True)

    # Auto-run validator before generation
    validator_path = Path(__file__).parent / "validators" / "image_prompt_validator.py"
    if validator_path.exists():
        import subprocess
        print("[*] Running image prompt validator...")
        result = subprocess.run([sys.executable, str(validator_path), str(scenes_path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.stdout:
            print(result.stdout)
        if result.returncode != 0:
            if result.stderr:
                print(result.stderr)
            print("[!] Validator FAIL. Fix JSON before generating images.")
            sys.exit(1)
        print()

    data = json.loads(scenes_path.read_text(encoding="utf-8"))
    scenes = data if isinstance(data, list) else data.get("scenes", [])

    target_types = set(args.types.split(","))
    ai_scenes = []
    for s in scenes:
        scene_type = s.get("type") or s.get("scene_type") or "ai"
        if scene_type in target_types:
            prompt = s.get("nano_prompt") or s.get("aiPrompt") or ""
            if prompt:
                scene_id = s.get("id") or s.get("scene_id") or s.get("scene") or s.get("sceneNo")
                ai_scenes.append({"id": scene_id, "prompt": prompt})

    if args.scenes:
        target_ids = set(args.scenes.split(","))
        ai_scenes = [s for s in ai_scenes if str(s["id"]) in target_ids]

    if not ai_scenes:
        print("[!] No matching scenes found.")
        sys.exit(0)

    # Skip existing images
    existing = []
    pending = []
    for s in ai_scenes:
        img_path = output_folder / f"scene_{s['id']}.png"
        if img_path.exists() and img_path.stat().st_size > 10000:
            existing.append(s["id"])
        else:
            pending.append(s)

    if existing:
        print(f"[*] {len(existing)} images already exist, skipping")
    if not pending:
        print("[*] All images already exist!")
        sys.exit(0)

    ai_scenes = pending
    if args.limit > 0:
        ai_scenes = ai_scenes[:args.limit]
    total = len(ai_scenes)

    # Credit check before starting
    cost_per_image = 12 if args.resolution == "2K" else (5 if args.resolution == "1K" else 20)
    needed = total * cost_per_image
    balance = check_balance(args.api_key)
    print(f"[*] Balance: {balance} credits | Need: {needed} credits ({total} images x {cost_per_image})")
    if balance < needed:
        print(f"[!] INSUFFICIENT CREDITS. Need {needed - balance} more credits (${(needed - balance) * 0.005:.2f})")
        print(f"[!] Charge at https://kie.ai/pricing")
        sys.exit(1)

    parallel = min(args.parallel, total)
    print(f"[*] {total} images to generate ({args.resolution}, {args.aspect_ratio}, {parallel} parallel)")
    print()

    start_time = time.time()
    results = []
    failed = []

    with ThreadPoolExecutor(max_workers=parallel) as executor:
        futures = {}
        for scene in ai_scenes:
            f = executor.submit(
                generate_one, scene, args.api_key,
                args.style_prompt, args.resolution, args.aspect_ratio, output_folder
            )
            futures[f] = scene

        for f in as_completed(futures):
            scene = futures[f]
            try:
                result = f.result()
                if result["ok"]:
                    results.append(result["path"])
                    print(f"  [OK] scene_{result['id']}.png ({result['size_kb']:.0f}KB) [{len(results)}/{total}]")
                else:
                    failed.append({"id": result["id"], "error": result.get("error"), "url": result.get("url")})
                    print(f"  [FAIL] scene_{result['id']}: {result.get('error')}")
            except Exception as e:
                failed.append({"id": scene["id"], "error": str(e)})
                print(f"  [FAIL] scene_{scene['id']}: {e}")

    elapsed = time.time() - start_time
    print(f"\n[*] {len(results)}/{total} images downloaded -> {output_folder}")
    print(f"[*] Time: {elapsed:.0f}s ({elapsed/60:.1f}min)")
    if failed:
        print(f"[!] Failed scenes: {failed}")
        # Save failed URLs for manual retry
        fail_log = output_folder / "_failed_urls.json"
        fail_data = [f for f in failed if isinstance(f, dict) and f.get("url")]
        if fail_data:
            fail_log.write_text(json.dumps(fail_data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[*] Failed URLs saved to {fail_log} (can retry download manually)")

    if args.zip and results:
        zip_path = output_folder.parent / f"{output_folder.name}.zip"
        make_zip(output_folder, zip_path)
        print(f"[*] ZIP created -> {zip_path}")

    return results


if __name__ == "__main__":
    main()
