// 端到端冒烟：真实浏览器中加载示例公式，验证状态徽章、量纲定位、KaTeX 渲染、隔离
// 以及测量不确定度（传播/相关/未验证）、计算快照与 JSON 导出导入往返。
import { chromium } from "playwright";
import fs from "node:fs";

const URL = "http://localhost:5199/";

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".app");

// math-field 自定义元素注册
const hasField = await page.evaluate(() => !!customElements.get("math-field"));
check("MathLive <math-field> 已注册", hasField);

// 先清空 IndexedDB（保证从空笔记本开始，可重复运行）
await page.evaluate(async () => {
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase("dimension-notebook");
    r.onsuccess = r.onerror = r.onblocked = () => res(null);
  });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".app");

// 依次加载首版 5 个示例
for (const kind of ["unit", "degC", "angle", "dimErr", "divZero"]) {
  await page.getByRole("button", { name: `示例：${{
    unit: "单位运算", degC: "摄氏温标", angle: "角度弧度", dimErr: "量纲错误", divZero: "除零",
  }[kind]}` }).click();
}
await page.waitForTimeout(600);

const cards = page.locator(".card");
await cards.last().waitFor();
const n = await cards.count();
check("创建了 5 张公式卡片", n === 5, `实际 ${n}`);

async function cardInfo(i) {
  const card = cards.nth(i);
  return {
    badge: (await card.locator(".badge").first().innerText()).trim(),
    uncBadge: (await card.locator(".unc-badge").first().innerText().catch(() => "")).trim(),
    summary: (await card.locator(".summary").innerText()).trim(),
    issues: await card.locator(".issue").allInnerTexts(),
    uncText: (await card.locator(".unc-panel").innerText().catch(() => "")).trim(),
    resultText: (await card.locator(".result-row .tex-box").first().innerText().catch(() => "")).trim(),
    hasRedTex: (await card.locator(".display-area").innerHTML()).includes("#d11f2d"),
    hasOrangeTex: (await card.locator(".display-area").innerHTML()).includes("#b26a00"),
    katexCount: await card.locator(".katex").count(),
  };
}

// 1) 单位运算：2 m/s * 3 s + 1/2 * 4 m/s^2 * 9 s^2 = 6 + 18 = 24 m
const c1 = await cardInfo(0);
check("单位运算：已验证", c1.badge === "已验证", c1.badge);
check("单位运算：结果 24 m", /24/.test(c1.resultText), c1.resultText);
check("单位运算：KaTeX 已渲染", c1.katexCount >= 3, `${c1.katexCount} 个 .katex`);

// 2) 摄氏温标：未验证 + 橙色高亮
const c2 = await cardInfo(1);
check("摄氏温标：标记未验证", c2.badge === "未验证", c2.badge);
check("摄氏温标：提示偏移温标", c2.issues.some((t) => t.includes("偏移温标")), c2.issues[0] ?? "");
check("摄氏温标：橙色高亮问题节点", c2.hasOrangeTex);

// 3) 角度弧度：1 rad + 180 deg，目标 deg
const c3 = await cardInfo(2);
check("角度弧度：已验证", c3.badge === "已验证", c3.badge);
const num = c3.resultText.replace(/[^\d.]/g, " ");
check("角度弧度：含 π+1≈4.1416 rad 或换算 237.65 deg",
  /4\.141|237\.6|57\.29/.test(num) || /237/.test(c3.resultText), c3.resultText);

// 4) 量纲错误：红色定位到 (a+b) 节点
const c4 = await cardInfo(3);
check("量纲错误：有错误", c4.badge === "有错误", c4.badge);
check("量纲错误：提示不能相加且量纲不兼容",
  c4.issues.some((t) => t.includes("量纲不兼容") && t.includes("相加")), c4.issues[0] ?? "");
check("量纲错误：原式红色高亮问题节点", c4.hasRedTex);

// 5) 除零：明确报错
const c5 = await cardInfo(4);
check("除零：有错误", c5.badge === "有错误", c5.badge);
check("除零：报除数为零", c5.issues.some((t) => t.includes("除数为零")), c5.issues[0] ?? "");
check("除零：不显示结果数值", !/=\s*\d/.test(c5.resultText), c5.resultText);

// 6) 旧行为兼容：新示例默认“不确定度未声明”
check("未声明不确定度的旧示例明确标记未声明", c1.uncBadge.includes("未声明"), c1.uncBadge);

