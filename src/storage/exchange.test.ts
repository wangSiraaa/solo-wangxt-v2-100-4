import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import type { Formula } from "../engine/types";
import { newId } from "./db";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "4", unit: "m/s^2" } },
  targetUnit: "m",
  createdAt: 1,
  ...p,
});

describe("导出 / 导入", () => {
  it("导出保留可编辑 LaTeX 与变量赋值", () => {
    const data = buildExport([f()]);
    expect(data.app).toBe("dimension-notebook");
    expect(data.formulas[0].latex).toContain("\\frac");
    expect(data.formulas[0].source).toContain("v");
    expect(data.formulas[0].variables.a.unit).toBe("m/s^2");
  });

  it("导入后公式可重新分析，结果一致", () => {
    const original = f();
    const before = analyzeFormula(original.latex, original.variables, original.targetUnit);
    const text = JSON.stringify(buildExport([original]));
    const { formulas, errors } = parseImport(text, new Set());
    expect(errors).toEqual([]);
    expect(formulas).toHaveLength(1);
    const after = analyzeFormula(formulas[0].latex, formulas[0].variables, formulas[0].targetUnit);
    expect(after.status).toBe(before.status);
    expect(after.value).toBe(before.value);
    // LaTeX 原样保留，可再次用 MathLive 编辑
    expect(formulas[0].latex).toBe(original.latex);
  });

  it("id 冲突时重新生成，不覆盖现有笔记", () => {
    const original = f();
    const text = JSON.stringify(buildExport([original]));
    const { formulas } = parseImport(text, new Set([original.id]));
    expect(formulas[0].id).not.toBe(original.id);
  });

  it("非法文件给出错误", () => {
    expect(parseImport("not json", new Set()).errors.length).toBeGreaterThan(0);
    expect(parseImport(JSON.stringify({ app: "x" }), new Set()).errors.length).toBeGreaterThan(0);
  });

  it("缺少字段的记录被跳过并报错", () => {
    const text = JSON.stringify({ app: "dimension-notebook", version: 1, formulas: [{ note: "no latex" }] });
    const r = parseImport(text, new Set());
    expect(r.formulas).toHaveLength(0);
    expect(r.errors.length).toBe(1);
  });
});

