// 测量不确定度传播（GUM 一阶 / 线性化）：
//   u_c(y)^2 = Σ_i (∂y/∂x_i)^2 u_i^2 + 2 Σ_{i<j} (∂y/∂x_i)(∂y/∂x_j) u_i u_j ρ_ij
// 所有量先换算到 SI 基本值做前向自动微分（Forward AD），得到名义值与各输入的灵敏度；
// 再按显示单位/目标单位的线性换算系数把标准不确定度换算回显示单位。
//
// 设计原则：
// - 不改变 math.ts 既有的量纲与除零错误语义；本模块只在“普通求值已成功”时运行；
// - 相关关系不完整、不对称、超范围、引用不存在变量、相关矩阵非半正定 → 未验证（不输出数值）；
// - 任何变量缺少不确定度声明或表达式超出可传播范围 → 未验证或未声明，绝不把相关量当独立量、不产 NaN。

import {
  create, all,
  type MathNode, type MathJsInstance, type Unit,
} from "mathjs";
import type {
  CorrelationEntry, UncertaintyResult,
  UncertaintyContributor, UncertaintyCorrelationTerm, VariableDef,
} from "./types";

const math: MathJsInstance = create(all);

/** mathjs 节点结构窄化（与 math.ts 同构） */
type AnyNode = MathNode & {
  type: string;
  isSymbolNode: boolean;
  isOperatorNode: boolean;
  isConstantNode: boolean;
  isParenthesisNode: boolean;
  isFunctionNode: boolean;
  name: string;
  op: string;
  args: AnyNode[];
  content: AnyNode;
  value: number | string | boolean | null;
};

const asAny = (n: MathNode): AnyNode => n as AnyNode;

const BUILTIN_CONSTANTS = new Set(["pi", "e", "PI", "E"]);

/** 前向 AD 对：名义值（SI 基本值，纯数）+ 各输入变量方向上的灵敏度 */
interface Dual {
  v: number;
  /** 仅保留非零灵敏度，键为规范变量名 */
  d: Map<string, number>;
}

const dual = (v: number, d?: Map<string, number>): Dual => ({ v, d: d ?? new Map() });

/** 灵敏度向量线性组合：v*scale 或两个向量相加 */
function lin(scale: number, x: Dual, y?: Dual, yScale = 1): Dual {
  const d = new Map<string, number>();
  for (const [k, val] of x.d) {
    const t = scale * val;
    if (t !== 0) d.set(k, (d.get(k) ?? 0) + t);
  }
  if (y) {
    for (const [k, val] of y.d) {
      const t = yScale * val;
      if (t !== 0) d.set(k, (d.get(k) ?? 0) + t);
    }
  }
  return { v: scale * x.v + (y ? yScale * y.v : 0), d };
}

/** 变量在 SI 基本值空间中的解析结果 */
export interface ResolvedInput {
  /** 规范变量名（T1 与 T_1 视为同一变量） */
  name: string;
  /** 显示单位下填写的标称值 */
  displayValue: number;
  /** 显示单位下填写的标准不确定度文本解析值 */
  displayUncertainty: number;
  unitText: string;
  /** 带单位量；纯数为 null */
  quantity: Unit | null;
  /** SI 基本值空间的标称值 */
  baseValue: number;
  /** 显示单位 → SI 基本值的线性斜率（摄氏/华氏为偏移温标，用两点差取斜率） */
  baseScale: number;
  /** SI 基本值空间的标准不确定度 */
  baseUncertainty: number;
}

function isUnitValue(q: { value: number } | number): q is Unit {
  return typeof q !== "number";
}
void isUnitValue;

/** 解析单个变量的标称值/不确定度到 SI 基本值空间；非法文本返回错误信息 */
function resolveInput(
  name: string,
  def: VariableDef,
  scopeQuantity: Unit | number,
): { input?: ResolvedInput; error?: string } {
  const uText = (def.uncertainty ?? "").trim();
  const uNum = Number(uText);
  if (uText !== "" && (!Number.isFinite(uNum) || uNum < 0)) {
    return { error: `变量 ${name} 的标准不确定度“${uText}”不是有限且非负的数字，不确定度未验证` };
  }
  const num = Number(def.value);
  const unitText = def.unit.trim();
  let quantity: Unit | null = null;
  let baseValue: number;
  let baseScale: number;

  if (typeof scopeQuantity === "number") {
    baseValue = num;
    baseScale = 1;
  } else {
    quantity = scopeQuantity;
    baseValue = scopeQuantity.toSI().value;
    // 偏移温标（degC/degF）的 1 个显示单位 → SI 数值（两点差去掉偏移量 273.15 等）
    try {
      const one = math.unit(1, unitText as never).toSI().value;
      const zero = math.unit(0, unitText as never).toSI().value;
      baseScale = one - zero;
    } catch {
      // 复合显示单位退化：用自身 SI 换算（mathjs 复合单位无偏移，比例为 1）
      baseScale = 1;
    }
  }
  const displayUncertainty = uText === "" ? NaN : uNum;
  const baseUncertainty = uText === "" ? NaN : Math.abs(uNum * baseScale);
  return {
    input: {
      name, displayValue: num, displayUncertainty, unitText,
      quantity, baseValue, baseScale, baseUncertainty,
    },
  };
}

