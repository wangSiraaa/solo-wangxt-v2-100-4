import { describe, it, expect } from "vitest";
import { analyzeFormula } from "./math";
import type { Correlation, VariableDef } from "./types";

const V = (value: string, unit = "", uncertainty = "", source = ""): VariableDef => ({
  value, unit,
  ...(uncertainty !== "" ? { uncertainty } : {}),
  ...(source !== "" ? { source } : {}),
});
const C = (a: string, b: string, rho: string): Correlation => ({ a, b, rho });

describe("验收 1：力 F = m·a 独立测量的值、单位与传播不确定度", () => {
  it("m=2 kg (u=0.1)、a=3 m/s² (u=0.2)：F=6 N，u_F=0.5 N", () => {
    const r = analyzeFormula("m*a", {
      m: V("2", "kg", "0.1"),
      a: V("3", "m/s^2", "0.2"),
    }, "N");
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.targetValue).toBeCloseTo(6, 10);
    expect(r.targetUnit).toBe("N");
    // u_F = sqrt((a·u_m)^2 + (m·u_a)^2) = sqrt(0.09 + 0.16) = 0.5 N
    expect(r.uncertainty?.status).toBe("declared");
    expect(r.uncertainty?.std).toBeCloseTo(0.5, 9);
    expect(r.uncertainty?.resultUnit).toBe("N");
    // 目标单位 N 下同样为 0.5 N
    expect(r.uncertainty?.targetStd).toBeCloseTo(0.5, 9);
    expect(r.uncertainty?.targetUnit).toBe("N");
    // 相对不确定度 0.5/6（规整为 6 位有效数字）
    expect(r.uncertainty?.relative).toBeCloseTo(0.5 / 6, 5);
    // 两个直接贡献项，m 占 36%、a 占 64%
    const dirs = r.uncertainty!.contributions.filter((c) => c.kind === "direct");
    expect(dirs).toHaveLength(2);
    const mTerm = dirs.find((c) => c.variable === "m")!;
    const aTerm = dirs.find((c) => c.variable === "a")!;
    expect(mTerm.share).toBeCloseTo(36, 8);
    expect(aTerm.share).toBeCloseTo(64, 8);
  });

  it("加减运算：d = v t + d0，不确定度平方相加，单位保持长度", () => {
    const r = analyzeFormula("v*t+d0", {
      v: V("2", "m/s", "0.1"),
      t: V("3", "s", "0.2"),
      d0: V("5", "m", "0.3"),
    }, "m");
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(11, 10);
    // u_d = sqrt((3·0.1)^2 + (2·0.2)^2 + 0.3^2) = sqrt(.09+.16+.09)=sqrt(.34)
    expect(r.uncertainty?.std).toBeCloseTo(Math.sqrt(0.34), 5);
  });

  it("除法：v=d/t，灵敏系数含 1/t 与 d/t²", () => {
    const r = analyzeFormula("d/t", {
      d: V("100", "m", "1"),
      t: V("10", "s", "0.1"),
    }, "");
    expect(r.value).toBeCloseTo(10, 10);
    // u_v = sqrt((u_d/t)^2 + (d/t²·u_t)^2) = sqrt(0.01 + 0.01)
    expect(r.uncertainty?.std).toBeCloseTo(Math.sqrt(0.02), 5);
  });

  it("常数指数幂：A=x^2，u_A=2x·u_x", () => {
    const r = analyzeFormula("x^2", { x: V("3", "m", "0.1") }, "");
    expect(r.value).toBeCloseTo(9, 10);
    expect(r.resultUnit).toBe("m^2");
    expect(r.uncertainty?.std).toBeCloseTo(0.6, 9);
  });

  it("摄氏读数直读 T（degC）：结果可换算 K，不确定度按温标间隔 1:1，不按 273.15", () => {
    const r = analyzeFormula("T", { T: V("25", "degC", "0.5") }, "K");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(298.15, 10);
    expect(r.uncertainty?.std).toBeCloseTo(0.5, 9);
    expect(r.uncertainty?.targetStd).toBeCloseTo(0.5, 9);
  });
});