describe("验收 4：旧笔记导入、v2 往返与快照/来源持久化", () => {
  it("v1 旧笔记（无不确定度字段）导入后仍可按原结果计算，不确定度明确为未声明", () => {
    const v1 = JSON.stringify({
      app: "dimension-notebook",
      version: 1,
      exportedAt: "2025-01-01T00:00:00.000Z",
      formulas: [{
        id: "old1",
        latex: "m\\cdot a",
        note: "旧记录",
        source: "m*a",
        variables: {
          m: { value: "2", unit: "kg" },
          a: { value: "3", unit: "m/s^2" },
        },
        targetUnit: "N",
        createdAt: 1,
      }],
    });
    const { formulas, errors } = parseImport(v1, new Set());
    expect(errors).toEqual([]);
    expect(formulas).toHaveLength(1);
    const f = formulas[0];
    expect(f.correlations).toBeUndefined();
    expect(f.snapshots).toBeUndefined();
    const r = analyzeFormula(f.latex, f.variables, f.targetUnit, f.correlations ?? []);
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.targetUnit).toBe("N");
    expect(r.uncertainty?.status).toBe("undeclared");
    expect(r.uncertainty?.std).toBeUndefined();
  });

  it("新记录导出 → 导入：不确定度、共同来源、显式相关、历史快照均不丢失", () => {
    const original = f({
      latex: "m\\cdot a",
      note: "新记录",
      variables: {
        m: { value: "2", unit: "kg", uncertainty: "0.1", source: "同一次标定" },
        a: { value: "3", unit: "m/s^2", uncertainty: "0.2", source: "同一次标定" },
      },
      correlations: [
        { a: "m", b: "a", rho: "0.8" },
        { a: "a", b: "m", rho: "0.8" },
      ],
      snapshots: [{
        at: 1234567890,
        kind: "manual",
        latex: "m\\cdot a",
        source: "(m)*(a)",
        substituted: "(2 kg) * (3 m / s^2)",
        originalTex: "m \\cdot a",
        substitutedTex: "(2\\,\\mathrm{kg})\\cdot(3\\,\\mathrm{m/s^{2}})",
        variables: {
          m: { value: "2", unit: "kg", uncertainty: "0.1", source: "同一次标定" },
          a: { value: "3", unit: "m/s^2", uncertainty: "0.2", source: "同一次标定" },
        },
        targetUnit: "N",
        status: "ok" as const,
        value: 6,
        resultUnit: "N",
        targetValue: 6,
        targetUnitConverted: "N",
        uncertainty: {
          status: "declared" as const,
          std: 0.628,
          resultUnit: "N",
          relative: 0.1047,
          targetStd: 0.628,
          targetUnit: "N",
          contributions: [
            { variable: "m,a", kind: "cross" as const, amount: 0.32, share: 25.9, label: "m 与 a 的相关交叉项（ρ=0.8）" },
            { variable: "m", kind: "direct" as const, amount: 0.3, share: 22.8, label: "m 的直接不确定度项" },
            { variable: "a", kind: "direct" as const, amount: 0.4, share: 40.6, label: "a 的直接不确定度项" },
          ],
          assumption: "相关：m 与 a（显式声明，ρ=0.8）；其余变量对视为独立量",
          notes: [],
        },
      }],
    });

    // 导出前实时分析：值与同源默认结论正确
    const before = analyzeFormula(original.latex, original.variables, original.targetUnit, original.correlations);
    expect(before.value).toBeCloseTo(6, 10);
    // 显式 ρ=0.8：u²=0.09+0.16+2·0.3·0.4·0.8 = 0.442
    expect(before.uncertainty?.std).toBeCloseTo(Math.sqrt(0.442), 5);

    const text = JSON.stringify(buildExport([original]));
    const { formulas, errors } = parseImport(text, new Set());
    expect(errors).toEqual([]);
    const got = formulas[0];

    // 变量级声明保留
    expect(got.variables.m.uncertainty).toBe("0.1");
    expect(got.variables.m.source).toBe("同一次标定");
    expect(got.variables.a.uncertainty).toBe("0.2");
    expect(got.variables.a.source).toBe("同一次标定");

    // 不对称/对称信息原样保留：导入后仍能识别为对称的 0.8，结论可复算
    expect(got.correlations).toEqual(original.correlations);
    const after = analyzeFormula(got.latex, got.variables, got.targetUnit, got.correlations ?? []);
    expect(after.value).toBeCloseTo(6, 10);
    expect(after.uncertainty?.std).toBeCloseTo(Math.sqrt(0.442), 5);

    // 历史快照（含原式/代入式 TeX、贡献项、相关假设）完整保留
    expect(got.snapshots).toHaveLength(1);
    const snap = got.snapshots![0];
    expect(snap.kind).toBe("manual");
    expect(snap.originalTex).toContain("m");
    expect(snap.substitutedTex).toContain("kg");
    expect(snap.uncertainty?.std).toBeCloseTo(0.628, 10);
    expect(snap.uncertainty?.contributions).toHaveLength(3);
    expect(snap.uncertainty?.assumption).toContain("ρ=0.8");
  });

  it("再次导出 + 导入（二次往返）后来源、相关与快照仍然保留", () => {
    const original = f({
      variables: {
        m: { value: "2", unit: "kg", uncertainty: "0.1", source: "仪器X" },
        a: { value: "3", unit: "m/s^2", uncertainty: "0.2", source: "仪器X" },
      },
      correlations: [
        { a: "m", b: "a", rho: "0.5" },
        { a: "a", b: "m", rho: "0.5" },
      ],
      snapshots: [{
        at: 42, kind: "auto",
        latex: "m\\cdot a", source: "(m)*(a)", substituted: "(2 kg) * (3 m / s^2)",
        originalTex: "m \\cdot a", substitutedTex: "x",
        variables: { m: { value: "2", unit: "kg", uncertainty: "0.1", source: "仪器X" } },
        targetUnit: "", status: "ok" as const, value: 6, resultUnit: "N",
        uncertainty: {
          status: "declared" as const, std: 0.557, resultUnit: "N",
          contributions: [], assumption: "共同来源", notes: [],
        },
      }],
    });
    const once = parseImport(JSON.stringify(buildExport([original])), new Set()).formulas[0];
    const twice = parseImport(JSON.stringify(buildExport([once])), new Set()).formulas[0];
    expect(twice.variables.m.source).toBe("仪器X");
    expect(twice.correlations).toHaveLength(2);
    expect(twice.snapshots).toHaveLength(1);
    expect(twice.snapshots![0].uncertainty?.std).toBeCloseTo(0.557, 10);
  });

  it("不对称的单边相关关系经往返保留：重新分析仍标未验证，计算值不变", () => {
    const original = f({
      latex: "x*y",
      variables: {
        x: { value: "2", unit: "", uncertainty: "0.1" },
        y: { value: "3", unit: "", uncertainty: "0.2" },
      },
      targetUnit: "",
      correlations: [{ a: "x", b: "y", rho: "0.8" }],
    });
    const text = JSON.stringify(buildExport([original]));
    const got = parseImport(text, new Set()).formulas[0];
    expect(got.correlations).toEqual([{ a: "x", b: "y", rho: "0.8" }]);
    const r = analyzeFormula(got.latex, got.variables, got.targetUnit, got.correlations ?? []);
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.status).toBe("unverified");
    expect(r.uncertainty?.std).toBeUndefined();
  });

  it("损坏的快照/不确定度字段被清洗，不产生 NaN 或伪精度", () => {
    const text = JSON.stringify({
      app: "dimension-notebook",
      version: 2,
      formulas: [{
        id: "dirty",
        latex: "x",
        variables: { x: { value: "2", unit: "", uncertainty: "0.1" } },
        targetUnit: "",
        createdAt: 1,
        snapshots: [
          { at: "not-a-number", kind: "weird", latex: "x", source: "x", substituted: "x",
            variables: {}, targetUnit: "", status: "ok",
            uncertainty: { status: "declared", std: NaN, contributions: "not-array",
              assumption: 42, notes: [{ message: "ok" }] } },
          { latex: "missing required fields" },
        ],
      }],
    });
    const got = parseImport(text, new Set()).formulas[0];
    const snap = got.snapshots![0];
    expect(snap.kind).toBe("auto"); // 非法 kind 退回 auto
    expect(typeof snap.at).toBe("number");
    expect(snap.uncertainty?.std).toBeUndefined(); // NaN 被丢弃
    expect(snap.uncertainty?.contributions).toEqual([]);
    expect(snap.uncertainty?.assumption).toBe("");
    expect(snap.uncertainty?.notes).toEqual([{ message: "ok", blocking: false }]);
    // 实时分析仍正常
    const r = analyzeFormula(got.latex, got.variables, got.targetUnit);
    expect(r.value).toBe(2);
    expect(r.uncertainty?.std).toBeCloseTo(0.1, 10);
  });
});
