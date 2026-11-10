const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("the page knows the Survey Link version this site serves", () => {
  const ps1 = fs.readFileSync(path.join(__dirname, "../../web/survey/link/SurveyLink.ps1"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../../web/survey/survey.js"), "utf8");
  const v = ps1.match(/\$Version = '([0-9.]+)'/)[1];
  assert.strictEqual(js.match(/LINK_LATEST = "([0-9.]+)"/)[1], v);
  const bat = fs.readFileSync(path.join(__dirname, "../../web/survey/link/Start-SurveyLink.bat"), "utf8");
  assert.match(bat, /idan-armstrong\.github\.io\/eve-assistant\/survey\/link\/SurveyLink\.ps1/);
});
