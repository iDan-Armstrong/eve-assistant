"""Stamp the site's own scripts and stylesheets with a version, at deploy.

GitHub Pages lets browsers keep files for ten minutes, so right after a
deploy a page could run a mix of new and old scripts. Every local
<script src>, stylesheet <link href> and relative ES module import gets
"?v=<version>", which changes with each deploy, so browsers fetch the new
files at once. Run on the copy being uploaded, never committed.

    python tools/stamp_versions.py <site_dir> <version>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

LOCAL = r'(?!https?:|//|data:)([^"?#]+\.(?:js|mjs|css))'


def stamp_html(text: str, v: str) -> str:
    text = re.sub(r'(<script\b[^>]*\bsrc=")' + LOCAL + '"', rf'\1\2?v={v}"', text)
    return re.sub(r'(<link\b[^>]*\bhref=")' + LOCAL + '"', rf'\1\2?v={v}"', text)


def stamp_module(text: str, v: str) -> str:
    return re.sub(r'''((?:import|export)\b[^;]*?\bfrom\s+["'])(\.{1,2}/[^"'?]+\.mjs)(["'])''', rf'\1\2?v={v}\3', text)


def main(site: Path, v: str) -> None:
    n = 0
    for f in site.rglob("*.html"):
        new = stamp_html(f.read_text(), v)
        n += f.read_text() != new
        f.write_text(new)
    for f in [*site.rglob("*.mjs"), *site.rglob("*.js")]:
        if "vendor" in f.parts:
            continue
        old = f.read_text()
        new = stamp_module(old, v)
        if new != old:
            f.write_text(new)
            n += 1
    print(f"stamped {n} files with v={v}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2])
