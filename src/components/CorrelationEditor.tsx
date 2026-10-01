// 相关系数矩阵编辑：显式声明变量对之间的相关系数 ρ ∈ [−1, 1]。
// 编辑任一格自动镜像到对称格，保证对称性；留空 = 该对按独立量处理。
// 引擎仍按“有向成对”校验导入数据（不完整/不对称/越界 → 未验证，只阻塞本公式）。
import type { Correlation } from "../engine/types";

interface Props {
  names: string[];
  value: Correlation[];
  onChange: (next: Correlation[]) => void;
}

export default function CorrelationEditor({ names, value, onChange }: Props) {
  if (names.length < 2) {
    return <p className="muted small">该公式少于两个变量，没有需要声明的相关系数（同源变量可在“共同来源”列填写）。</p>;
  }

  const cell = (a: string, b: string): string => {
    const hit = value.find((c) => c.a === a && c.b === b);
    return hit?.rho ?? "";
  };

  const setCell = (a: string, b: string, raw: string) => {
    // 去掉其它方向上可能残留的旧值后，同时写入两个对称方向
    const next = value.filter((c) =>
      !((c.a === a && c.b === b) || (c.a === b && c.b === a)));
    if (raw.trim() !== "") {
      next.push({ a, b, rho: raw });
      next.push({ a: b, b: a, rho: raw });
    }
    onChange(next);
  };

  const n = names.length;

  return (
    <div className="corr-box">
      <table className="corr-table">
        <thead>
          <tr>
            <th>ρ</th>
            {names.map((nm) => <th key={nm}>{nm}</th>)}
          </tr>
        </thead>
        <tbody>
          {names.map((row, i) => (
            <tr key={row}>
              <th>{row}</th>
              {names.map((col, j) => {
                if (i === j) {
                  return <td key={col} className="corr-diag" title="变量与自身的相关系数恒为 1">1</td>;
                }
                const onlyLower = i > j;
                return (
                  <td key={col}>
                    <input
                      className="corr-input"
                      inputMode="decimal"
                      value={cell(names[i], names[j])}
                      readOnly={onlyLower}
                      placeholder="0"
                      title={onlyLower
                        ? `ρ(${row},${col})，与 ρ(${col},${row}) 对称，请在上三角填写`
                        : `ρ(${row},${col})，范围 −1 ～ 1；留空 = 独立`}
                      onChange={(e) => setCell(names[i], names[j], e.target.value)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        仅在需要时填写：留空的变量对按<strong>独立</strong>处理；同名“共同来源”的变量默认 ρ=1（可被显式系数覆盖）。
        相关系数必须在 −1～1 之间。共 {n} 个变量、{n * (n - 1) / 2} 个变量对。
      </p>
    </div>
  );
}