// 7) 隔离：删除量纲错误卡片后，其余 4 张状态不变
await page.getByRole("button", { name: "删除" }).nth(3).click();
await page.waitForTimeout(300);
check("删除后剩余 4 张", await cards.count() === 4);
const b0 = (await cards.nth(0).locator(".badge").first().innerText()).trim();
const b1 = (await cards.nth(1).locator(".badge").first().innerText()).trim();
const b3 = (await cards.nth(3).locator(".badge").first().innerText()).trim();
check("隔离：好公式仍已验证", b0 === "已验证", b0);
check("隔离：摄氏仍未验证", b1 === "未验证", b1);
check("隔离：除零卡片仍有错误", b3 === "有错误", b3);

// ===== 不确定度验收 =====

// 验收 1：力 F=m·a 独立测量
await page.getByRole("button", { name: "示例：力与不确定度" }).click();
await page.waitForTimeout(400);
const forceCard = page.locator(".card").last();
const forceInfo = await forceCard.locator(".unc-panel").innerText();
check("验收1：F=6 N", /6/.test(await forceCard.locator(".result-row .tex-box").first().innerText()), "");
check("验收1：不确定度已传播", forceInfo.includes("不确定度已传播"), forceInfo.slice(0, 60));
// u_c ≈ 0.104 N（2 位有效数字显示 0.1）
check("验收1：u_c(y)=±0.104 N 附近", /0\.1(04)?\s*N/.test(forceInfo), forceInfo.match(/u_c[^\n]*/)?.[0] ?? forceInfo);
check("验收1：主要贡献项包含 a", forceInfo.includes("a"), "");
check("验收1：相对不确定度约 1.7%", /1\.7%/.test(forceInfo), forceInfo);

// 验收 2：同源相关 —— 同一张卡片上把 ρ 改为 0.8，值不变、不确定度变大
// 该示例已带 ρ=0.8；先验证独立假设（清空 ρ）与相关假设的差异
const rhoInput = forceCard.locator(".corr-rho");
const beforeCorr = forceInfo;
await rhoInput.fill("");
await page.waitForTimeout(300);
const indepText = await forceCard.locator(".unc-panel").innerText();
const indepU = (indepText.match(/u_c\(y\)\s*=\s*±\s*([0-9.eE+-]+)/) || [])[1];
await rhoInput.fill("0.8");
await page.waitForTimeout(300);
const corrText = await forceCard.locator(".unc-panel").innerText();
const corrU = (corrText.match(/u_c\(y\)\s*=\s*±\s*([0-9.eE+-]+)/) || [])[1];
check("验收2：独立假设 u=0.5 N", Number(indepU) === 0.5, `读到 ${indepU}`);
check("验收2：ρ=0.8 时 u=0.66 N 且大于独立值", Number(corrU) > 0.6 && Number(corrU) < 0.7, `读到 ${corrU}`);
const forceValueAfter = await forceCard.locator(".result-row .tex-box").first().innerText();
check("验收2：设置相关性后计算值仍为 6 N", /=\s*6\s*N/.test(forceValueAfter), forceValueAfter);
check("验收2：列出相关交叉项与共同来源", corrText.includes("相关交叉项") && corrText.includes("标定台"), corrText.slice(-200));
void beforeCorr;

// 验收 3：不对称相关关系只阻塞该公式的不确定度
await rhoInput.fill("0.8");
await page.waitForTimeout(200);
// 通过导入携带两个方向不同 ρ 的 JSON 来制造不对称；先做一个可编辑的手工路径：
// 用页面内无法直接加反向条目，这里验证“超范围 ρ”同样只阻塞不确定度而普通结果仍在
await rhoInput.fill("1.5");
await page.waitForTimeout(300);
const badText = await forceCard.locator(".unc-panel").innerText();
check("验收3：ρ=1.5 标记不确定度未验证", badText.includes("不确定度未验证") && badText.includes("[-1, 1]"), badText.slice(0, 120));
check("验收3：普通结果仍显示 6 N", /=\s*6\s*N/.test(await forceCard.locator(".result-row .tex-box").first().innerText()), "");
// 恢复合法值
await rhoInput.fill("0.8");
await page.waitForTimeout(300);

// 零分母公式（第 4 张卡片）依然报除零错误，且不受新卡片影响
const dz = await cards.nth(3).innerText();
check("验收3：除零卡片仍明确报错（公式隔离）", dz.includes("除数为零"), "");

// ===== 计算快照 =====
const snapshotBtn = forceCard.getByRole("button", { name: /保存计算快照/ });
await snapshotBtn.click();
await page.waitForTimeout(300);
await expectCount(".snapshot", 1, "保存后出现 1 个快照");
const snapText = await forceCard.locator(".snapshot").first().innerText();
check("快照固化结论（含 N 与不确定度）", /6\s*N/.test(snapText) && snapText.includes("0.66"), snapText.match(/u_c[^\n]*/)?.[0] ?? "");
// 保存后修改变量，快照不变
const mInput = forceCard.locator(".var-row:not(.var-head) input").nth(0);
await mInput.fill("9"); // m = 9 kg
await page.waitForTimeout(300);
const snapText2 = await forceCard.locator(".snapshot").first().innerText();
check("修改变量后快照仍保留 6 N（不可变）", /6\s*N/.test(snapText2) && !snapText2.includes("27 N"), "");
await mInput.fill("2");
await page.waitForTimeout(300);