/** 前向 AD 求值：返回 null 表示该树无法进行不确定度传播（超出支持范围） */
function adEval(
  node: AnyNode,
  scope: Map<string, ResolvedInput>,
): Dual | null {
  if (node.isParenthesisNode) return adEval(node.content, scope);

  if (node.isConstantNode) {
    const v = node.value;
    if (typeof v === "number" && Number.isFinite(v)) return dual(v);
    return null;
  }

  if (node.isSymbolNode) {
    if (BUILTIN_CONSTANTS.has(node.name)) {
      return dual(node.name === "e" || node.name === "E" ? Math.E : Math.PI);
    }
    const input = scope.get(node.name);
    if (!input) return null;
    return dual(input.baseValue, new Map([[input.name, 1]]));
  }

  if (node.isOperatorNode) {
    if (node.args.length === 1) {
      const x = adEval(node.args[0], scope);
      if (!x) return null;
      if (node.op === "-") return lin(-1, x);
      if (node.op === "+") return x;
      return null;
    }

    const l = adEval(node.args[0], scope);
    const r = adEval(node.args[1], scope);
    if (!l || !r) return null;

    switch (node.op) {
      case "+":
        return lin(1, l, r, 1);
      case "-":
        // lin(xScale, x, y, yScale)：减法 = +l − r
        return lin(1, l, r, -1) as Dual;
      case "*":
        return { v: l.v * r.v, d: productD(l, r) };
      case "/": {
        if (r.v === 0) return null; // 除零在 math.ts 已报错，这里防御
        const d = new Map<string, number>();
        for (const [k, dl] of l.d) d.set(k, dl / r.v);
        for (const [k, dr] of r.d) d.set(k, (d.get(k) ?? 0) - (l.v * dr) / (r.v * r.v));
        return { v: l.v / r.v, d };
      }
      case "^": {
        // 仅支持确定（无不确定度）的数值指数；变量指数的幂传播需要额外模型，标记未验证
        if (r.d.size > 0) return null;
        const exp = r.v;
        if (!Number.isFinite(exp)) return null;
        if (l.v === 0) return null; // 0 的幂在 math.ts 已有明确错误语义
        const factor = exp * Math.pow(l.v, exp - 1);
        const d = new Map<string, number>();
        for (const [k, dl] of l.d) d.set(k, factor * dl);
        return { v: Math.pow(l.v, exp), d };
      }
      default:
        return null;
    }
  }

  return null;
}

function productD(l: Dual, r: Dual): Map<string, number> {
  const d = new Map<string, number>();
  for (const [k, dl] of l.d) d.set(k, dl * r.v);
  for (const [k, dr] of r.d) d.set(k, (d.get(k) ?? 0) + l.v * dr);
  return d;
}

/** 校验全部相关关系；通过后返回规范无序对 → {rho, source, bothDirs} 的映射 */
interface ValidatedPair {
  a: string;
  b: string;
  rho: number;
  source?: string;
}

