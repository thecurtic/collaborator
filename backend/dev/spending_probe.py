"""Why didn't a held receipt divert? Runs the spending classifier (and,
with --extract, both reading steps: transcribe, then structure) against a photo, with the server's own
config, and prints what the model answered (dev tooling, never deployed).

    cd backend && .venv/bin/python dev/spending_probe.py            # newest Scratch photo
    cd backend && .venv/bin/python dev/spending_probe.py photo.jpg --extract

It reads your photo and prints the model's reply here only; nothing is
written to any database.
"""

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import spending  # noqa: E402
import vision    # noqa: E402

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic")


def newest_scratch_photo() -> str:
    root = os.path.dirname(os.getcwd())
    found = [p for p in glob.glob(os.path.join(root, "**", "scratch-media", "*"), recursive=True)
             if p.lower().endswith(IMAGE_EXT) and "node_modules" not in p]
    if not found:
        sys.exit("No Scratch photos found; pass a path.")
    return max(found, key=os.path.getmtime)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?")
    ap.add_argument("--extract", action="store_true", help="also read it as a receipt")
    args = ap.parse_args()
    path = args.path or newest_scratch_photo()
    mime = {"png": "image/png", "webp": "image/webp", "gif": "image/gif"}.get(
        path.rsplit(".", 1)[-1].lower(), "image/jpeg")
    print(f"photo:            {path}")
    print(f"spending.enabled: {spending.enabled()}")
    print(f"vision model:     {vision.model()!r}")
    if not vision.model():
        sys.exit("No model here can see images, so nothing is classified.")
    try:
        print(f"\nclassify() →  {spending.classify(path, mime)!r}")
    except RuntimeError as e:
        print(f"\nclassify() FAILED: {e}")
    if not args.extract:
        return
    try:
        text = spending.transcribe_receipt(path, mime)
        print(f"\n[step 1] transcription ({len(text)} chars):\n{text[:3000]}")
    except RuntimeError as e:
        sys.exit(f"\n[step 1] transcription FAILED: {e}")
    try:
        data = spending.structure_receipt(text)
        receipt, problems = spending.normalize(data)
        print("\n[step 2] structured:", json.dumps(data, indent=2)[:4000])
        print("problems:", problems)
        print("review:", spending.review_reasons(receipt, set()))
    except (RuntimeError, ValueError) as e:
        print(f"\n[step 2] structuring FAILED: {e}")


if __name__ == "__main__":
    main()
