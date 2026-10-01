import { it, expect } from "vitest";
import { analyzeFormula } from "./math";
import { formatUncertainty } from "../components/UncertaintyPanel";

it("零结果除零幂等边界不会进入不确定度", () => {
  const r = analyzeFormula("x^(-1)", { x: { value: "0", unit: "m", uncertainty: "0.1" } }, "");
  expect(r.status).toBe("error");
  expect(r.uncertainty).toBeUndefined();
});

it("不确定度为 0 的变量完全确定：合成结果 0 且不抛异常", () => {
  const r = analyzeFormula("a*b", { a: { value: "2", unit: "kg", uncertainty: "0" }, b: { value: "3", unit: "m/s^2", uncertainty: "0" } }, "");
  expect(r.status).toBe("ok");
  expect(r.uncertainty!.status).toBe("propagated");
  expect(r.uncertainty!.standardUncertainty).toBe(0);
  expect(Number.isNaN(r.uncertainty!.relativeUncertainty!)).toBe(false);
});

it("结果为 0 时相对不确定度为 undefined（不产生 NaN/Infinity）", () => {
  const r = analyzeFormula("x-y", { x: { value: "4", unit: "m", uncertainty: "0.1" }, y: { value: "4", unit: "m", uncertainty: "0.1" } }, "");
  expect(r.value).toBe(0);
  expect(Number.isFinite(r.uncertainty!.standardUncertainty!)).toBe(true);
  expect(r.uncertainty!.relativeUncertainty).toBeUndefined();
});

it("相关系数 1 完全正相关乘除不报错", () => {
  const r = analyzeFormula("x/y", { x: { value: "10", unit: "m", uncertainty: "0.1" }, y: { value: "2", unit: "s", uncertainty: "0.1" } }, "", [{ a: "x", b: "y", rho: "1" }]);
  expect(r.uncertainty!.status).toBe("propagated");
  expect(Number.isFinite(r.uncertainty!.standardUncertainty!)).toBe(true);
});

it("格式化不产生伪精度", () => {
  expect(formatUncertainty(0.104403)).toBe("0.1");
  expect(formatUncertainty(0.66483)).toBe("0.7");
  expect(formatUncertainty(0.0134)).toBe("0.013");
  expect(formatUncertainty(234.5)).toBe("230");
  expect(formatUncertainty(0)).toBe("0");
});
