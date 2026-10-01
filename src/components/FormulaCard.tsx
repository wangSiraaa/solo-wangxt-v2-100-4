// 单条公式卡片：输入、变量赋值、原式/替换式/结果三段展示、问题定位、
// 测量不确定度传播结论，以及持久化的计算快照（auto + manual）
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalcSnapshot, Correlation, Formula, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import MathInput from "./MathInput";
import Tex from "./Tex";
import VariableTable from "./VariableTable";
import CorrelationEditor from "./CorrelationEditor";
import UncertaintyPanel from "./UncertaintyPanel";
import SnapshotPanel from "./SnapshotPanel";

interface Props {
  formula: Formula;
  index: number;
  onChange: (patch: Partial<Formula>) => void;
  onDelete: () => void;
}

const STATUS_META = {
  ok: { label: "已验证", cls: "ok" },
  unverified: { label: "未验证", cls: "warn" },
  error: { label: "有错误", cls: "err" },
  empty: { label: "空公式", cls: "empty" },
} as const;

const MAX_SNAPSHOTS = 20;

/** 决定“最近计算”内容的输入签名：原式/变量/目标单位/相关关系任一变化都另记一次 */
function signatureOf(f: Formula): string {
  return JSON.stringify({
    l: f.latex,
    v: f.variables,
    t: f.targetUnit,
    c: f.correlations ?? [],
  });
}

function snapshotFromResult(f: Formula, r: ReturnType<typeof analyzeFormula>, kind: CalcSnapshot["kind"]): CalcSnapshot {
  return {
    at: Date.now(),
    kind,
    latex: f.latex,
    source: r.source ?? "",
    substituted: r.substituted ?? "",
    originalTex: r.originalTex ?? "",
    substitutedTex: r.substitutedTex ?? "",
    // 快照内固化当时的变量副本，后续编辑不会改写历史
    variables: JSON.parse(JSON.stringify(f.variables)) as Record<string, VariableDef>,
    targetUnit: f.targetUnit,
    status: r.status,
    value: r.value,
    resultUnit: r.resultUnit,
    targetValue: r.targetValue,
    targetUnitConverted: r.targetUnit,
    uncertainty: r.uncertainty ? JSON.parse(JSON.stringify(r.uncertainty)) : undefined,
  };
}

