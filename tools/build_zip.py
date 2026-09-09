#!/usr/bin/env python3
"""웹스토어 업로드용 zip을 만든다.

manifest.json이 실제로 참조하는 파일과, 그 HTML이 부르는 로컬 스크립트·스타일만
담는다. 테스트, README, 배너, 아이콘 원본 등 런타임에 쓰이지 않는 파일은 빠진다.

사용법:  python tools/build_zip.py
결과물:  저장소 최상위의 <저장소이름>-<버전>.zip
"""
import json
import os
import re
import sys
import zipfile

ALWAYS_INCLUDE = ["LICENSE"]  # GPL 배포 조건상 라이선스 전문을 함께 담는다
EXTERNAL = re.compile(r"^(?:https?:|data:|//|#)")


def manifest_refs(manifest):
    refs = set()
    worker = manifest.get("background", {}).get("service_worker")
    if worker:
        refs.add(worker)
    for entry in manifest.get("content_scripts", []):
        refs.update(entry.get("js", []))
        refs.update(entry.get("css", []))
    refs.update(manifest.get("icons", {}).values())
    action = manifest.get("action", {})
    if action.get("default_popup"):
        refs.add(action["default_popup"])
    refs.update(action.get("default_icon", {}).values())
    if manifest.get("options_page"):
        refs.add(manifest["options_page"])
    for war in manifest.get("web_accessible_resources", []):
        refs.update(war.get("resources", []))
    return {r.split("?")[0] for r in refs if r and not EXTERNAL.match(r)}


def html_assets(root, html_path):
    full = os.path.join(root, html_path)
    if not os.path.exists(full):
        return set()
    base = os.path.dirname(html_path)
    with open(full, encoding="utf-8") as handle:
        text = handle.read()
    found = set()
    for ref in re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", text):
        if EXTERNAL.match(ref):
            continue
        joined = os.path.normpath(os.path.join(base, ref.split("?")[0]))
        found.add(joined.replace("\\", "/"))
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    files = {"manifest.json"} | manifest_refs(manifest)
    for path in list(files):
        if path.endswith(".html"):
            files |= html_assets(root, path)
    files |= {name for name in ALWAYS_INCLUDE if os.path.exists(os.path.join(root, name))}

    missing = sorted(f for f in files if not os.path.exists(os.path.join(root, f)))
    if missing:
        sys.exit(f"참조된 파일이 없습니다: {', '.join(missing)}")

    name = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(root))
    target = os.path.join(root, f"{name}-{manifest['version']}.zip")
    # 같은 소스면 항상 같은 zip이 나오도록 타임스탬프를 고정한다.
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(files):
            info = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(root, path), "rb") as handle:
                archive.writestr(info, handle.read())

    print(f"\n만들었습니다: {target}")
    print(f"  버전 {manifest['version']} / 파일 {len(files)}개 / {os.path.getsize(target):,} bytes\n")
    for path in sorted(files):
        print(f"  {path}")


if __name__ == "__main__":
    main()
