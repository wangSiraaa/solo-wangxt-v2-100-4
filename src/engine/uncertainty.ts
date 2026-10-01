// 测量不确定度传播（一阶 GUM / 误差传播）
// 在 SI 基准值上对 AST 做伴随求值，得到结果对每个输入量的偏导（灵敏系数），
// 再按 u_y^2 = Σ g_i²u_i² + 2Σ g_i g_j ρ_ij u_i u_j 合成。
// 相关关系不完整/不对称/越界、相关矩阵非正定、摄氏不支持运算等一律“未验证”，
// 绝不输出 NaN、伪精度，也绝不把相关量静默当作独立量。

import {
  create, all,
  type MathNode, type MathJsInstance, type Unit,
} from "mathjs";
import type {
  Correlation, UncertaintyContribution, UncertaintyResult, VariableDef,
} from "./types";

const math: MathJsInstance = create(all);

/** 数值（无单位）或 mathjs 单位量 */
type Quantity = number | Unit;

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

/** 求一点处：SI 值 + 对各输入 SI 值的偏导；无法传播时返回 null（调用方按未验证处理） */
interface GradPoint {
  value: number;
  grad: Map<string, number>;
}

const EPS = 1e-12;

/** 单位量在 SI 基准上的数值 */
function siValue(v: Quantity): number {
  return typeof v === "number" ? v : v.toSI().value;
}

/**
 * 输入量的标准不确定度文本折合为 SI 增量。
 * u 与读数同单位；带偏移温标（degC/degF）的读数增量不能整体 toSI，
 * 必须用微分尺度（1 °C 的间隔 = 1 K，而非 274.15 K）。
 * 直接用读数的 Unit 对象构造无值单位，避免解析 “(kg m) / s^2” 等组合单位文本。
 */
function incrementToSI(rawText: string, base: Unit | undefined): number {
  const n = Number(rawText);
  if (!Number.isFinite(n) || n < 0) return NaN;
  if (!base) return n; // 纯数
  const ubase = math.unit(base.formatUnits());
  const toSi = (x: number) => math.unit(x, ubase as never).toSI().value;
  return n * (toSi(1) - toSi(0));
}

/** 结果单位上的“增量 1”折合多少 SI（把 SI 不确定度换算回显示单位时用） */
function resultIncrementSIFactor(base: Unit | string): number {
  const ubase = typeof base === "string" ? math.unit(base) : math.unit(base.formatUnits());
  const toSi = (x: number) => math.unit(x, ubase as never).toSI().value;
  return toSi(1) - toSi(0);
}

function gradEval(
  node: MathNode,
  scope: Map<string, Quantity>,
): GradPoint | null {
  const n = node as AnyNode;

  if (n.isParenthesisNode) return gradEval(n.content, scope);

  if (n.isConstantNode) {
    if (typeof n.value === "number" && Number.isFinite(n.value)) {
      return { value: n.value, grad: new Map() };
    }
    return null;
  }

  if (n.isSymbolNode) {
    if (scope.has(n.name)) return { value: siValue(scope.get(n.name)!), grad: new Map([[n.name, 1]]) };
    if (n.name === "pi") return { value: Math.PI, grad: new Map() };
    if (n.name === "e") return { value: Math.E, grad: new Map() };
    return null;
  }

  if (n.isOperatorNode) {
    if (n.args.length === 1) {
      const x = gradEval(n.args[0], scope);
      if (!x) return null;
      if (n.op === "-") return { value: -x.value, grad: scaleGrad(x.grad, -1) };
      return x; // 一元 +
    }
    const l = gradEval(n.args[0], scope);
    const r = gradEval(n.args[1], scope);
    if (!l || !r) return null;
    const g = new Map<string, number>();

    if (n.op === "+" || n.op === "-") {
      const s = n.op === "+" ? 1 : -1;
      for (const [k, v] of l.grad) g.set(k, v);
      for (const [k, v] of r.grad) g.set(k, (g.get(k) ?? 0) + s * v);
      return { value: n.op === "+" ? l.value + r.value : l.value - r.value, grad: g };
    }

    if (n.op === "*") {
      for (const [k, v] of l.grad) g.set(k, v * r.value);
      for (const [k, v] of r.grad) g.set(k, (g.get(k) ?? 0) + l.value * v);
      const val = l.value * r.value;
      if (!Number.isFinite(val)) return null;
      return { value: val, grad: g };
    }

    if (n.op === "/") {
      if (r.value === 0) return null; // 除零已在普通求值中报错，这里只防御
      for (const [k, v] of l.grad) g.set(k, v / r.value);
      for (const [k, v] of r.grad) g.set(k, (g.get(k) ?? 0) - (l.value * v) / (r.value * r.value));
      const val = l.value / r.value;
      if (!Number.isFinite(val)) return null;
      return { value: val, grad: g };
    }

    if (n.op === "^") {
      const rHasUnc = [...r.grad.values()].some((v) => v !== 0);
      if (!rHasUnc) {
        // 常数指数幂规则：d(l^r)/dx = r·l^(r-1)·l'
        const exp = r.value;
        let factor: number;
        try {
          factor = exp * Math.pow(l.value, exp - 1);
        } catch {
          return null;
        }
        if (!Number.isFinite(factor)) return null;
        for (const [k, v] of l.grad) g.set(k, factor * v);
        const val = Math.pow(l.value, exp);
        if (!Number.isFinite(val)) return null;
        return { value: val, grad: g };
      }
      // 指数本身带不确定度：l^r 要求 l>0（ln l），否则无法验证
      if (l.value <= 0) return null;
      const lnL = Math.log(l.value);
      const val = Math.pow(l.value, r.value);
      if (!Number.isFinite(val)) return null;
      for (const [k, v] of l.grad) g.set(k, val * (r.value / l.value) * v);
      for (const [k, v] of r.grad) g.set(k, (g.get(k) ?? 0) + val * lnL * v);
      return { value: val, grad: g };
    }

    return null; // 不支持的运算
  }

  return null; // 函数调用等：findUnsupported 已在普通分析阶段标记
}

