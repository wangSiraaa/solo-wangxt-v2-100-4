// 不确定度结论面板：合成标准不确定度、单位、相对不确定度、主要贡献项与相关假设
import type { AnalysisResult, UncertaintyResult } from "../engine/types";
import Tex from "./Tex";

interface Props {
  result: AnalysisResult;
  /** 供 TeX 渲染的数值/单位格式化 */
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(4).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  // 不确定度通常只有 1–2 位有效数字是有意义的，这里最多保留 4 位小数，避免伪精度
  return String(Number(n.toFixed(6)));
}

function toTexUnit(unit: string | undefined): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0].replace(/[()]/g, "")}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}

const STATUS_TEXT = {
  declared: "已声明测量不确定度",
  undeclared: "不确定度未声明",
  none: "无变量，无需传播",
} as const;

export default function UncertaintyPanel({ result }: Props) {
  const u: UncertaintyResult | undefined = result.uncertainty;
  if (!u) return null;

  const blocking = u.notes.filter((n) => n.blocking);
  const infos = u.notes.filter((n) => !n.blocking);
  const blocked = u.status === "declared" && u.std === undefined;

  return (
    <div className={`unc-panel ${blocked ? "unc-blocked" : ""} ${u.status === "undeclared" ? "unc-undeclared" : ""}`}>
      <div className="unc-head">
        <span className={`unc-badge unc-${u.status}`}>{STATUS_TEXT[u.status]}</span>
        {u.status === "declared" && (
          blocked ? <span className="warn-text small">合成标准不确定度：未验证（见下方原因）</span>
            : <span className="muted small">一阶（GUM）传播，按标准不确定度 u（1σ）给出</span>
        )}
      </div>

      {u.status === "declared" && !blocked && u.std !== undefined && (
        <div className="unc-values">
          <div className="unc-line">
            <span className="unc-label">合成标准不确定度</span>
            <Tex
              block={false}
              tex={`u_c = ${fmt(u.std)}~${toTexUnit(u.resultUnit)}`}
            />
            {u.relative !== undefined && (
              <span className="muted small">（相对 {fmt(u.relative * 100)}%）</span>
            )}
          </div>
          {u.targetStd !== undefined && (
            <div className="unc-line">
              <span className="unc-label">目标单位下</span>
              <Tex block={false} tex={`u_c = ${fmt(u.targetStd)}~${toTexUnit(u.targetUnit)}`} />
            </div>
          )}
        </div>
      )}

      {u.status === "declared" && u.contributions.length > 0 && (
        <div className="unc-contrib">
          <div className="unc-subhead">主要贡献项（占合成方差比例）</div>
          <ul className="contrib-list">
            {u.contributions.map((c, i) => (
              <li key={i} className={c.kind === "cross" ? "contrib-cross" : "contrib-direct"}>
                <span className="contrib-label">{c.label}</span>
                <span className="contrib-amount">
                  <Tex block={false} tex={`${fmt(Math.abs(c.amount))}~${toTexUnit(u.resultUnit)}`} />
                </span>
                <span className={`contrib-share ${c.share < 0 ? "neg" : ""}`}>
                  {c.kind === "cross" && c.share < 0 ? "−" : ""}{fmt(Math.abs(c.share))}%
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            交叉项带符号：正相关且灵敏系数同号时增大总不确定度；交叉项为负时抵消直接项，
            各项占比之和可大于或小于 100%。
          </p>
        </div>
      )}

      {u.status === "declared" && (
        <p className="unc-assumption small">
          <strong>相关假设：</strong>{u.assumption}
        </p>
      )}

      {u.status === "undeclared" && (
        <p className="muted small">
          旧记录或未填写不确定度：普通计算结果照常工作，系统不会在缺信息时按独立量估算不确定度。
          在变量表“标准不确定度”列填写 u（如 0.02）即可启用传播。
        </p>
      )}

      {infos.length > 0 && (
        <ul className="unc-notes">
          {infos.map((n, i) => <li key={i} className="muted small">{n.message}</li>)}
        </ul>
      )}
      {blocking.length > 0 && (
        <ul className="unc-notes unc-blocking">
          {blocking.map((n, i) => <li key={i} className="warn-text small">⛔ {n.message}</li>)}
        </ul>
      )}
    </div>
  );
}
