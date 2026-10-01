// @vitest-environment happy-dom
// FormulaCard 组件级端到端：覆盖验收 1/2/3 的真实 React 渲染与交互（无浏览器依赖）
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup, within } from "@testing-library/react";
import { useState } from "react";
import type { Formula } from "../engine/types";

// mathlive 在 happy-dom 下无需真正注册自定义元素：用普通输入框替代
vi.mock("./MathInput", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="mathinput" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// KaTeX 渲染替换为纯文本（断言只关心文本内容）
vi.mock("./Tex", () => ({
  default: ({ tex }: { tex: string }) => <span data-tex={tex}>{tex}</span>,
}));

import FormulaCard from "./FormulaCard";

afterEach(cleanup);

function Harness({ initial }: { initial: Formula }) {
  const [f, setF] = useState<Formula>(initial);
  return <FormulaCard formula={f} index={0} onChange={(patch) => setF((cur) => ({ ...cur, ...patch }))} onDelete={() => undefined} />;
}

/** 主面板（排除快照内面板） */
const mainPanel = () => document.querySelector(".card-body > .display-area .unc-panel") as HTMLElement | null;
/** 面板中 u_c(y) 的 TeX（Tex 被 mock 为纯文本，\pm 仍为字面量） */
const ucTex = (panel: HTMLElement) =>
  [...panel.querySelectorAll("[data-tex]")].map((e) => (e as HTMLElement).dataset.tex ?? "").find((t) => t.includes("u_c")) ?? "";

const forceIndependent = (): Formula => ({
  id: "f1",
  latex: "m*a",
  note: "F",
  variables: {
    m: { value: "2", unit: "kg", uncertainty: "0.01" },
    a: { value: "3", unit: "m/s^2", uncertainty: "0.05" },
  },
  targetUnit: "",
  correlations: [],
  createdAt: 1,
});

/** u(m)=0.1, u(a)=0.2：独立时 u_F=0.5，ρ=0.8 时 u_F=sqrt(0.442)≈0.6648 */
const forceCorr = (rho = "0.8", extra?: Formula["correlations"]): Formula => ({
  ...forceIndependent(),
  variables: {
    m: { value: "2", unit: "kg", uncertainty: "0.1" },
    a: { value: "3", unit: "m/s^2", uncertainty: "0.2" },
  },
  correlations: extra ?? (rho === "" ? [] : [{ a: "m", b: "a", rho, source: "同一台标定台" }]),
});

describe("验收 1：力 F=m·a 独立测量", () => {
  it("渲染 6 N、传播不确定度 ≈0.104 N（主要贡献项 a 优先）", () => {
    render(<Harness initial={forceIndependent()} />);
    expect(screen.getByText("已验证")).toBeTruthy();
    const resultRow = document.querySelector(".card-body > .display-area .result-row")!;
    expect(resultRow.textContent).toMatch(/6.*mathrm\{N\}/);

    const panel = mainPanel()!;
    expect(panel.textContent).toContain("不确定度已传播");
    expect(ucTex(panel)).toMatch(/u_c\(y\)\s*=\s*\\pm\s*0\.1(04)?/);
    expect(panel.textContent).toContain("1.7%");
    const contrib = panel.querySelector(".unc-contrib ul")!;
    expect(contrib.textContent).toMatch(/a[\s\S]*m/);
  });
});

describe("验收 2：设置相关性后不确定度变化、计算值不变", () => {
  it("独立 → ρ=0.8：u 从 0.5 升到约 0.66，出现交叉项与来源，结果恒为 6 N", () => {
    render(<Harness initial={forceCorr("")} />);
    let panel = mainPanel()!;
    expect(ucTex(panel)).toMatch(/u_c\(y\)\s*=\s*\\pm\s*0\.5/);
    expect(panel.textContent).not.toContain("相关交叉项");

    fireEvent.change(screen.getByPlaceholderText(/ρ/), { target: { value: "0.8" } });
    fireEvent.change(screen.getByPlaceholderText(/共同来源/), { target: { value: "同一台标定台" } });

    panel = mainPanel()!;
    // 0.6648 按 1 位有效数字展示为 0.7（不制造伪精度）
    expect(ucTex(panel)).toMatch(/u_c\(y\)\s*=\s*\\pm\s*0\.7(?!\d)/);
    expect(panel.textContent).toContain("相关交叉项");
    expect(panel.textContent).toContain("同一台标定台");

    const resultRow = document.querySelector(".card-body > .display-area .result-row")!;
    expect(resultRow.textContent).toMatch(/6.*mathrm\{N\}/);
    // 0.7 只属于不确定度行，不出现在结果行
    expect(resultRow.textContent).not.toContain("0.7");
  });

  it("预存的 ρ=0.8 相关关系直接反映在界面与计算上", () => {
    render(<Harness initial={forceCorr("0.8")} />);
    const panel = mainPanel()!;
    expect(ucTex(panel)).toMatch(/\\pm\s*0\.7(?!\d)/);
    expect((screen.getByPlaceholderText(/ρ/) as HTMLInputElement).value).toBe("0.8");
  });
});

describe("验收 3：非法输入只阻塞该公式的不确定度，不影响计算值", () => {
  it("ρ 超范围：标记未验证且不输出数值，但结果仍为 6 N", () => {
    render(<Harness initial={forceCorr("1.5")} />);
    const panel = mainPanel()!;
    expect(panel.textContent).toContain("不确定度未验证");
    expect(panel.textContent).toContain("[-1, 1]");
    expect(ucTex(panel)).toBe("");
    const resultRow = document.querySelector(".card-body > .display-area .result-row")!;
    expect(resultRow.textContent).toMatch(/6.*mathrm\{N\}/);
  });

  it("不对称相关关系：明确提示不对称且不给出传播值", () => {
    const f = forceCorr("", [
      { a: "m", b: "a", rho: "0.8" },
      { a: "a", b: "m", rho: "0.2" },
    ]);
    render(<Harness initial={f} />);
    const panel = mainPanel()!;
    expect(panel.textContent).toContain("不对称");
    const editor = document.querySelector(".corr-editor")!;
    expect(editor.textContent).toContain("不对称");
    expect(screen.getByText("已验证")).toBeTruthy();
    expect(document.querySelector(".card-body > .display-area .result-row")!.textContent)
      .toMatch(/6.*mathrm\{N\}/);
  });

  it("零分母公式：报除零错误（原有语义），不展示不确定度结论", () => {
    const f: Formula = {
      id: "fz", latex: "x/y", note: "",
      variables: {
        x: { value: "10", unit: "m", uncertainty: "0.1" },
        y: { value: "0", unit: "s", uncertainty: "0.01" },
      },
      targetUnit: "", createdAt: 1,
    };
    render(<Harness initial={f} />);
    expect(screen.getByText("有错误")).toBeTruthy();
    expect(screen.getByText(/除数为零/)).toBeTruthy();
    const resultBox = document.querySelector(".card-body > .display-area .result-row .tex-box")!;
    // 只显示错误摘要，不显示结果数值（摘要里的“1 处错误”允许存在）
    expect(resultBox.querySelector("[data-tex]")).toBeNull();
    expect(mainPanel()).toBeNull();
  });

  it("未声明不确定度的旧公式：普通结果正常且明确提示未声明", () => {
    const f: Formula = {
      id: "fold", latex: "a+b", note: "",
      variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "m" } },
      targetUnit: "", createdAt: 1,
    };
    render(<Harness initial={f} />);
    expect(screen.getByText("已验证")).toBeTruthy();
    const panel = mainPanel()!;
    expect(panel.textContent).toContain("不确定度未声明");
    expect(panel.textContent).toContain("普通计算结果照常有效");
  });
});

