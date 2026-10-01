// 变量赋值区：自动列出公式中出现的变量，填写数值、单位、标准不确定度与共同来源
import type { VariableDef } from "../engine/types";

interface Props {
  /** 公式中识别到的变量名 */
  names: string[];
  value: Record<string, VariableDef>;
  onChange: (next: Record<string, VariableDef>) => void;
}

export default function VariableTable({ names, value, onChange }: Props) {
  // 用户曾经定义、但当前公式里已不存在的变量也暂时保留（切换公式文本时不丢输入）
  const extra = Object.keys(value).filter((k) => !names.includes(k));
  const rows = [...names, ...extra];

  if (rows.length === 0) {
    return <p className="muted small">该公式中没有需要赋值的变量（只有数字和 π 等常量）。</p>;
  }

  const set = (name: string, patch: Partial<VariableDef>) => {
    const prev = value[name] ?? { value: "", unit: "" };
    onChange({ ...value, [name]: { ...prev, ...patch } });
  };

  return (
    <div className="var-table">
      <div className="var-row var-head var-head-unc">
        <span>变量</span>
        <span>数值</span>
        <span>单位</span>
        <span title="标准不确定度 u（与数值同单位，如 0.02）；留空 = 该量未声明不确定度">标准不确定度 u</span>
        <span title="共同测量来源（如同一台仪器、同一个基准）；同名来源的变量默认相关系数 ρ=1">共同来源</span>
        <span />
      </div>
      {rows.map((name) => {
        const def = value[name] ?? { value: "", unit: "" };
        const ghost = extra.includes(name);
        return (
          <div className={`var-row var-row-unc ${ghost ? "ghost" : ""}`} key={name}>
            <span className="var-name" title={ghost ? "当前公式未引用该变量" : undefined}>{name}</span>
            <input
              className="num-input"
              inputMode="decimal"
              placeholder="如 9.81"
              value={def.value}
              onChange={(e) => set(name, { value: e.target.value })}
            />
            <input
              className="unit-input"
              list="unit-suggestions"
              placeholder="如 m/s^2"
              value={def.unit}
              onChange={(e) => set(name, { unit: e.target.value })}
            />
            <input
              className="unc-input"
              inputMode="decimal"
              placeholder="留空=未声明"
              title="标准不确定度（1σ），单位同左"
              value={def.uncertainty ?? ""}
              onChange={(e) => set(name, { uncertainty: e.target.value })}
            />
            <input
              className="source-input"
              placeholder="如 仪器A（可留空）"
              title="同名来源的两个变量默认完全相关 ρ=1；留空表示独立来源"
              value={def.source ?? ""}
              onChange={(e) => set(name, { source: e.target.value })}
            />
            {ghost && (
              <button
                type="button"
                className="mini-btn"
                title="删除未引用的变量"
                onClick={() => {
                  const next = { ...value };
                  delete next[name];
                  onChange(next);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