function validateCorrelations(
  entries: CorrelationEntry[] | undefined,
  declared: Map<string, ResolvedInput>,
  allVars: Set<string>,
  issues: string[],
): { pairs: ValidatedPair[]; ok: boolean } {
  let ok = true;
  const fail = (msg: string) => { issues.push(msg); ok = false; };
  if (!entries || entries.length === 0) return { pairs: [], ok: true };

  // 方向键 → 条目；用于不对称检查
  const directed = new Map<string, CorrelationEntry & { idx: number }>();
  const norm = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);
  const pairData = new Map<string, { rhos: number[]; sources: string[]; a: string; b: string }>();

  entries.forEach((e, idx) => {
    if (!e || typeof e !== "object") { fail(`第 ${idx + 1} 条相关关系不是有效对象，相关关系未验证`); return; }
    const { a, b } = e;
    if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) {
      fail(`第 ${idx + 1} 条相关关系缺少变量名，相关关系未验证`);
      return;
    }
    if (!allVars.has(a) || !allVars.has(b)) {
      fail(`相关关系 ${a} ↔ ${b} 引用了公式中不存在的变量，相关关系未验证`);
      return;
    }
    const rhoText = (e.rho ?? "").trim();
    if (rhoText === "") {
      fail(`相关关系 ${a} 与 ${b} 的相关系数未填写完整，不能假定为独立或完全相关，不确定度未验证`);
      return;
    }
    const rho = Number(rhoText);
    if (!Number.isFinite(rho) || rho < -1 || rho > 1) {
      fail(`相关关系 ${a} 与 ${b} 的相关系数“${rhoText}”超出 [-1, 1] 范围，相关关系未验证`);
      return;
    }
    if (a === b && rho !== 1) {
      fail(`变量 ${a} 与自身的相关系数必须为 1，当前为 ${rhoText}，相关关系未验证`);
      return;
    }
    if (a === b) return; // 自相关 ρ=1 是恒真声明，不参与交叉项

    if (!declared.has(a) || !declared.has(b)) {
      const who = !declared.has(a) ? a : b;
      fail(`相关关系 ${a} 与 ${b} 中的变量 ${who} 未声明标准不确定度，无法验证该相关关系，不确定度未验证（不会把相关量当作独立量）`);
      return;
    }

    directed.set(`${a} ${b}`, { ...e, rho: rhoText, idx });
    const key = norm(a, b);
    const cur = pairData.get(key) ?? { rhos: [], sources: [], a, b };
    cur.rhos.push(rho);
    if (e.source && e.source.trim()) cur.sources.push(e.source.trim());
    pairData.set(key, cur);
  });

  if (!ok) return { pairs: [], ok: false };

  // 不对称检查：两个方向都填且数值不一致
  for (const [key, cur] of pairData) {
    const [pa, pb] = key.split(" ");
    const fwd = directed.get(`${pa} ${pb}`);
    const rev = directed.get(`${pb} ${pa}`);
    if (fwd && rev) {
      const rf = Number(fwd.rho);
      const rr = Number(rev.rho);
      if (Math.abs(rf - rr) > 1e-12) {
        fail(`变量 ${pa} 与 ${pb} 的相关关系不对称（ρ(${pa},${pb})=${fwd.rho}，ρ(${pb},${pa})=${rev.rho}），相关关系必须对称，不确定度未验证`);
        return { pairs: [], ok: false };
      }
    }
    if (cur.rhos.length === 2 && Math.abs(cur.rhos[0] - cur.rhos[1]) > 1e-12) {
      fail(`变量 ${pa} 与 ${pb} 的相关关系存在不一致的重复声明，不确定度未验证`);
      return { pairs: [], ok: false };
    }
  }

  const pairs: ValidatedPair[] = [];
  for (const [key, cur] of pairData) {
    void key;
    pairs.push({ a: cur.a, b: cur.b, rho: cur.rhos[0], source: cur.sources[0] });
  }

  // 相关矩阵（只取声明了正不确定度的变量）必须半正定；用 Cholesky 分解检查
  const names = [...declared.keys()];
  const n = names.length;
  const idxOf = new Map(names.map((nm, i) => [nm, i]));
  const R: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (const p of pairs) {
    const i = idxOf.get(p.a);
    const j = idxOf.get(p.b);
    if (i === undefined || j === undefined) continue;
    R[i][j] = p.rho;
    R[j][i] = p.rho;
  }
  if (!isPositiveSemidefinite(R)) {
    fail("声明的相关系数矩阵不是半正定矩阵（不存在与之对应的联合分布），相关关系未验证，不确定度未验证");
    return { pairs: [], ok: false };
  }

  return { pairs, ok };
}

/** Cholesky 半正定性检查（允许微小负特征值误差 1e-10） */
function isPositiveSemidefinite(A: number[][]): boolean {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const eps = 1e-10;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum < -eps) return false;
        L[i][j] = Math.sqrt(Math.max(0, sum));
      } else {
        L[i][j] = L[j][j] > eps ? sum / L[j][j] : 0;
      }
    }
  }
  return true;
}

// ---------- 入口参数 ----------

