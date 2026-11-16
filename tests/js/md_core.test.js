const test = require("node:test");
const assert = require("node:assert");
const { render } = require("../../web/md_core.js");

test("escapes HTML and only links http(s)", () => {
  const h = render("<script>x</script> [a](javascript:alert(1)) [b](https://everef.net/x)");
  assert.doesNotMatch(h, /<script>/);
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /<a href="https:\/\/everef.net\/x"/);
});

test("headings, lists, checkboxes, tables, bold", () => {
  const h = render("## Steps\n1. Undock\n2. **Warp** to `belt`\n\n- [ ] buy ammo\n- [x] fit ship\n\n| Ship | Role |\n|---|---|\n| Scythe | logi |\n\nplain *text*");
  assert.match(h, /<h3>Steps<\/h3>/);
  assert.match(h, /<ol><li>Undock<\/li><li><strong>Warp<\/strong> to <code>belt<\/code><\/li><\/ol>/);
  assert.match(h, /☐<\/span> buy ammo/);
  assert.match(h, /☑<\/span> fit ship/);
  assert.match(h, /<th>Ship<\/th>.*<td>Scythe<\/td>/s);
  assert.match(h, /<p>plain <em>text<\/em><\/p>/);
});
