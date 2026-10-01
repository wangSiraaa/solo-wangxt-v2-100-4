import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import type { CorrelationEntry, Formula, VariableDef } from "../engine/types";
import { newId } from "./db";
import { buildSnapshot, sanitizeSnapshot } from "./snapshot";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "4", unit: "m/s^2" } },
  targetUnit: "m",
  createdAt: 1,
  ...p,
});

const V = (value: string, unit = "", uncertainty?: string): VariableDef =>
  uncertainty === undefined ? { value, unit } : { value, unit, uncertainty };

describe("导出 / 导入（首版）", () => {
  it("导出保留可编辑 LaTeX 与变量赋值", () => {
    const data = buildExport([f()]);
    expect(data.app).toBe("dimension-notebook");
    expect(data.version).toBe(2);
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

describe("验收 4：不确定度、相关关系与快照的 JSON 往返", () => {
  it("v2 导出保留标准不确定度、相关关系与共同来源", () => {
    const corr: CorrelationEntry[] = [
      { a: "m", b: "a", rho: "0.8", source: "同一台标定台" },
    ];
    const original = f({
      latex: "m*a",
      note: "F",
      variables: { m: V("2", "kg", "0.1"), a: V("3", "m/s^2", "0.2") },
      correlations: corr,
      targetUnit: "",
    });
    const text = JSON.stringify(buildExport([original]));
    const { formulas, errors } = parseImport(text, new Set());
    expect(errors).toEqual([]);
    const got = formulas[0];
    expect(got.variables.m.uncertainty).toBe("0.1");
    expect(got.variables.a.uncertainty).toBe("0.2");
    expect(got.correlations).toEqual(corr);

    // 再分析：值不变、相关传播结论一致
    const r = analyzeFormula(got.latex, got.variables, got.targetUnit, got.correlations);
    expect(r.value).toBe(6);
    expect(r.uncertainty!.status).toBe("propagated");
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(Math.sqrt(0.442), 8);
    expect(r.uncertainty!.correlationTerms![0].source).toBe("同一台标定台");
  });

  it("快照（原式/代入式/结果/不确定度）导出再导入不丢失，且不再随后续编辑变化", () => {
    const original = f({
      latex: "m*a",
      variables: { m: V("2", "kg", "0.01"), a: V("3", "m/s^2", "0.05") },
      correlations: [],
      targetUnit: "",
    });
    const analyzed = analyzeFormula(original.latex, original.variables, "", []);
    const snap = buildSnapshot(original, analyzed);
    original.snapshots = [snap];

    const text = JSON.stringify(buildExport([original]));
    const { formulas, errors } = parseImport(text, new Set());
    expect(errors).toEqual([]);
    const got = formulas[0];
    expect(got.snapshots).toHaveLength(1);
    const s0 = got.snapshots![0];
    expect(s0.latex).toBe("m*a");
    expect(s0.source).toContain("m");
    expect(s0.substituted).toContain("kg");
    expect(s0.value).toBe(6);
    expect(s0.resultUnit).toBe("N");
    expect(s0.uncertainty?.status).toBe("propagated");
    expect(s0.uncertainty?.standardUncertainty).toBeCloseTo(0.104403, 5);
    expect(s0.uncertainty?.contributors?.[0].variable).toBe("a");
    expect(s0.uncertainty?.correlationTerms).toEqual([]);
  });

  it("旧笔记本（v1，无任何不确定度字段）导入后照常计算，且明确标记未声明", () => {
    const v1 = {
      app: "dimension-notebook",
      version: 1,
      exportedAt: new Date(0).toISOString(),
      formulas: [{
        id: "old1",
        latex: "a+b",
        note: "旧记录",
        source: "(a)+(b)",
        variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "m" } },
        targetUnit: "",
        createdAt: 123,
      }],
    };
    const { formulas, errors } = parseImport(JSON.stringify(v1), new Set());
    expect(errors).toEqual([]);
    expect(formulas).toHaveLength(1);
    expect(formulas[0].variables.a.uncertainty).toBeUndefined();
    expect(formulas[0].correlations).toBeUndefined();
    expect(formulas[0].snapshots).toBeUndefined();
    const r = analyzeFormula(formulas[0].latex, formulas[0].variables, formulas[0].targetUnit, formulas[0].correlations);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(3);
    expect(r.resultUnit).toBe("m");
    expect(r.uncertainty!.status).toBe("undeclared");
    expect(r.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("往返后再导出（二次往返）信息仍不丢失", () => {
    const corr: CorrelationEntry[] = [{ a: "x", b: "y", rho: "0.5", source: "同一只应变片" }];
    const original = f({
      latex: "x+y",
      variables: { x: V("1", "m", "0.1"), y: V("2", "m", "0.2") },
      correlations: corr,
    });
    const text1 = JSON.stringify(buildExport([original]));
    const once = parseImport(text1, new Set()).formulas;
    const text2 = JSON.stringify(buildExport(once));
    const twice = parseImport(text2, new Set()).formulas;
    expect(twice[0].correlations).toEqual(corr);
    expect(twice[0].variables.x.uncertainty).toBe("0.1");
  });

  it("不对称相关关系原样保留（不自动对称化），再分析时标记未验证", () => {
    const original = f({
      latex: "m*a",
      variables: { m: V("2", "kg", "0.1"), a: V("3", "m/s^2", "0.2") },
      correlations: [
        { a: "m", b: "a", rho: "0.8" },
        { a: "a", b: "m", rho: "0.2" },
      ],
    });
    const text = JSON.stringify(buildExport([original]));
    const { formulas } = parseImport(text, new Set());
    expect(formulas[0].correlations).toHaveLength(2);
    const r = analyzeFormula(formulas[0].latex, formulas[0].variables, "", formulas[0].correlations);
    expect(r.value).toBe(6);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("不对称");
  });

  it("损坏的快照条目被丢弃并报错，但不影响公式与其他快照", () => {
    const good = f({ latex: "x", variables: { x: V("1", "m", "0.1") } });
    const snap = buildSnapshot(good, analyzeFormula("x", good.variables, ""));
    const text = JSON.stringify({
      app: "dimension-notebook", version: 2, formulas: [{
        ...JSON.parse(JSON.stringify(buildExport([good]).formulas[0])),
        snapshots: [snap, { id: 123, savedAt: "bad" }, null],
      }],
    });
    const { formulas, errors } = parseImport(text, new Set());
    expect(formulas).toHaveLength(1);
    expect(formulas[0].snapshots).toHaveLength(1);
    expect(errors.some((m) => m.includes("快照"))).toBe(true);
  });
});

describe("快照清洗", () => {
  it("NaN/Infinity 数值被剔除（不复活伪精度）", () => {
    const clean = sanitizeSnapshot({
      id: "s", savedAt: 1, latex: "x", status: "ok", value: NaN,
      uncertainty: { status: "propagated", standardUncertainty: Infinity, issues: [] },
    });
    expect(clean).not.toBeNull();
    expect(clean!.value).toBeUndefined();
    expect(clean!.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("非法状态返回 null", () => {
    expect(sanitizeSnapshot({ id: "s", savedAt: 1, latex: "x", status: "bogus" })).toBeNull();
  });
});