function scaleGrad(m: Map<string, number>, s: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) out.set(k, v * s);
  return out;
}

interface PairAssumption { a: string; b: string; rho: number; via: string }

interface MatrixBuild {
  /** 校验通过后的相关矩阵；不完整/不对称/越界时为 null */
  rho: number[][] | null;
  /** 阻塞性说明（全部会使不确定度结论未验证） */
  errors: string[];
  /** 参与传播的非零相关对（用于说明假设） */
  pairs: PairAssumption[];
}

/**
 * 由显式声明（有向条目）+ 共同来源构建相关矩阵。
 * 显式条目按“有向”校验：必须成对且对称；缺一向 = 不完整，两向不一致 = 不对称。
 */
function buildMatrix(
  names: string[],
  varDefs: Record<string, VariableDef>,
  correlations: Correlation[],
): MatrixBuild {
  const errors: string[] = [];
  const idx = new Map(names.map((n, i) => [n, i]));
  const rho: (number | null)[][] = names.map((_, i) =>
    names.map((_, j) => (i === j ? 1 : null)));

  const defOf = (name: string): VariableDef | undefined =>
    varDefs[name] ?? varDefs[name.replace(/_(\d+)$/, "$1")];

  // 1) 共同来源默认 ρ = 1
  const pairs: PairAssumption[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const sa = (defOf(names[i])?.source ?? "").trim();
      const sb = (defOf(names[j])?.source ?? "").trim();
      if (sa && sa === sb) {
        rho[i][j] = 1;
        rho[j][i] = 1;
        pairs.push({ a: names[i], b: names[j], rho: 1, via: `共同来源“${sa}”` });
      }
    }
  }

  // 2) 显式有向条目
  const dir = new Map<string, { rho: number; raw: string }>();
  let blocked = false;
  const key = (a: string, b: string) => `${a}→${b}`;

  for (const c of correlations) {
    const label = `相关声明 ${c.a} ↔ ${c.b}`;
    if (!idx.has(c.a) || !idx.has(c.b)) {
      errors.push(`${label} 引用了公式中不存在的变量，无法应用，相关关系未验证`);
      blocked = true;
      continue;
    }
    if (c.a === c.b) {
      errors.push(`${label}：变量与自身的相关系数必须为 1，不能另行声明，相关关系未验证`);
      blocked = true;
      continue;
    }
    const t = (c.rho ?? "").trim();
    if (t === "") continue; // 空白单元格不构成声明
    const v = Number(t);
    if (!Number.isFinite(v)) {
      errors.push(`${label} 的相关系数“${t}”不是数字，相关关系未验证`);
      blocked = true;
      continue;
    }
    if (v > 1 + EPS || v < -1 - EPS) {
      errors.push(`${label} 的相关系数 ${v} 超出 [−1, 1] 范围，相关关系未验证`);
      blocked = true;
      continue;
    }
    const prev = dir.get(key(c.a, c.b));
    if (prev && Math.abs(prev.rho - v) > EPS) {
      errors.push(`${label} 被重复声明为 ${prev.raw} 与 ${t}（互相矛盾），相关关系未验证`);
      blocked = true;
      continue;
    }
    dir.set(key(c.a, c.b), { rho: v, raw: t });
  }

  // 3) 成对性与对称性校验
  const unorderedPairs = new Set<string>();
  for (const k of dir.keys()) {
    const [a, b] = k.split("→");
    unorderedPairs.add([a, b].sort().join("↔"));
  }
  for (const p of unorderedPairs) {
    const [a, b] = p.split("↔");
    const ab = dir.get(key(a, b));
    const ba = dir.get(key(b, a));
    if (!ab || !ba) {
      errors.push(`相关关系不完整：只声明了 ${ab ? `${a}→${b}` : `${b}→${a}`}，缺少反方向声明（相关系数必须成对且对称），相关关系未验证`);
      blocked = true;
      continue;
    }
    if (Math.abs(ab.rho - ba.rho) > EPS) {
      errors.push(`相关关系不对称：ρ(${a},${b})=${ab.raw} 而 ρ(${b},${a})=${ba.raw}（二者必须相等），相关关系未验证`);
      blocked = true;
      continue;
    }
    const v = Math.max(-1, Math.min(1, ab.rho));
    const ia = idx.get(a)!;
    const ib = idx.get(b)!;
    rho[ia][ib] = v;
    rho[ib][ia] = v;
    const sa = (defOf(a)?.source ?? "").trim();
    const sb = (defOf(b)?.source ?? "").trim();
    pairs.unshift({ a, b, rho: v, via: sa && sa === sb ? "显式声明（覆盖共同来源默认 ρ=1）" : "显式声明" });
  }

  // 去重假设列表（同对保留显式在前）
  const seenPair = new Set<string>();
  const uniqPairs = pairs.filter((p) => {
    const k = [p.a, p.b].sort().join("↔");
    if (seenPair.has(k)) return false;
    seenPair.add(k);
    return true;
  });

  if (blocked) return { rho: null, errors, pairs: uniqPairs };

  return {
    rho: rho.map((row) => row.map((v) => v ?? 0)),
    errors,
    pairs: uniqPairs.filter((p) => Math.abs(p.rho) > EPS),
  };
}

