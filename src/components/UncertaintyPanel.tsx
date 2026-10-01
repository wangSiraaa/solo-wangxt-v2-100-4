// 测量不确定度结论展示：传播值、单位、相对不确定度、主要贡献项与相关交叉项
import type { UncertaintyResult } from "../engine/types";
import Tex from "./Tex";

/** 不确定度数值的展示：按 GUM 惯例给 1~2 位有效数字，避免伪精度 */
export function formatUncertainty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  // 1~2 位有效数字：首位为 1/2 时保留两位，其余保留一位
  const firstDigit = Math.floor(abs / Math.pow(10, Math.floor(Math.log10(abs))));
  const sig = firstDigit <= 2 ? 2 : 1;
  const exp = Math.floor(Math.log10(abs));
  const factor = Math.pow(10, sig - 1 - exp);
  const rounded = Math.round(n * factor) / factor;
  // 去掉浮点尾零
  return String(Number(rounded.toFixed(10)));
}

/** 百分比展示（份额/相对不确定度） */
function pct(share: number): string {
  if (!Number.isFinite(share)) return "—";
  const p = share * 100;
  const rounded = Math.round(p * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

// mathjs 单位文本（m / s^2）→ 简单 TeX
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

const STATUS_LABEL: Record<UncertaintyResult["status"], string> = {
  propagated: "不确定度已传播",
  undeclared: "不确定度未声明",
  none: "无测量输入量",
  unverified: "不确定度未验证",
};

interface Props {
  u: UncertaintyResult;
  /** 结果原始单位；与合成不确定度同单位 */
  resultUnit?: string;
  /** 目标单位（换算成功时展示目标单位下的不确定度） */
  targetUnit?: string;
}

export default function UncertaintyPanel({ u, resultUnit, targetUnit }: Props) {
  const cls =
    u.status === "propagated" ? "unc-ok"
    : u.status === "unverified" ? "unc-warn"
    : "unc-muted";

  return (
    <div className={`unc-panel ${cls}`}>
      <div className="unc-head">
        <span className={`unc-badge ${cls}`}>{STATUS_LABEL[u.status]}</span>
        {u.assumption && <span className="muted small">{u.assumption}</span>}
      </div>

      {u.status === "propagated" && u.standardUncertainty !== undefined && (
        <>
          <div className="unc-lines">
            <span className="unc-line">
              <Tex
                block={false}
                tex={`u_c(y) = \\pm ${formatUncertainty(u.standardUncertainty)}${resultUnit ? `~${toTexUnit(resultUnit)}` : ""}`}
              />
              {u.relativeUncertainty !== undefined && (
                <span className="muted small">
                  （相对不确定度 {pct(u.relativeUncertainty).replace("+", "")}）
                </span>
              )}
            </span>
            {u.targetStandardUncertainty !== undefined && targetUnit && (
              <span className="unc-line">
                <Tex
                  block={false}
                  tex={`u_c(y) = \\pm ${formatUncertainty(u.targetStandardUncertainty)}~${toTexUnit(targetUnit)}`}
                />
                <span className="muted small">（按目标单位换算）</span>
              </span>
            )}
          </div>

          {(u.contributors?.length ?? 0) > 0 && (
            <div className="unc-contrib">
              <span className="muted small">主要贡献项（独立方差份额）：</span>
              <ul>
                {u.contributors!.map((c) => (
                  <li key={c.variable}>
                    <i>{c.variable}</i>
                    <span className="bar-wrap">
                      <span
                        className="bar"
                        style={{ width: `${Math.min(100, Math.abs(c.share) * 100)}%` }}
                      />
                    </span>
                    <span className="muted small">{pct(c.share)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(u.correlationTerms?.length ?? 0) > 0 && (
            <div className="unc-corr">
              <span className="muted small">相关交叉项（2·sᵢsⱼuᵢuⱼρᵢⱼ）：</span>
              <ul>
                {u.correlationTerms!.map((t) => (
                  <li key={`${t.a}-${t.b}`}>
                    <i>{t.a}</i> ↔ <i>{t.b}</i>
                    {` ρ=${formatUncertainty(t.rho)}`}
                    {t.source && <span className="muted small">（来源：{t.source}）</span>}
                    <span className={`muted small ${t.share < 0 ? "neg" : ""}`}>
                      对方差贡献 {pct(t.share)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {u.status === "undeclared" && (
        <p className="muted small">
          该公式未声明任何变量的标准不确定度：普通计算结果照常有效，但不给出传播不确定度。
          在变量表的「标准不确定度」列填写 u(x) 后即可进行一阶传播分析。
        </p>
      )}

      {u.status === "none" && (
        <p className="muted small">{u.assumption ?? "常量表达式，无需传播测量不确定度。"}</p>
      )}

      {u.status === "unverified" && u.issues.length > 0 && (
        <ul className="unc-issues">
          {u.issues.map((msg, i) => (
            <li key={i}>⚠️ {msg}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
