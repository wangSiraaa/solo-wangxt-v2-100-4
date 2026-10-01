import { describe, it, expect } from "vitest";
import { analyzeFormula } from "./math";
import type { CorrelationEntry, VariableDef } from "./types";

const V = (value: string, unit = "", uncertainty?: string): VariableDef =>
  uncertainty === undefined ? { value, unit } : { value, unit, uncertainty };

describe("验收 1：质量与加速度独立测量时的力 F=m·a", () => {
  it("值、单位与传播不确定度正确（独立假设）", () => {
    // m = 2.00 kg, u(m)=0.01 kg；a = 3.00 m/s², u(a)=0.05 m/s²
    const r = analyzeFormula(
      "m*a",
      { m: V("2", "kg", "0.01"), a: V("3", "m/s^2", "0.05") },
      "",
    );
    expect(r.status).toBe("ok");
    expect(r.value).toBe(6);
    expect(r.resultUnit).toBe("N");
    const u = r.uncertainty!;
    expect(u.status).toBe("propagated");
    // ∂F/∂m = a = 3，∂F/∂a = m = 2
    // u_F = sqrt((3·0.01)^2 + (2·0.05)^2) = sqrt(0.0109) ≈ 0.10440
    expect(u.standardUncertainty!).toBeCloseTo(0.104403, 5);
    // 相对不确定度 ≈ 1.740%
    expect(u.relativeUncertainty!).toBeCloseTo(0.01740, 4);
    // 加速度是主要贡献项（u_a/a 更大）
    expect(u.contributors![0].variable).toBe("a");
    expect(u.contributors![0].share).toBeCloseTo(
      Math.pow(2 * 0.05, 2) / (Math.pow(3 * 0.01, 2) + Math.pow(2 * 0.05, 2)), 6,
    );
    // 无相关交叉项
    expect(u.correlationTerms ?? []).toEqual([]);
  });

  it("目标单位换算时同时给出目标单位下的不确定度（线性比例）", () => {
    // v = 100 km / 1 h = 100 km/h；u_x=1 km、u_t=0.01 h
    // 结果原始单位为 km/h（mathjs 保留左操作数单位）
    const r = analyzeFormula(
      "x/t",
      { x: V("100", "km", "1"), t: V("1", "h", "0.01") },
      "m/s",
    );
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(100, 10);
    const u = r.uncertainty!;
    expect(u.status).toBe("propagated");
    // u(v)/(km/h)：(1/1)=1 来自 x，(100/1)·0.01=1 来自 t → sqrt(2)
    expect(u.standardUncertainty!).toBeCloseTo(Math.SQRT2, 10);
    // u(v)/(m/s) = u(v)/(km/h) / 3.6
    expect(u.targetStandardUncertainty!).toBeCloseTo(Math.SQRT2 / 3.6, 10);
  });
});

describe("验收 2：同源变量设置相关性后不确定度变化但计算值不变", () => {
  const vars = { m: V("2", "kg", "0.1"), a: V("3", "m/s^2", "0.2") };

  it("独立假设：u 较小", () => {
    const r = analyzeFormula("m*a", vars, "");
    expect(r.value).toBe(6);
    expect(r.uncertainty!.status).toBe("propagated");
    // 独立：sqrt((a um)^2 + (m ua)^2) = sqrt(0.3² + 0.4²) = 0.5
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(0.5, 10);
  });

  it("ρ=0.8（同源）：u 更大且列出交叉项，但计算值仍为 6 N", () => {
    const corr: CorrelationEntry[] = [
      { a: "m", b: "a", rho: "0.8", source: "同一台标定台" },
    ];
    const r = analyzeFormula("m*a", vars, "", corr);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(6);
    expect(r.resultUnit).toBe("N");
    const u = r.uncertainty!;
    expect(u.status).toBe("propagated");
    // 相关：u² = 0.3² + 0.4² + 2·0.3·0.4·0.8 = 0.442 → u ≈ 0.66483
    expect(u.standardUncertainty!).toBeCloseTo(Math.sqrt(0.442), 6);
    expect(u.standardUncertainty!).toBeGreaterThan(0.5);
    expect(u.correlationTerms).toHaveLength(1);
    expect(u.correlationTerms![0]).toMatchObject({ a: "m", b: "a", rho: 0.8 });
    expect(u.correlationTerms![0].variance).toBeCloseTo(2 * 0.3 * 0.4 * 0.8, 10);
  });

  it("正相关使差值的不确定度减小（共同误差在相减时抵消）", () => {
    const v2 = { x: V("10", "m", "0.1"), y: V("4", "m", "0.1") };
    const indep = analyzeFormula("x-y", v2, "");
    expect(indep.uncertainty!.standardUncertainty!).toBeCloseTo(Math.SQRT2 * 0.1, 10);
    // y = x₁ − x₂：u² = ux²+uy² − 2ρ·ux·uy；ρ=+1 时共同误差完全抵消 → 0
    const pos = analyzeFormula("x-y", v2, "", [{ a: "x", b: "y", rho: "1" }]);
    expect(pos.uncertainty!.standardUncertainty!).toBeCloseTo(0, 10);
    expect(pos.value).toBe(6);
    // ρ=−1 时误差同向叠加 → 0.2
    const neg = analyzeFormula("x-y", v2, "", [{ a: "x", b: "y", rho: "-1" }]);
    expect(neg.uncertainty!.standardUncertainty!).toBeCloseTo(0.2, 10);
  });
});