export interface PropagateArgs {
  tree: MathNode;
  variables: string[];
  scope: Map<string, Quantity>;
  varDefs: Record<string, VariableDef>;
  correlations: Correlation[];
  /** 普通求值结果（数值或带单位量） */
  result: Quantity;
  /** 结果单位文本（无量纲为 ""） */
  resultUnit: string;
  /** 目标单位文本（留空不换算不确定度） */
  targetUnitText: string;
}

function hasSharedSource(names: string[], varDefs: Record<string, VariableDef>): boolean {
  const counts = new Map<string, number>();
  for (const n of names) {
    const s = (varDefs[n] ?? varDefs[n.replace(/_(\d+)$/, "$1")])?.source?.trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.values()].some((c) => c >= 2);
}

function hasUncertaintyText(names: string[], varDefs: Record<string, VariableDef>): boolean {
  return names.some((x) => ((varDefs[x] ?? varDefs[x.replace(/_(\d+)$/, "$1")])?.uncertainty ?? "").trim() !== "");
}

function sharedPairs(names: string[], varDefs: Record<string, VariableDef>): PairAssumption[] {
  const out: PairAssumption[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const sa = (varDefs[names[i]] ?? varDefs[names[i].replace(/_(\d+)$/, "$1")])?.source?.trim();
      const sb = (varDefs[names[j]] ?? varDefs[names[j].replace(/_(\d+)$/, "$1")])?.source?.trim();
      if (sa && sa === sb) out.push({ a: names[i], b: names[j], rho: 1, via: `共同来源“${sa}”` });
    }
  }
  return out;
}

function assumptionText(pairs: PairAssumption[]): string {
  if (pairs.length === 0) return "未声明相关系数：各输入量按独立量处理";
  const desc = pairs.map((p) => `${p.a} 与 ${p.b}（${p.via}，ρ=${roundRho(p.rho)}）`).join("；");
  return `相关：${desc}；其余变量对视为独立量`;
}