async function expectCount(sel, n, label) {
  const c = await page.locator(sel).count();
  check(label, c === n, `实际 ${c}`);
}

// ===== 验收 4：导出 → 导入 → 刷新，旧记录可算、新记录关系与快照不丢 =====

// 导出当前笔记
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "导出 JSON" }).click(),
]);
const path = "/tmp/notebook-export.json";
await download.saveAs(path);
const exported = JSON.parse(fs.readFileSync(path, "utf8"));
check("导出文件版本为 2", exported.version === 2, `version=${exported.version}`);
const forceExported = exported.formulas.find((x) => x.latex === "m\\cdot a" && x.snapshots?.length);
check("导出包含相关关系", Array.isArray(forceExported.correlations) && forceExported.correlations[0].rho === "0.8", JSON.stringify(forceExported.correlations));
check("导出包含共同来源", forceExported.correlations[0].source.includes("标定台"), "");
check("导出包含快照且快照内有不确定度结论",
  forceExported.snapshots[0].uncertainty?.status === "propagated" && forceExported.snapshots[0].value === 6,
  JSON.stringify(forceExported.snapshots[0]?.uncertainty?.status));

// 构造“旧笔记本 + 新记录”混合文件：取导出内容，把第一条记录降级为 v1 形态
const oldRecord = {
  id: "legacy-v1-record",
  latex: "p+q",
  note: "旧笔记本记录",
  source: "(p)+(q)",
  variables: { p: { value: "10", unit: "N" }, q: { value: "5", unit: "N" } },
  targetUnit: "",
  createdAt: 5,
};
exported.formulas.unshift(oldRecord);
fs.writeFileSync("/tmp/notebook-mixed.json", JSON.stringify(exported));

// 清空当前页面数据后导入混合文件
await page.evaluate(async () => {
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase("dimension-notebook");
    r.onsuccess = r.onerror = r.onblocked = () => res(null);
  });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".app");
await page.waitForTimeout(300);

await page.setInputFiles("input[type=file]", "/tmp/notebook-mixed.json");
await page.waitForTimeout(800);
const allCards = page.locator(".card");
const total = await allCards.count();
check("导入后卡片数 = 混合文件记录数", total === exported.formulas.length, `实际 ${total} vs ${exported.formulas.length}`);

// 第一条：旧记录照常可算、不确定度未声明
const legacy = allCards.first();
check("验收4：旧记录仍可算 = 15 N", /15\s*N/.test(await legacy.locator(".result-row .tex-box").first().innerText()), "");
const legacyUnc = await legacy.locator(".unc-panel").innerText();
check("验收4：旧记录明确标记不确定度未声明", legacyUnc.includes("不确定度未声明"), legacyUnc.slice(0, 60));

// 新记录（m·a）：相关关系回填、快照还在
const newForce = page.locator(".card", { hasText: "同一台标定台" }).first();
check("验收4：新记录相关关系回填 ρ=0.8", await newForce.locator(".corr-rho").inputValue() === "0.8", "");
check("验收4：新记录历史快照仍在", await newForce.locator(".snapshot").count() >= 1, "");
const newSnapUnc = await newForce.locator(".snapshot .unc-badge").first().innerText();
check("验收4：快照中的不确定度结论仍为已传播", newSnapUnc.includes("已传播"), newSnapUnc);

// 刷新页面（IndexedDB 持久化）
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("刷新后卡片数量不变", await page.locator(".card").count() === total, "");
const afterReload = page.locator(".card", { hasText: "同一台标定台" }).first();
check("刷新后相关关系仍在", await afterReload.locator(".corr-rho").inputValue() === "0.8", "");
check("刷新后历史快照仍在", await afterReload.locator(".snapshot").count() >= 1, "");
const legacy2 = page.locator(".card").first();
check("刷新后旧记录仍为 15 N", /15\s*N/.test(await legacy2.locator(".result-row .tex-box").first().innerText()), "");
check("刷新后旧记录仍标记未声明", (await legacy2.locator(".unc-panel").innerText()).includes("不确定度未声明"), "");

// IndexedDB 版本为 2
const dbVersion = await page.evaluate(async () => {
  const dbs = await indexedDB.databases?.() ?? [];
  const hit = dbs.find((d) => d.name === "dimension-notebook");
  return hit?.version;
});
check("IndexedDB 升级到版本 2", dbVersion === 2, `version=${dbVersion}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 5), null, 1));
await browser.close();
if (failed.length) process.exit(1);