describe("验收 3：非法相关关系 / 零分母只阻塞该公式的不确定度或结果", () => {
  const vars = { m: V("2", "kg", "0.1"), a: V("3", "m/s^2", "0.2") };

  it("不对称相关关系：不确定度标记未验证，但计算值仍然给出", () => {
    const corr: CorrelationEntry[] = [
      { a: "m", b: "a", rho: "0.8" },
      { a: "a", b: "m", rho: "0.2" },
    ];
    const r = analyzeFormula("m*a", vars, "", corr);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(6);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("；")).toContain("不对称");
    expect(r.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("相关系数超出 [-1,1]：未验证", () => {
    const r = analyzeFormula("m*a", vars, "", [{ a: "m", b: "a", rho: "1.5" }]);
    expect(r.value).toBe(6);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("[-1, 1]");
  });

  it("相关关系不完整（rho 留空）：未验证，不得假定为独立", () => {
    const r = analyzeFormula("m*a", vars, "", [{ a: "m", b: "a", rho: "" }]);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("未填写完整");
  });

  it("非半正定相关矩阵：未验证", () => {
    const v3 = {
      x: V("1", "", "0.1"), y: V("1", "", "0.1"), z: V("1", "", "0.1"),
    };
    const corr: CorrelationEntry[] = [
      { a: "x", b: "y", rho: "0.9" },
      { a: "y", b: "z", rho: "0.9" },
      { a: "x", b: "z", rho: "-0.9" },
    ];
    const r = analyzeFormula("x+y+z", v3, "", corr);
    expect(r.status).toBe("ok");
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("半正定");
  });

  it("相关关系引用不存在的变量：未验证", () => {
    const r = analyzeFormula("m*a", vars, "", [{ a: "m", b: "zzz", rho: "0.5" }]);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("不存在");
  });

  it("含零分母的公式：普通结果报除零错误（原有语义不变），不确定度缺省", () => {
    const r = analyzeFormula(
      "x/y",
      { x: V("10", "m", "0.1"), y: V("0", "s", "0.01") },
      "",
    );
    expect(r.status).toBe("error");
    expect(r.issues.some((i) => i.message.includes("除数为零"))).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.uncertainty).toBeUndefined();
  });

  it("同一笔记内：一条公式非法不影响其他公式", () => {
    const bad = analyzeFormula("m*a", vars, "", [{ a: "m", b: "a", rho: "2" }]);
    const zero = analyzeFormula("x/y", { x: V("1"), y: V("0") }, "");
    const good = analyzeFormula("a+b", { a: V("1", "m", "0.01"), b: V("2", "m", "0.02") }, "");
    expect(bad.uncertainty!.status).toBe("unverified");
    expect(zero.status).toBe("error");
    expect(good.status).toBe("ok");
    expect(good.value).toBe(3);
    expect(good.uncertainty!.status).toBe("propagated");
    expect(good.uncertainty!.standardUncertainty!).toBeCloseTo(Math.hypot(0.01, 0.02), 10);
  });
});

describe("未声明 / 部分声明 / 旧笔记本兼容", () => {
  it("所有变量都未声明不确定度：状态 undeclared 且普通结果照常", () => {
    const r = analyzeFormula("a+b", { a: V("1", "m"), b: V("2", "m") }, "");
    expect(r.status).toBe("ok");
    expect(r.value).toBe(3);
    expect(r.uncertainty!.status).toBe("undeclared");
    expect(r.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("只声明部分变量：未验证，提示缺哪一个，不默认取零", () => {
    const r = analyzeFormula("a+b", { a: V("1", "m", "0.01"), b: V("2", "m") }, "");
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.issues.join("")).toContain("b");
    expect(r.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("不确定度文本非法（负/非数）：未验证且不产出数值", () => {
    const r1 = analyzeFormula("a", { a: V("1", "m", "-0.1") }, "");
    expect(r1.uncertainty!.status).toBe("unverified");
    const r2 = analyzeFormula("a", { a: V("1", "m", "abc") }, "");
    expect(r2.uncertainty!.status).toBe("unverified");
  });

  it("常量公式：状态 none", () => {
    const r = analyzeFormula("pi/2", {}, "");
    expect(r.uncertainty!.status).toBe("none");
  });
});

describe("摄氏读数与超出范围表达式", () => {
  it("对摄氏读数做不支持运算：整体未验证（既有语义），不产出不确定度数值", () => {
    const r = analyzeFormula("T*2", { T: V("25", "degC", "0.5") }, "");
    expect(r.status).toBe("unverified");
    expect(r.value).toBeUndefined();
  });

  it("变量作指数：普通结果可算，但不确定度传播标记未验证", () => {
    const r = analyzeFormula("2^n", { n: V("3", "", "0.01") }, "");
    expect(r.status).toBe("ok");
    expect(r.value).toBe(8);
    expect(r.uncertainty!.status).toBe("unverified");
    expect(r.uncertainty!.standardUncertainty).toBeUndefined();
  });

  it("sqrt 函数：普通结果未验证，不进行不确定度传播", () => {
    const r = analyzeFormula("\\sqrt{x}", { x: V("4", "m", "0.1") }, "");
    expect(r.status).toBe("unverified");
  });
});

describe("线性化传播在加减乘除幂上的数值核验", () => {
  it("加减：灵敏度 ±1", () => {
    const r = analyzeFormula("x+y-z", {
      x: V("10", "m", "0.2"), y: V("5", "m", "0.3"), z: V("2", "m", "0.1"),
    }, "");
    expect(r.value).toBe(13);
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(Math.hypot(0.2, 0.3, 0.1), 10);
  });

  it("除法：u(v)/v = sqrt((u_x/x)^2+(u_t/t)^2)", () => {
    const r = analyzeFormula("x/t", { x: V("100", "m", "1"), t: V("10", "s", "0.2") }, "");
    const expectedRel = Math.hypot(1 / 100, 0.2 / 10);
    expect(r.uncertainty!.relativeUncertainty!).toBeCloseTo(expectedRel, 10);
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(10 * expectedRel, 10);
  });

  it("幂 x^2：u = 2|x|u_x", () => {
    const r = analyzeFormula("x^2", { x: V("3", "m", "0.01") }, "");
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(2 * 3 * 0.01, 10);
  });

  it("同一变量多次出现：平方/差抵消等情形灵敏度正确", () => {
    // x-x = 0，导数为 0（相关联的同一符号），不确定度也为 0，而非 sqrt2 u
    const r = analyzeFormula("x-x", { x: V("5", "m", "0.1") }, "");
    expect(r.value).toBe(0);
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(0, 12);
  });

  it("偏移温标的不确定度按刻度斜率传播（degF 1 = 5/9 K）", () => {
    // 以目标单位换算使用 degF 读数：仅单位换算路径，u_K = 5/9 u_F
    const r = analyzeFormula("T", { T: V("68", "degF", "1.8") }, "K");
    expect(r.targetValue!).toBeCloseTo(293.15, 8);
    expect(r.uncertainty!.targetStandardUncertainty!).toBeCloseTo(1.0, 8);
  });

  it("变量别名 T1/T_1：不确定度按同一输入量传播", () => {
    const r = analyzeFormula("T1*2", { T_1: V("5", "m", "0.1") }, "");
    expect(r.status).toBe("ok");
    expect(r.value).toBe(10);
    expect(r.uncertainty!.status).toBe("propagated");
    expect(r.uncertainty!.standardUncertainty!).toBeCloseTo(0.2, 10);
  });
});