export interface UncertaintyInput {
  tree: AnyNode;
  /** 公式中出现的全部变量名（规范名） */
  variableNames: string[];
  varDefs: Record<string, VariableDef>;
  /** math.ts 求值阶段已解析成功的作用域：规范名 → 数或单位量 */
  scope: Map<string, number | Unit>;
  /** math.ts 中使用的 T1↔T_1 别名映射：解析名 → 规范名 */
  canonical: Map<string, string>;
  correlations?: CorrelationEntry[];
  /** 普通求值结果（原始单位）；仅在求值成功时调用本模块 */
  raw: number | Unit;
  /** 结果原始单位字符串（splitQuantity 产物，无量纲为 ""） */
  resultUnit: string;
  /** 目标单位换算是否成功及目标单位字符串 */
  targetConverted: boolean;
  targetUnit: string;
}

/** 显示单位 u_disp 与 SI 基本值之间的线性换算斜率；无量纲为 1 */
function displaySlope(quantity: Unit | null, unitText: string): number {
  if (!quantity) return 1;
  try {
    const one = math.unit(1, unitText as never).toSI().value;
    const zero = math.unit(0, unitText as never).toSI().value;
    const s = one - zero;
    if (Number.isFinite(s) && s !== 0) return s;
  } catch {
    /* fall through */
  }
  return 1;
}

