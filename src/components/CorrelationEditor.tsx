// 变量相关关系编辑器：为每对变量填写相关系数 ρ 与可选共同来源。
// 存储是“有向条目”数组：界面默认每个无序对写一条（视为对称 ρ_ab=ρ_ba）；
// 导入的文件若携带两个方向且数值不同（不对称），会原样保留并明确标红提示。
import type { CorrelationEntry } from "../engine/types";

interface Props {
  /** 公式中识别到的变量名 */
  names: string[];
  /** 哪些变量已经填写了有效的标准不确定度（仅这些对可验证相关关系） */
  declared: Set<string>;
  value: CorrelationEntry[];
  onChange: (next: CorrelationEntry[]) => void;
}

interface PairView {
  a: string;
  b: string;
  fwd?: CorrelationEntry;
  rev?: CorrelationEntry;
  /** 两个方向都填且数值不同 = 不对称（未验证） */
  asymmetric: boolean;
}

function buildViews(names: string[], declared: Set<string>, entries: CorrelationEntry[]): PairView[] {
  const dir = new Map<string, CorrelationEntry>();
  for (const e of entries) {
    if (e && typeof e.a === "string" && typeof e.b === "string") dir.set(`${e.a} ${e.b}`, e);
  }
  const seen = new Set<string>();
  const views: PairView[] = [];

  // 先按存储条目展示（保留外部导入的变量对/方向）
  for (const e of entries) {
    if (!e || typeof e.a !== "string" || typeof e.b !== "string" || e.a === e.b) continue;
    const key = e.a < e.b ? `${e.a} ${e.b}` : `${e.b} ${e.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [a, b] = key.split(" ");
    const fwd = dir.get(`${a} ${b}`);
    const rev = dir.get(`${b} ${a}`);
    views.push({
      a, b, fwd, rev,
      asymmetric: !!fwd && !!rev && fwd.rho.trim() !== "" && rev.rho.trim() !== ""
        && Number(fwd.rho) !== Number(rev.rho),
    });
  }
  // 再补齐所有声明了不确定度的变量对（默认未声明相关性 = 独立假设）。
  // 键统一按字典序规范化，避免与上面存储条目生成的“a m”键不一致而重复建行。
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const x = names[i];
      const y = names[j];
      const a = x < y ? x : y;
      const b = x < y ? y : x;
      const key = `${a} ${b}`;
      if (seen.has(key)) continue;
      if (!declared.has(x) || !declared.has(y)) continue;
      seen.add(key);
      views.push({ a, b, asymmetric: false });
    }
  }
  return views;
}

export default function CorrelationEditor({ names, declared, value, onChange }: Props) {
  if (names.length === 0) return null;

  const views = buildViews(names, declared, value);
  const declarablePairs = names.filter((n) => declared.has(n)).length >= 2;

  const setPair = (view: PairView, rho: string, source: string | undefined) => {
    // 移除该对两个方向上的旧条目，写入一个对称的规范条目
    const next = value.filter(
      (e) => !((e.a === view.a && e.b === view.b) || (e.a === view.b && e.b === view.a)),
    );
    if (rho.trim() !== "" || (source && source.trim() !== "")) {
      next.push({ a: view.a, b: view.b, rho, source });
    }
    onChange(next);
  };

  return (
    <div className="corr-editor">
      <div className="corr-title">
        变量相关关系（可选）
        <span className="muted small">
          留空 = 未声明相关性，按相互独立处理；同源测量请填 ρ（-1 ~ 1）并可注明共同来源
        </span>
      </div>
      {!declarablePairs && (
        <p className="muted small">
          至少为两个变量填写标准不确定度后，才能声明它们之间的相关系数。
        </p>
      )}
      {views.length === 0 && declarablePairs && (
        <p className="muted small">暂无可编辑的变量对。</p>
      )}
      {views.map((v) => {
        const entry = v.fwd ?? v.rev;
        const rho = v.asymmetric ? entry?.rho ?? "" : (v.fwd?.rho ?? v.rev?.rho ?? "");
        const source = v.fwd?.source ?? v.rev?.source ?? "";
        const bothDeclared = declared.has(v.a) && declared.has(v.b);
        return (
          <div className={`corr-row ${v.asymmetric ? "asymmetric" : ""} ${!bothDeclared ? "incomplete" : ""}`} key={`${v.a} ${v.b}`}>
            <span className="corr-pair">
              <i>{v.a}</i> ↔ <i>{v.b}</i>
            </span>
            <input
              className="corr-rho"
              inputMode="decimal"
              placeholder="ρ，如 0.8（-1~1）"
              title={v.asymmetric ? "两个方向的相关系数不一致（不对称），此相关关系将被标记为未验证" : "相关系数 ρ ∈ [-1, 1]"}
              value={rho}
              onChange={(e) => setPair(v, e.target.value, source || undefined)}
            />
            <input
              className="corr-source"
              placeholder="共同来源（可选），如：同一台标定台"
              title="共同来源说明只用于展示与溯源，不参与数值传播"
              value={source}
              onChange={(e) => setPair(v, rho, e.target.value)}
            />
            {v.asymmetric && (
              <span className="corr-warn" title={`ρ(${v.a},${v.b})=${v.fwd?.rho ?? ""}，ρ(${v.b},${v.a})=${v.rev?.rho ?? ""}`}>
                不对称！两个方向分别为 {v.fwd?.rho} / {v.rev?.rho}，不确定度将标记未验证
              </span>
            )}
            {!bothDeclared && (
              <span className="corr-warn">
                {!declared.has(v.a) ? v.a : v.b} 未声明标准不确定度，该相关关系无法验证
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