describe("计算快照持久化展示", () => {
  it("保存后固化结论，随后编辑变量不改变快照", () => {
    render(<Harness initial={forceCorr("0.8")} />);
    fireEvent.click(screen.getByRole("button", { name: /保存计算快照/ }));
    const snap = document.querySelector(".snapshot") as HTMLElement;
    expect(snap).toBeTruthy();
    expect(snap.textContent).toContain("快照 ·");
    expect(within(snap).getByText("不确定度已传播")).toBeTruthy();
    const snapUcTex = [...snap.querySelectorAll("[data-tex]")].map((e) => (e as HTMLElement).dataset.tex ?? "");
    expect(snapUcTex.some((t) => /u_c\(y\).*0\.7(?!\d)/.test(t))).toBe(true);
    expect(snap.textContent).toMatch(/6.*mathrm\{N\}|= 6 N/);

    // 把 m 改为 9 kg：当前结果变为 27 N，但快照仍为 6 N
    const numInputs = document.querySelectorAll(".var-row:not(.var-head) .num-input");
    fireEvent.change(numInputs[0], { target: { value: "9" } });
    const snap2 = document.querySelector(".snapshot") as HTMLElement;
    expect(snap2.textContent).toMatch(/6.*mathrm\{N\}/);
    expect(snap2.textContent).not.toContain("27");
    // 当前结果行已是 27 N
    const resultRow = document.querySelector(".card-body > .display-area .result-row")!;
    expect(resultRow.textContent).toMatch(/27.*mathrm\{N\}/);
  });
});
