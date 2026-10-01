// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
// 版本策略：
// - version 1：旧格式（无不确定度信息）—— 仍可导入，按“不确定度未声明”工作
// - version 2：增加 variables[].uncertainty/source、correlations、snapshots（计算快照）
import { latexToSource, LatexConvertError } from "../engine/latex";
import type {
  CalcSnapshot, Correlation, Formula, UncertaintyResult, VariableDef,
} from "../engine/types";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  formulas: ExportFormula[];
}

export interface ExportFormula {
  id: string;
  /** MathLive LaTeX：可编辑表达式本体 */
  latex: string;
  note: string;
  /** 由 LaTeX 转换出的中缀表达式，便于跨工具查看/备份 */
  source?: string;
  variables: Record<string, VariableDef>;
  targetUnit: string;
  /** 变量间显式相关系数 */
  correlations?: Correlation[];
  /** 历史计算快照（原式/代入式/普通结果 + 不确定度结论） */
  snapshots?: CalcSnapshot[];
  createdAt: number;
}

export function buildExport(formulas: Formula[]): ExportFile {
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables,
        targetUnit: f.targetUnit,
        correlations: f.correlations,
        snapshots: f.snapshots,
        createdAt: f.createdAt,
      };
    }),
  };
}

export function downloadJSON(data: ExportFile): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `量纲笔记_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  formulas: Formula[];
  errors: string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 清洗一份外部不确定度结论（快照内），任何字段不合规都丢弃该字段而非伪造 */
function sanitizeUncertainty(raw: unknown): UncertaintyResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (status !== "declared" && status !== "undeclared" && status !== "none") return undefined;
  const contributions: UncertaintyResult["contributions"] = [];
  if (Array.isArray(o.contributions)) {
    for (const c of o.contributions as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const x = c as Record<string, unknown>;
      if (x.kind !== "direct" && x.kind !== "cross") continue;
      if (typeof x.variable !== "string") continue;
      if (!isFiniteNumber(x.amount) || !isFiniteNumber(x.share) || typeof x.label !== "string") continue;
      contributions.push({ variable: x.variable, kind: x.kind, amount: x.amount, share: x.share, label: x.label });
    }
  }
  const notes: UncertaintyResult["notes"] = [];
  if (Array.isArray(o.notes)) {
    for (const n of o.notes as unknown[]) {
      if (typeof n === "string") {
        notes.push({ message: n, blocking: false });
      } else if (n && typeof n === "object" && typeof (n as Record<string, unknown>).message === "string") {
        const nn = n as Record<string, unknown>;
        notes.push({ message: String(nn.message), blocking: Boolean(nn.blocking) });
      }
    }
  }
  const out: UncertaintyResult = {
    status,
    contributions,
    assumption: typeof o.assumption === "string" ? o.assumption : "",
    notes,
  };
  if (isFiniteNumber(o.std)) out.std = o.std;
  if (typeof o.resultUnit === "string") out.resultUnit = o.resultUnit;
  if (isFiniteNumber(o.relative)) out.relative = o.relative;
  if (isFiniteNumber(o.targetStd)) out.targetStd = o.targetStd;
  if (typeof o.targetUnit === "string") out.targetUnit = o.targetUnit;
  if (isFiniteNumber(o.variance)) out.variance = o.variance;
  return out;
}

/** 清洗快照数组：保留可追溯信息，丢弃结构损坏的条目 */
function sanitizeSnapshots(raw: unknown, max = 20): CalcSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: CalcSnapshot[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.latex !== "string" || typeof o.source !== "string" || typeof o.substituted !== "string") continue;
    if (o.status !== "ok" && o.status !== "unverified" && o.status !== "error" && o.status !== "empty") continue;
    if (!o.variables || typeof o.variables !== "object") continue;
    const snap: CalcSnapshot = {
      at: isFiniteNumber(o.at) ? o.at : Date.now(),
      kind: o.kind === "manual" ? "manual" : "auto",
      latex: o.latex,
      source: o.source,
      substituted: o.substituted,
      // 早期内部版本可能没有高亮 TeX：退化为只展示 LaTeX/中缀，不伪造
      originalTex: typeof o.originalTex === "string" ? o.originalTex : "",
      substitutedTex: typeof o.substitutedTex === "string" ? o.substitutedTex : "",
      variables: o.variables as CalcSnapshot["variables"],
      targetUnit: typeof o.targetUnit === "string" ? o.targetUnit : "",
      status: o.status,
    };
    if (isFiniteNumber(o.value)) snap.value = o.value;
    if (typeof o.resultUnit === "string") snap.resultUnit = o.resultUnit;
    if (isFiniteNumber(o.targetValue)) snap.targetValue = o.targetValue;
    if (typeof o.targetUnitConverted === "string") snap.targetUnitConverted = o.targetUnitConverted;
    const unc = sanitizeUncertainty(o.uncertainty);
    if (unc) snap.uncertainty = unc;
    out.push(snap);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeCorrelations(raw: unknown): Correlation[] {
  if (!Array.isArray(raw)) return [];
  const out: Correlation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.a === "string" && typeof o.b === "string" && typeof o.rho === "string") {
      out.push({ a: o.a, b: o.b, rho: o.rho });
    }
  }
  return out;
}

/** 解析并校验导入文件；id 冲突自动重新生成，不覆盖现有笔记 */
export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"] };
  }

  const formulas: Formula[] = [];
  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    let id = typeof f.id === "string" ? f.id : newId();
    if (existingIds.has(id)) id = newId();
    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          // v1 记录只有 value/unit：缺省的不确定度/来源即“未声明”
          const def: VariableDef = { value: String(vv.value ?? ""), unit: String(vv.unit ?? "") };
          if (typeof vv.uncertainty === "string" && vv.uncertainty !== "") def.uncertainty = vv.uncertainty;
          if (typeof vv.source === "string" && vv.source !== "") def.source = vv.source;
          vars[k] = def;
        }
      }
    }
    const formula: Formula = {
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    };
    // v2 字段缺失（v1 旧笔记）时保持 undefined：引擎按未声明处理
    const corrs = sanitizeCorrelations((f as Partial<ExportFormula>).correlations);
    if (corrs.length) formula.correlations = corrs;
    const snaps = sanitizeSnapshots((f as Partial<ExportFormula>).snapshots);
    if (snaps.length) formula.snapshots = snaps;
    formulas.push(formula);
  });

  return { formulas, errors };
}