describe("验收 2：同源相关改变不确定度但不改变计算值", () => {
  it("共同来源默认 ρ=1：u_F=0.7 N ≠ 独立时的 0.5 N，F 仍 = 6 N", () => {
    const r = analyzeFormula("m*a", {
      m: V("2", "kg", "0.1", "同一次标定"),
      a: V("3", "m/s^2", "0.2", "同一次标定"),
    }, "N");
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(6, 10);
    // u_F = |a u_m| + |m u_a| = 0.3 + 0.4 = 0.7
    expect(r.uncertainty?.std).toBeCloseTo(0.7, 9);
    expect(r.uncertainty?.assumption).toContain("同一次标定");
    // 存在相关交叉项且为正贡献
    const cross = r.uncertainty!.contributions.find((c) => c.kind === "cross");
    expect(cross).toBeDefined();
    expect(cross!.share).toBeGreaterThan(0);
  });

  it("显式 ρ=0（独立）覆盖同源默认值，结论与独立假设一致，计算值不变", () => {
    const r = analyzeFormula("m*a", {
      m: V("2", "kg", "0.1", "同一次标定"),
      a: V("3", "m/s^2", "0.2", "同一次标定"),
    }, "N", [C("m", "a", "0"), C("a", "m", "0")]);
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.uncertainty?.std).toBeCloseTo(0.5, 9);
  });

  it("负相关使和 x+y 的不确定度减小：x=1(u=.1)、y=2(u=.1)、ρ=-1 → u=0", () => {
    const r = analyzeFormula("x+y", {
      x: V("1", "", "0.1"),
      y: V("2", "", "0.1"),
    }, "", [C("x", "y", "-1"), C("y", "x", "-1")]);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(3);
    expect(r.uncertainty?.std).toBeCloseTo(0, 9);
  });
});

