// 计算快照：把“原式 → 代入式 → 普通结果 + 不确定度结论”作为历史记录持久化展示。
// auto 快照：最近一次可验证的分析（每个输入状态至多一条，自动覆盖旧 auto）；
// manual 快照：教师手动留存的课堂时刻，永不自动覆盖。
// 原式/代入式 TeX 与不确定度结论均原样保存在记录里，刷新或 JSON 往返后不重算也可复查。
import type { CalcSnapshot } from "../engine/types";
import Tex from "./Tex";

interface Props {
  snapshots: CalcSnapshot[];
  onSaveManual: () => void;
  onDelete: (at: number, kind: "manual" | "auto") => void;
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

/** mathjs 单位文本 → 简单 TeX */
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

const STATUS_LABEL: Record<CalcSnapshot["status"], string> = {
  ok: "已验证",
  unverified: "未验证",
  error: "有错误",
  empty: "空公式",
};

function timeText(at: number): string {
  const d = new Date(at);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function SnapshotItem({ s, onDelete }: { s: CalcSnapshot; onDelete: () => void }) {
  const u = s.uncertainty;
  return (
    <li className={`snap-item snap-${s.kind}`}>
      <div className="snap-meta">
        <span className={`snap-kind ${s.kind}`}>{s.kind === "auto" ? "最近计算（自动）" : "手动留存"}</span>
        <span className="snap-time">{timeText(s.at)}</span>
        <span className={`snap-status status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
        <button type="button" className="mini-btn" onClick={onDelete} title="删除该快照">×</button>
      </div>
      <div className="snap-rows">
        <div className="snap-row"><span className="row-tag">原式</span><Tex tex={s.originalTex || s.latex || "·"} /></div>
        <div className="snap-row"><span className="row-tag">代入式</span><Tex tex={s.substitutedTex || "·"} /></div>
        <div className="snap-row">
          <span className="row-tag">结果</span>
          {s.value !== undefined ? (
            <Tex tex={`= ${fmt(s.value)}${s.resultUnit ? `~${toTexUnit(s.resultUnit)}` : ""}`} />
          ) : <span className="muted small">无可用数值结果</span>}
          {s.targetValue !== undefined && (
            <span className="snap-converted">
              <Tex tex={`= ${fmt(s.targetValue)}~${toTexUnit(s.targetUnitConverted)}`} />
              <span className="muted small">（目标单位）</span>
            </span>
          )}
        </div>
        {u && u.status === "declared" && u.std !== undefined && (
          <div className="snap-row snap-unc">
            <span className="row-tag">不确定度</span>
            <Tex block={false} tex={`u_c = ${fmt(u.std)}~${toTexUnit(u.resultUnit)}`} />
            {u.targetStd !== undefined && (
              <span className="snap-converted">
                <Tex block={false} tex={`u_c = ${fmt(u.targetStd)}~${toTexUnit(u.targetUnit)}`} />
                <span className="muted small">（目标单位）</span>
              </span>
            )}
          </div>
        )}
        {u && u.status === "declared" && u.std === undefined && (
          <div className="snap-row snap-unc">
            <span className="row-tag">不确定度</span>
            <span className="warn-text small">未验证（相关关系或传播结构无法验证，未输出数值；普通结果见上）</span>
          </div>
        )}
        {u && u.status === "undeclared" && (
          <div className="snap-row snap-unc">
            <span className="row-tag">不确定度</span>
            <span className="muted small">未声明（旧记录或未填写，普通结果照常）</span>
          </div>
        )}
      </div>
    </li>
  );
}

export default function SnapshotPanel({ snapshots, onSaveManual, onDelete }: Props) {
  return (
    <div className="snap-panel">
      <div className="snap-head">
        <span className="field-label">计算快照（持久化：刷新、导出/导入后保留）</span>
        <button type="button" className="mini-btn" onClick={onSaveManual} title="把当前原式、代入式、结果与不确定度结论留存一份">
          ＋ 留存当前结论
        </button>
      </div>
      {snapshots.length === 0 ? (
        <p className="muted small">尚无快照：公式得到可验证结果后会自动记录最近一次计算；也可手动留存课堂时刻。</p>
      ) : (
        <ol className="snap-list">
          {snapshots.map((s) => (
            <SnapshotItem
              key={`${s.kind}-${s.at}`}
              s={s}
              onDelete={() => onDelete(s.at, s.kind)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
