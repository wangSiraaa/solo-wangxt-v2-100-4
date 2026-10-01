// 变量赋值区：自动列出公式中出现的变量，填写数值、标准不确定度与单位
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
      <div className="var-row var-head">
        <span>变量</span>
        <span>数值</span>
        <span>标准不确定度 u(x)<span className="muted">（同单位；留空 = 未声明）</span></span>
        <span>单位<span className="muted">（留空 = 纯数）</span></span>
        <span />
      </div>
      {rows.map((name) => {
        const def = value[name] ?? { value: "", unit: "" };
        const ghost = extra.includes(name);
        return (
          <div className={`var-row ${ghost ? "ghost" : ""}`} key={name}>
            <span className="var-name" title={ghost ? "当前公式未引用该变量" : undefined}>{name}</span>
            <input
              className="num-input"
              inputMode="decimal"
              placeholder="如 9.81"
              value={def.value}
              onChange={(e) => set(name, { value: e.target.value })}
            />
            <input
              className="unc-input"
              inputMode="decimal"
              placeholder="如 0.05（可留空）"
              title="标准不确定度 u(x)，与数值使用同一单位；留空表示该测量的不确定度未声明"
              value={def.uncertainty ?? ""}
              onChange={(e) => set(name, { uncertainty: e.target.value })}
            />
            <input
              className="unit-input"
              list="unit-suggestions"
              placeholder="如 m/s^2"
              value={def.unit}
              onChange={(e) => set(name, { unit: e.target.value })}
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
