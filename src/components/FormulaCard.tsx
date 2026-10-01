// 单条公式卡片：输入、变量赋值、原式/替换式/结果/不确定度四段展示、问题定位、计算快照
import { useMemo, useState } from "react";
import type { AnalysisSnapshot, CorrelationEntry, Formula, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import { buildSnapshot } from "../storage/snapshot";
import MathInput from "./MathInput";
import Tex from "./Tex";
import VariableTable from "./VariableTable";
import CorrelationEditor from "./CorrelationEditor";
import UncertaintyPanel from "./UncertaintyPanel";

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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const SNAPSHOT_STATUS_LABEL: Record<AnalysisSnapshot["status"], string> = {
  ok: "已验证", unverified: "未验证", error: "有错误", empty: "空公式",
};

function SnapshotView({ snap, onDelete }: { snap: AnalysisSnapshot; onDelete: () => void }) {
  return (
    <div className="snapshot">
      <div className="snapshot-head">
        <span className="snapshot-time">快照 · {formatTime(snap.savedAt)}</span>
        <span className={`badge ${STATUS_META[snap.status].cls}`}>{SNAPSHOT_STATUS_LABEL[snap.status]}</span>
        {snap.summary && <span className="muted small snapshot-summary">{snap.summary}</span>}
        <button type="button" className="mini-btn danger" onClick={onDelete}>删除快照</button>
      </div>
      <div className="display-area">
        <div className="display-row">
          <span className="row-tag">原式</span>
          <div className="tex-box">{snap.originalTex ? <Tex tex={snap.originalTex} /> : <span className="muted">—</span>}</div>
        </div>
        <div className="display-row">
          <span className="row-tag">代入后计算式</span>
          <div className="tex-box">
            {snap.substitutedTex ? <Tex tex={snap.substitutedTex} /> : <span className="muted">—</span>}
          </div>
        </div>
        <div className="display-row result-row">
          <span className="row-tag">结果</span>
          <div className="tex-box">
            {snap.value !== undefined ? (
              <div>
                <div className="result-line">
                  <Tex tex={`= ${fmt(snap.value)}${snap.resultUnit ? `~${toTexUnit(snap.resultUnit)}` : ""}`} />
                </div>
                {snap.targetValue !== undefined && (
                  <div className="result-line converted">
                    <Tex tex={`= ${fmt(snap.targetValue)}~${toTexUnit(snap.targetUnit ?? "")}`} />
                    <span className="muted small">（按目标单位换算）</span>
                  </div>
                )}
              </div>
            ) : (
              <span className={snap.status === "error" ? "err-text" : "muted"}>{snap.summary}</span>
            )}
          </div>
        </div>
        {snap.uncertainty && (
          <div className="display-row">
            <span className="row-tag">测量不确定度</span>
            <div className="tex-box" style={{ display: "block" }}>
              <UncertaintyPanel
                u={snap.uncertainty}
                resultUnit={snap.resultUnit}
                targetUnit={snap.targetUnit}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FormulaCard({ formula, index, onChange, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const correlations = formula.correlations;
  const result = useMemo(
    () => analyzeFormula(formula.latex, formula.variables, formula.targetUnit, correlations),
    // correlations 内容以 onChange 替换数组方式更新，引用变化即重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [formula.latex, formula.variables, formula.targetUnit, formula.correlations],
  );
  const meta = STATUS_META[result.status];

  const setVars = (variables: Record<string, VariableDef>) => onChange({ variables });
  const setCorrelations = (next: CorrelationEntry[]) => onChange({ correlations: next });

  // 哪些变量已填写了有效的标准不确定度（用于相关关系编辑器的禁用提示）
  const declaredSet = useMemo(() => {
    const set = new Set<string>();
    for (const name of result.variables) {
      const t = (formula.variables[name]?.uncertainty ?? "").trim();
      if (t !== "" && Number.isFinite(Number(t)) && Number(t) >= 0) set.add(name);
    }
    return set;
  }, [result.variables, formula.variables]);

  const canSnapshot = result.source !== undefined && result.status !== "empty";
  const saveSnapshot = () => {
    const snap = buildSnapshot(formula, result);
    onChange({ snapshots: [snap, ...(formula.snapshots ?? [])] });
  };
  const removeSnapshot = (id: string) => {
    onChange({ snapshots: (formula.snapshots ?? []).filter((s) => s.id !== id) });
  };

  return (
    <section className={`card status-${meta.cls}`}>
      <header className="card-head">
        <button type="button" className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>公式 {index + 1}</strong>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        {result.uncertainty && (
          <span
            className={`unc-mini unc-${result.uncertainty.status === "propagated" ? "ok" : result.uncertainty.status === "unverified" ? "warn" : "muted"}`}
            title="测量不确定度分析状态"
          >
            u：{result.uncertainty.status === "propagated" ? "已传播"
              : result.uncertainty.status === "unverified" ? "未验证"
              : result.uncertainty.status === "undeclared" ? "未声明" : "无输入量"}
          </span>
        )}
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
              placeholder="例如  v \\cdot t + \\frac{1}{2} a t^2"
            />
          </label>

          <div className="grid-2">
            <div>
              <div className="field-label">变量赋值</div>
              <VariableTable names={result.variables} value={formula.variables} onChange={setVars} />
              {result.variables.length >= 2 && (
                <div style={{ marginTop: 10 }}>
                  <CorrelationEditor
                    names={result.variables}
                    declared={declaredSet}
                    value={correlations ?? []}
                    onChange={setCorrelations}
                  />
                </div>
              )}
            </div>
            <div>
              <label className="field-label">
                结果目标单位（可选；用于常用单位换算，如 K、degF、deg、rad、km/h）
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
                  placeholder="例如：自由落体位移"
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
              {result.uncertainty && (
                <div className="display-row">
                  <span className="row-tag">测量不确定度</span>
                  <div className="tex-box" style={{ display: "block" }}>
                    <UncertaintyPanel
                      u={result.uncertainty}
                      resultUnit={result.resultUnit}
                      targetUnit={result.targetUnit}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="snapshot-actions">
            <button
              type="button"
              className="mini-btn"
              disabled={!canSnapshot}
              onClick={saveSnapshot}
              title="把当前的原式、代入式、结果与不确定度结论保存为不可变快照（随笔记持久化与导出）"
            >
              📌 保存计算快照
            </button>
            <span className="muted small">
              快照固化当前结论，之后再修改变量也不会改变它；用于记录某次测量的完整分析。
            </span>
          </div>

          {(formula.snapshots ?? []).length > 0 && (
            <div className="snapshot-list">
              {(formula.snapshots ?? []).map((s) => (
                <SnapshotView key={s.id} snap={s} onDelete={() => removeSnapshot(s.id)} />
              ))}
            </div>
          )}

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