export function analyzeUncertainty(input: UncertaintyInput): UncertaintyResult {
  const issues: string[] = [];
  const { tree, variableNames, varDefs, scope, canonical, correlations, raw } = input;

  if (variableNames.length === 0) {
    return { status: "none", issues: [], assumption: "常量表达式，不含测量输入量" };
  }

  // 1) 解析每个变量的标准不确定度
  const declared = new Map<string, ResolvedInput>();
  let anyDeclared = false;
  let anyInvalid = false;

  for (const name of variableNames) {
    const q = scope.get(name);
    if (q === undefined) {
      // 理论上不会发生：普通求值成功意味着作用域齐全；防御性标记未验证
      return {
        status: "unverified",
        issues: [`变量 ${name} 的标称值不可用，无法进行不确定度传播`],
      };
    }
    const def = varDefs[name] ?? varDefs[name.replace(/_(\d+)$/, "$1")];
    const resolved = resolveInput(name, def, q);
    if (resolved.error) {
      issues.push(resolved.error);
      anyInvalid = true;
      continue;
    }
    const ri = resolved.input!;
    if (!Number.isFinite(ri.displayUncertainty)) {
      // 未声明该变量的不确定度
      continue;
    }
    anyDeclared = true;
    declared.set(name, ri);
  }

  if (!anyDeclared && !anyInvalid) {
    // 旧笔记本 / 教师尚未填写：普通结果照常工作，仅明确“不确定度未声明”
    return {
      status: "undeclared",
      issues: [],
      assumption: "未声明任何变量的标准不确定度；普通计算结果不受影响",
    };
  }

  if (anyInvalid || declared.size !== variableNames.length) {
    const missing = variableNames.filter((n) => !declared.has(n));
    if (missing.length > 0 && !issues.some((m) => m.includes("不是有限且非负"))) {
      issues.push(`变量 ${missing.join("、")} 未声明标准不确定度：在所有输入量的不确定度补齐前，传播结果未验证（系统不会默认取零或假定独立）`);
    } else if (missing.length > 0) {
      issues.push(`另有变量 ${missing.join("、")} 未声明标准不确定度，传播结果未验证`);
    }
    return { status: "unverified", issues };
  }

  // 2) 校验相关关系
  const allVars = new Set(variableNames);
  const { pairs, ok } = validateCorrelations(correlations, declared, allVars, issues);
  if (!ok) return { status: "unverified", issues };

  // 3) 前向 AD：SI 基本值空间中的名义值与灵敏度
  const adScope = new Map<string, ResolvedInput>();
  for (const [name, ri] of declared) adScope.set(name, ri);
  // 作用域键可能是别名（解析名）：AD 中 SymbolNode 的名称要能命中
  for (const [parsed, canon] of canonical) {
    const ri = declared.get(canon);
    if (ri && parsed !== canon) adScope.set(parsed, ri);
  }

  const y = adEval(tree, adScope);
  if (!y || !Number.isFinite(y.v)) {
    return {
      status: "unverified",
      issues: ["该表达式包含无法按一阶模型传播不确定度的结构（如变量作指数、函数调用等），不确定度未验证"],
    };
  }

  // 4) 结果从 SI 基本值 → 显示单位的换算斜率
  const resultUnitText = input.resultUnit;
  const rawUnit: Unit | null = typeof raw === "number" ? null : raw;
  const toDisplay = rawUnit ? 1 / displaySlope(rawUnit, resultUnitText || rawUnit.formatUnits()) : 1;
  if (!Number.isFinite(toDisplay) || toDisplay === 0) {
    return { status: "unverified", issues: ["结果单位无法换算为线性比例，不确定度未验证"] };
  }

  // 5) 合成方差（SI 空间）：独立项 + 相关交叉项
  const names = [...declared.keys()];
  const sens = new Map<string, number>();
  for (const nm of names) sens.set(nm, y.d.get(nm) ?? 0);

  const independentVariances = new Map<string, number>();
  let independentTotal = 0;
  for (const nm of names) {
    const s = sens.get(nm)!;
    const u = declared.get(nm)!.baseUncertainty;
    const term = s * s * u * u;
    independentVariances.set(nm, term);
    independentTotal += term;
  }

  let crossTotal = 0;
  const correlationTerms: UncertaintyCorrelationTerm[] = [];
  for (const p of pairs) {
    const sa = sens.get(p.a)!;
    const sb = sens.get(p.b)!;
    const ua = declared.get(p.a)!.baseUncertainty;
    const ub = declared.get(p.b)!.baseUncertainty;
    const term = 2 * sa * sb * ua * ub * p.rho;
    crossTotal += term;
    correlationTerms.push({ a: p.a, b: p.b, rho: p.rho, variance: term, share: 0, source: p.source });
  }

  let baseVariance = independentTotal + crossTotal;
  // 浮点误差保护：真实数学非负，极小负值钳为 0；显著负值说明模型问题，判未验证
  if (baseVariance < 0) {
    if (baseVariance > -1e-8 * Math.max(independentTotal, 1)) baseVariance = 0;
    else {
      return { status: "unverified", issues: ["传播得到负方差，相关关系与表达式模型不一致，不确定度未验证"] };
    }
  }

  const baseU = Math.sqrt(baseVariance);
  const standardUncertainty = baseU * toDisplay;
  if (!Number.isFinite(standardUncertainty)) {
    return { status: "unverified", issues: ["合成不确定度不是有限数值，不确定度未验证"] };
  }

  // 名义显示值（与 math.ts 的 value 一致），用于相对不确定度
  const nominalDisplay = typeof raw === "number" ? raw : raw.value;
  const relativeUncertainty = nominalDisplay !== 0 ? standardUncertainty / Math.abs(nominalDisplay) : undefined;

  // 6) 贡献份额（显示单位换算为正比例，份额与单位无关）
  const contributors: UncertaintyContributor[] = names.map((nm) => ({
    variable: nm,
    variance: independentVariances.get(nm)! * toDisplay * toDisplay,
    share: baseVariance > 0 ? independentVariances.get(nm)! / baseVariance : 0,
  })).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  for (const t of correlationTerms) {
    t.share = baseVariance > 0 ? t.variance / baseVariance : 0;
    t.variance = t.variance * toDisplay * toDisplay;
  }
  correlationTerms.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  // 7) 目标单位下的不确定度（线性换算：u_target = |d(target)/d(SI)|·u_base）
  let targetStandardUncertainty: number | undefined;
  if (input.targetConverted && input.targetUnit.trim() !== "") {
    try {
      const t = input.targetUnit.trim();
      // 纯数结果只允许角度目标单位（math.ts 的语义）：SI 角度单位为 rad
      const siUnitText = rawUnit ? rawUnit.toSI().formatUnits() : "rad";
      // “1 个 SI 单位等于多少个目标单位”即为目标/SI 的线性斜率
      const targetPerSI = Math.abs(math.unit(1, siUnitText as never).to(t as never).value);
      targetStandardUncertainty = baseU * targetPerSI;
      if (!Number.isFinite(targetStandardUncertainty)) targetStandardUncertainty = undefined;
    } catch {
      targetStandardUncertainty = undefined;
    }
  }

  const assumption = pairs.length === 0
    ? "未声明相关关系，各输入量按相互独立处理（u_c²=Σ(∂f/∂x_i)²u_i²）"
    : `已声明 ${pairs.length} 对相关关系，按完整协方差一阶传播`;

  return {
    status: "propagated",
    issues: [],
    standardUncertainty,
    relativeUncertainty,
    targetStandardUncertainty,
    contributors,
    correlationTerms,
    assumption,
  };
}

/** 供 math.ts 把内部节点类型传给本模块（避免 AnyNode 类型跨文件重复导出） */
export function toUncertaintyNode(n: MathNode): AnyNode {
  return asAny(n);
}

/** 未使用保护：isUnitValue 仅用于类型文档，保留导出以免 tree-shaking 误判 */
void isUnitValue;