describe("验收 3：问题关系/除零只阻塞该公式，其他公式结果保留", () => {
  it("不对称（只声明一个方向）：普通值仍给出，不确定度未验证且不伪造数值", () => {
    const r = analyzeFormula("m*a", {
      m: V("2", "kg", "0.1"),
      a: V("3", "m/s^2", "0.2"),
    }, "N", [C("m", "a", "0.8")]);
    expect(r.value).toBeCloseTo(6, 10); // 普通结果语义不变
    expect(r.status).toBe("unverified");
    expect(r.uncertainty?.std).toBeUndefined(); // 绝不输出伪造的传播值
    expect(r.uncertainty?.notes.some((n) => n.blocking && n.message.includes("不完整"))).toBe(true);
    expect(JSON.stringify(r.uncertainty)).not.toContain("NaN");
  });

  it("两个方向系数不一致：标为不对称未验证", () => {
    const r = analyzeFormula("x*y", {
      x: V("2", "", "0.1"),
      y: V("3", "", "0.2"),
    }, "", [C("x", "y", "0.8"), C("y", "x", "0.6")]);
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.status).toBe("unverified");
    expect(r.uncertainty?.std).toBeUndefined();
    expect(r.uncertainty?.notes.some((n) => n.message.includes("不对称"))).toBe(true);
  });

  it("相关系数越界（1.2 与 -2）：未验证，不把相关量当独立量", () => {
    for (const rho of ["1.2", "-2"]) {
      const r = analyzeFormula("x*y", {
        x: V("2", "", "0.1"), y: V("3", "", "0.2"),
      }, "", [C("x", "y", rho), C("y", "x", rho)]);
      expect(r.status).toBe("unverified");
      expect(r.uncertainty?.std).toBeUndefined();
      expect(r.uncertainty?.notes.some((n) => n.message.includes("超出"))).toBe(true);
    }
  });

  it("非正定相关矩阵（三对都是 ρ=-0.9）：负方差，明确未验证且不输出 std", () => {
    const r = analyzeFormula("x+y+z", {
      x: V("1", "", "0.1"),
      y: V("2", "", "0.1"),
      z: V("3", "", "0.1"),
    }, "", [
      C("x", "y", "-0.9"), C("y", "x", "-0.9"),
      C("x", "z", "-0.9"), C("z", "x", "-0.9"),
      C("y", "z", "-0.9"), C("z", "y", "-0.9"),
    ]);
    expect(r.value).toBe(6);
    expect(r.status).toBe("unverified");
    expect(r.uncertainty?.std).toBeUndefined();
    expect(r.uncertainty?.variance).toBeLessThan(0);
    expect(r.uncertainty?.notes.some((n) => n.message.includes("非正定"))).toBe(true);
  });

  it("摄氏读数参与乘法且声明了不确定度：沿用既有未验证语义，不产生任何不确定度数值", () => {
    const r = analyzeFormula("T*2", { T: V("25", "degC", "0.5") }, "");
    expect(r.status).toBe("unverified");
    expect(r.value).toBeUndefined();
    expect(r.issues.some((i) => i.kind === "warning" && i.message.includes("乘除"))).toBe(true);
    expect(r.issues.some((i) => i.message.includes("无法传播"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("NaN");
  });

  it("除零 + 坏相关在一条公式上：另一条好公式照常给出值与不确定度（隔离）", () => {
    const badDiv = analyzeFormula("a/b", { a: V("10", "m", "0.1"), b: V("0", "s") }, "");
    const badCorr = analyzeFormula("x*y", {
      x: V("1", "", "0.1"), y: V("2", "", "0.1"),
    }, "", [C("x", "y", "0.9")]);
    const good = analyzeFormula("m*a", {
      m: V("2", "kg", "0.1"), a: V("3", "m/s^2", "0.2"),
    }, "N");
    expect(badDiv.status).toBe("error");
    expect(badCorr.status).toBe("unverified");
    expect(good.status).toBe("ok");
    expect(good.value).toBeCloseTo(6, 10);
    expect(good.uncertainty?.std).toBeCloseTo(0.5, 9);
  });

  it("超出支持范围的表达式（sqrt）声明不确定度时仍为未验证，不输出不确定度值", () => {
    const r = analyzeFormula("\\sqrt{x}", { x: V("4", "m", "0.1") }, "");
    expect(r.status).toBe("unverified");
    expect(r.uncertainty?.std).toBeUndefined();
  });

  it("负底数 + 带不确定度指数的幂无法验证（ln 负底数）", () => {
    const r = analyzeFormula("x^y", {
      x: V("-2", "", "0"),
      y: V("0.5", "", "0.01"),
    }, "");
    expect(r.value).toBeUndefined();
    expect(r.status).not.toBe("ok");
  });
});

describe("旧记录与未声明：普通结果照常，明确标注不确定度未声明", () => {
  it("没有任何不确定度字段的旧变量：status 仍为 ok，不确定度状态 undeclared", () => {
    const r = analyzeFormula("m*a", {
      m: { value: "2", unit: "kg" },
      a: { value: "3", unit: "m/s^2" },
    }, "N");
    expect(r.status).toBe("ok");
    expect(r.value).toBeCloseTo(6, 10);
    expect(r.uncertainty?.status).toBe("undeclared");
    expect(r.uncertainty?.std).toBeUndefined();
    expect(r.uncertainty?.notes[0].message).toContain("未声明");
  });

  it("常量公式（无变量）标记 none，不产生未声明噪音警告", () => {
    const r = analyzeFormula("2+3*4", {}, "");
    expect(r.status).toBe("ok");
    expect(r.uncertainty?.status).toBe("none");
    expect(r.issues).toEqual([]);
  });

  it("部分变量声明 u：其余变量按精确量（u=0）处理但给出说明", () => {
    const r = analyzeFormula("x*y", {
      x: V("2", "", "0.1"),
      y: V("3", ""),
    }, "");
    expect(r.status).toBe("ok");
    expect(r.uncertainty?.std).toBeCloseTo(0.3, 9); // 仅 3·0.1
    expect(r.uncertainty?.notes.some((n) => !n.blocking && n.message.includes("y"))).toBe(true);
  });
});
