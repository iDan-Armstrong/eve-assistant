/* A small, safe Markdown renderer for the mission planner's replies.
   Everything is HTML-escaped first, so nothing in a reply can inject markup;
   only http(s) links become anchors. Handles headings, paragraphs, bullet,
   numbered and checkbox lists, tables, code spans and blocks, bold, italics
   and horizontal rules. */
(function (root) {
  "use strict";

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(s) {
    const codes = [];
    let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
         .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
         .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
         .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

  function render(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const body = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        const n = Math.min(4, m[1].length + 1);
        out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
        out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
                 rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const items = [];
        for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
          let t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          const box = t.match(/^\[([ xX])\]\s*/);
          if (box) t = t.slice(box[0].length);
          const sub = /^\s{2,}/.test(lines[i]) ? ' class="sub"' : "";
          items.push(`<li${sub}>${box ? `<span class="box">${box[1].trim() ? "☑" : "☐"}</span> ` : ""}${inline(t)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i]); i++) para.push(lines[i].trim());
      if (!para.length) { para.push(lines[i]); i++; }
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return out.join("\n");
  }

  const api = { render, inline, esc };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MdCore = api;
})(typeof self !== "undefined" ? self : this);