export default function FormulaCard({ formula, index, onChange, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [showCorr, setShowCorr] = useState(false);
  const result = useMemo(
    () => analyzeFormula(formula.latex, formula.variables, formula.targetUnit, formula.correlations ?? []),
    [formula.latex, formula.variables, formula.targetUnit, formula.correlations],
  );
  const meta = STATUS_META[result.status];

  const setVars = (variables: Record<string, VariableDef>) => onChange({ variables });
  const setCorr = (correlations: Correlation[]) => onChange({ correlations });

  // 自动快照：仅当本次分析 status=ok 且输入签名变化时，替换旧的 auto 快照。
  // 用 ref 记住上次签名，避免把同一次输入的重渲染重复入账。
  const lastAutoSig = useRef<string | null>(null);
  const sig = signatureOf(formula);
  const snapshots = formula.snapshots ?? [];

  useEffect(() => {
    if (result.status !== "ok") return;
    if (lastAutoSig.current === sig) return;
    lastAutoSig.current = sig;
    const auto = snapshotFromResult(formula, result, "auto");
    const manuals = (formula.snapshots ?? []).filter((s) => s.kind === "manual");
    onChange({ snapshots: [auto, ...manuals].slice(0, MAX_SNAPSHOTS) });
    // 仅在“输入签名/验证状态”变化时落快照；快照数组自身变化不触发，避免自我追打
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, result.status, result, formula, onChange]);

  const saveManual = () => {
    const snap = snapshotFromResult(formula, result, "manual");
    // 同一毫秒内连续留存时避免 key 冲突
    const lastAt = (formula.snapshots ?? [])[0]?.at ?? 0;
    if (snap.at <= lastAt) snap.at = lastAt + 1;
    // manual 保留全部（auto 仍在最前），上限内最旧的手动记录被挤出
    const next = [snap, ...(formula.snapshots ?? [])].slice(0, MAX_SNAPSHOTS);
    onChange({ snapshots: next });
  };

  const deleteSnapshot = (at: number, kind: "manual" | "auto") => {
    onChange({ snapshots: (formula.snapshots ?? []).filter((s) => !(s.at === at && s.kind === kind)) });
  };

  return (
    <section className={`card status-${meta.cls}`}>
      <header className="card-head">
        <button type="button" className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>公式 {index + 1}</strong>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        <span className="summary">{result.summary}</span>
        <button type="button" className="mini-btn danger" onClick={onDelete} title="删除此公式（不影响其他公式）">
          删除
        </button>
      </header>

      {!collapsed && (
        <div className="card-body">
          <label className="field-label">
            输入表达式（支持 + − × ÷、幂、分数、括号；变量用字母或下标，如 <code>v</code>、<code>x_1</code>、<code>θ</code>）
            <MathInput
              value={formula.latex}
              onChange={(latex) => onChange({ latex })}
              placeholder="例如  m \\cdot a"
            />
          </label>

          <div className="grid-2">
            <div>
              <div className="field-label">
                变量赋值（可填标准不确定度 u 与共同来源）
              </div>
              <VariableTable names={result.variables} value={formula.variables} onChange={setVars} />
              {result.variables.length >= 2 && (
                <button
                  type="button"
                  className="mini-btn corr-toggle"
                  onClick={() => setShowCorr((v) => !v)}
                >
                  {showCorr ? "▾ 收起相关系数矩阵" : "▸ 编辑变量间相关系数 ρ（可选）"}
                </button>
              )}
              {showCorr && result.variables.length >= 2 && (
                <CorrelationEditor names={result.variables} value={formula.correlations ?? []} onChange={setCorr} />
              )}
            </div>
            <div>
              <label className="field-label">
                结果目标单位（可选；用于常用单位换算，如 K、degF、deg、rad、km/h、N）
                <input
                  className="unit-result-input"
                  list="unit-suggestions"
                  value={formula.targetUnit}
                  placeholder="自动（保留计算单位）"
                  onChange={(e) => onChange({ targetUnit: e.target.value })}
                />
              </label>
              <label className="field-label">
                备注
                <input
                  value={formula.note}
                  placeholder="例如：牛顿第二定律 F = m a"
                  onChange={(e) => onChange({ note: e.target.value })}
                />
              </label>
            </div>
          </div>

          {result.source !== undefined && (
            <div className="display-area">
              <div className="display-row">
                <span className="row-tag">原式</span>
                <div className="tex-box">{result.originalTex ? <Tex tex={result.originalTex} /> : <span className="muted">—</span>}</div>
              </div>
              <div className="display-row">
                <span className="row-tag">代入后计算式</span>
                <div className="tex-box">
                  {result.substitutedTex ? (
                    <>
                      <Tex tex={result.substitutedTex} />
                      {result.status !== "ok" && (
                        <span className="muted small">（未赋值或出错处保留符号）</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>
              <div className="display-row result-row">
                <span className="row-tag">结果</span>
                <div className="tex-box">
                  {result.status === "ok" || result.status === "unverified" ? (
                    <div>
                      {result.value !== undefined && (
                        <div className="result-line">
                          <Tex tex={`= ${fmt(result.value)}${result.resultUnit ? `~${toTexUnit(result.resultUnit)}` : ""}`} />
                        </div>
                      )}
                      {result.targetValue !== undefined && (
                        <div className="result-line converted">
                          <Tex tex={`= ${fmt(result.targetValue)}~${toTexUnit(result.targetUnit ?? "")}`} />
                          <span className="muted small">（按目标单位换算）</span>
                        </div>
                      )}
                      {result.status === "unverified" && <div className="warn-text">{result.summary}</div>}
                    </div>
                  ) : (
                    <span className="err-text">{result.summary}</span>
                  )}
                </div>
              </div>
              <div className="display-row unc-row">
                <span className="row-tag">测量不确定度</span>
                <div className="tex-box">
                  <UncertaintyPanel result={result} />
                </div>
              </div>
            </div>
          )}

          <SnapshotPanel snapshots={snapshots} onSaveManual={saveManual} onDelete={deleteSnapshot} />

          {result.issues.length > 0 && (
            <ul className="issue-list">
              {result.issues.map((iss, i) => (
                <li key={i} className={`issue ${iss.kind}`}>
                  <span className={`dot ${iss.kind}`} />
                  <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
                  <span className="issue-msg">{iss.message}</span>
                  <span className="issue-snippet">
                    定位：<Tex tex={iss.snippet || "·"} block={false} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return String(n);
  // 截断浮点尾零，科学计数法用 TeX 指数
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

// mathjs 单位文本（m / s^2）→ 简单 TeX（\mathrm{m}/\mathrm{s}^{2}）
function toTexUnit(unit: string): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0]}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}