function roundRho(r: number): string {
  return String(Number(r.toFixed(6)));
}

/**
 * 不确定度数值规整：保留至多 6 位有效数字，消除浮点尾差（伪精度），不改动普通计算值。
 */
function roundU(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const factor = 10 ** (6 - 1 - mag);
  return Math.round(n * factor) / factor;
}

function finiteText(n: number): string {
  return Number.isFinite(n) ? n.toExponential(3) : "非有限值";
}

/** 不确定度传播主入口：任何无法验证的情况都通过 blocking 说明明确标出，不返回 NaN */
export function propagateUncertainty(args: PropagateArgs): UncertaintyResult {
  const { tree, variables, scope, varDefs, correlations, result, resultUnit, targetUnitText } = args;
  const names = variables.filter((x) => scope.has(x));

  const declared =
    hasUncertaintyText(variables, varDefs) ||
    correlations.some((c) => (c.rho ?? "").trim() !== "") ||
    hasSharedSource(variables, varDefs);

  if (names.length === 0) {
    return { status: "none", contributions: [], assumption: "公式中没有变量（常量表达式），无不确定度需要传播", notes: [] };
  }
  if (!declared) {
    return {
      status: "undeclared",
      contributions: [],
      assumption: "未声明任何测量不确定度",
      notes: [{
        message: "未声明测量不确定度：普通计算结果照常给出，未做不确定度传播（不能在缺信息时按独立量估算）",
        blocking: false,
      }],
    };
  }

  const notes: UncertaintyResult["notes"] = [];
  const defOf = (name: string): VariableDef | undefined =>
    varDefs[name] ?? varDefs[name.replace(/_(\d+)$/, "$1")];

  const fail = (extra: string[]): UncertaintyResult => ({
    status: "declared",
    resultUnit,
    contributions: [],
    assumption: assumptionText(sharedPairs(names, varDefs)),
    notes: [...notes, ...extra.map((message) => ({ message, blocking: true }))],
  });

  // 1) 各输入量的标准不确定度（SI，微分尺度）
  const uSI = new Map<string, number>();
  for (const name of names) {
    const def = defOf(name);
    const q = scope.get(name)!;
    const raw = (def?.uncertainty ?? "").trim();
    if (raw === "") {
      uSI.set(name, 0);
      notes.push({ message: `变量 ${name} 未声明标准不确定度，按精确量（u=0）参与传播`, blocking: false });
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return fail([`变量 ${name} 的标准不确定度“${raw}”不是非负有限数字，无法传播，结果未验证`]);
    }
    let inc: number;
    try {
      inc = incrementToSI(raw, typeof q === "number" ? undefined : q);
    } catch {
      inc = NaN;
    }
    if (!Number.isFinite(inc)) {
      return fail([`变量 ${name} 的不确定度（${def?.unit || "纯数"}）无法完成增量换算，结果未验证`]);
    }
    uSI.set(name, inc);
  }

  // 2) 相关矩阵（不完整/不对称/越界 → 未验证，绝不退化为独立假设）
  const built = buildMatrix(names, varDefs, correlations);
  notes.push(...built.errors.map((message) => ({ message, blocking: true })));
  if (!built.rho) {
    return {
      status: "declared",
      resultUnit,
      contributions: [],
      assumption: assumptionText(built.pairs),
      notes,
    };
  }
  const rho = built.rho;

  // 3) SI 上的灵敏系数
  let point: GradPoint | null = null;
  try {
    point = gradEval(tree, scope);
  } catch {
    point = null;
  }
  if (!point || !Number.isFinite(point.value)) {
    return fail(["表达式含无法传播不确定度的结构（如负底数 + 带不确定度的指数、超出支持范围的运算），结果未验证"]);
  }
  const g = new Map<string, number>();
  for (const name of names) g.set(name, point.grad.get(name) ?? 0);

  // 4) 合成方差
  let variance = 0;
  for (let i = 0; i < names.length; i++) {
    const gi = g.get(names[i])!;
    const ui = uSI.get(names[i])!;
    variance += gi * gi * ui * ui;
    for (let j = i + 1; j < names.length; j++) {
      const gj = g.get(names[j])!;
      const uj = uSI.get(names[j])!;
      variance += 2 * gi * gj * rho[i][j] * ui * uj;
    }
  }
  if (!Number.isFinite(variance) || variance < -EPS) {
    return {
      status: "declared",
      variance: Number.isFinite(variance) ? variance : undefined,
      resultUnit,
      contributions: [],
      assumption: assumptionText(built.pairs),
      notes: [...notes, {
        message: `按所声明的相关系数合成得到负方差（${finiteText(variance)}）：相关矩阵不是合法的协方差结构（非正定），结果未验证，请勿把这些相关量当独立量处理`,
        blocking: true,
      }],
    };
  }
  if (variance < 0) variance = 0; // 消除 -0 级数值噪声

  // 5) 换算回结果单位（微分尺度，温标偏移不影响间隔）
  let scaleBack: number;
  try {
    const f = typeof result === "number" ? 1 : resultIncrementSIFactor(result);
    scaleBack = Number.isFinite(f) && f !== 0 ? 1 / f : NaN;
  } catch {
    scaleBack = NaN;
  }
  if (!Number.isFinite(scaleBack)) {
    return fail([`结果单位“${resultUnit}”无法完成不确定度的增量换算，结果未验证`]);
  }
  const stdSI = Math.sqrt(variance);
  const std = roundU(stdSI * scaleBack);
  if (!Number.isFinite(std)) {
    return fail(["合成标准不确定度不是有限数值，结果未验证"]);
  }

  // 6) 目标单位下的不确定度（温标间隔同样按微分尺度）
  let targetStd: number | undefined;
  const tt = targetUnitText.trim();
  if (tt) {
    try {
      if (typeof result === "number") {
        // 纯数结果只允许换算到角度：1 rad 间隔在目标角度单位中的大小
        const hi = math.unit(1, "rad").to(tt).value;
        const lo = math.unit(0, "rad").to(tt).value;
        const factor = hi - lo;
        if (!Number.isFinite(factor) || factor === 0) throw new Error("bad");
        targetStd = roundU(std * factor);
      } else {
        const f = resultIncrementSIFactor(tt);
        if (!Number.isFinite(f) || f === 0) throw new Error("bad");
        targetStd = roundU(stdSI / f);
      }
    } catch {
      targetStd = undefined; // 目标单位换算失败时普通分析已有警告，这里不重复阻塞
    }
  }

  // 7) 主要贡献项（方差口径，交叉项保留符号）
  const contributions: UncertaintyContribution[] = [];
  for (let i = 0; i < names.length; i++) {
    const gi = g.get(names[i])!;
    const ui = uSI.get(names[i])!;
    const termVar = gi * gi * ui * ui;
    if (termVar <= EPS) continue;
    contributions.push({
      variable: names[i],
      kind: "direct",
      amount: roundU(Math.sqrt(termVar) * scaleBack),
      share: roundU((termVar / variance) * 100),
      label: `${names[i]} 的直接不确定度项`,
    });
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = rho[i][j];
      if (Math.abs(r) <= EPS) continue;
      const termVar = 2 * g.get(names[i])! * g.get(names[j])! * r * uSI.get(names[i])! * uSI.get(names[j])!;
      if (Math.abs(termVar) <= EPS) continue;
      contributions.push({
        variable: `${names[i]},${names[j]}`,
        kind: "cross",
        amount: roundU(Math.sign(termVar) * Math.sqrt(Math.abs(termVar)) * scaleBack),
        share: roundU((termVar / variance) * 100),
        label: `${names[i]} 与 ${names[j]} 的相关交叉项（ρ=${roundRho(r)}）`,
      });
    }
  }
  contributions.sort((a, b) => Math.abs(b.share) - Math.abs(a.share));

  // 8) 相对合成不确定度：std 与结果读数（结果单位）之比。
  //    带偏移温标读数（degC/degF 直读）的“相对值”无物理意义，不给出。
  let rel: number | undefined;
  if (typeof result === "number") {
    if (result !== 0) rel = roundU(std / Math.abs(result));
  } else if (!result.units.some((f) => f.unit.offset !== 0)) {
    const reading = result.value; // splitQuantity 给出的读数（结果单位）
    if (reading !== 0) rel = roundU(std / Math.abs(reading));
  }

  return {
    status: "declared",
    std,
    resultUnit,
    relative: rel,
    targetStd,
    targetUnit: tt || undefined,
    contributions: contributions.slice(0, 6),
    assumption: assumptionText(built.pairs),
    notes,
  };
}
