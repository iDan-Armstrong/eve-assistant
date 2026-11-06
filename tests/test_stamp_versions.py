import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import stamp_versions as sv  # noqa: E402


def test_html_local_scripts_and_styles_only():
    html = ('<script src="haul.js"></script><script src="vendor/leaflet/leaflet.js"></script>'
            '<script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="style.css">'
            '<script type="module" src="survey.js"></script><a href="hud.html">')
    out = sv.stamp_html(html, "abc123")
    assert 'src="haul.js?v=abc123"' in out
    assert 'src="vendor/leaflet/leaflet.js?v=abc123"' in out
    assert 'src="https://cdn.example/x.js"' in out
    assert 'href="style.css?v=abc123"' in out
    assert 'src="survey.js?v=abc123"' in out
    assert 'href="hud.html"' in out


def test_module_imports():
    js = 'import * as C from "./chain_core.mjs";\nimport { x } from "../lib/a.mjs";\nimport y from "https://cdn/x.mjs";'
    out = sv.stamp_module(js, "v1")
    assert './chain_core.mjs?v=v1"' in out and '../lib/a.mjs?v=v1"' in out and 'https://cdn/x.mjs"' in out
