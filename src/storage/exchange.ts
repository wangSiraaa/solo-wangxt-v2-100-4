// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
// v1：首版字段；v2：新增变量标准不确定度、相关关系、计算快照。
// 导入同时兼容 v1 旧笔记本：缺失的不确定度字段按“未声明”处理，旧记录照常可算。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type {
  AnalysisSnapshot, CorrelationEntry, Formula, VariableDef,
} from "../engine/types";
import { newId } from "./db";
import { sanitizeSnapshot } from "./snapshot";

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
  /** 变量两两相关关系（v2；旧文件无此字段 = 未声明相关性，按独立处理） */
  correlations?: CorrelationEntry[];
  /** 保存的计算快照（v2；旧文件无此字段） */
  snapshots?: AnalysisSnapshot[];
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
        // 即使为空数组也显式写出，保证“来源关系不丢失”
        correlations: f.correlations ?? [],
        snapshots: f.snapshots ?? [],
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

/** 解析相关关系条目数组；保留用户输入文本（非法值由引擎在分析时标记未验证） */
function parseCorrelations(raw: unknown, label: string, errors: string[]): CorrelationEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) { errors.push(`${label}：correlations 不是数组，已忽略相关关系`); return undefined; }
  const out: CorrelationEntry[] = [];
  raw.forEach((e, i) => {
    if (!e || typeof e !== "object") { errors.push(`${label}：第 ${i + 1} 条相关关系不是对象，已忽略`); return; }
    const r = e as Partial<CorrelationEntry>;
    out.push({
      a: String(r.a ?? ""),
      b: String(r.b ?? ""),
      rho: typeof r.rho === "string" ? r.rho : String(r.rho ?? ""),
      source: typeof r.source === "string" ? r.source : undefined,
    });
  });
  return out;
}

/** 解析快照数组；非法快照被丢弃并报错，但不阻塞该公式导入 */
function parseSnapshots(raw: unknown, label: string, errors: string[]): AnalysisSnapshot[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) { errors.push(`${label}：snapshots 不是数组，已忽略快照`); return undefined; }
  const out: AnalysisSnapshot[] = [];
  raw.forEach((s, i) => {
    const clean = sanitizeSnapshot(s);
    if (clean) out.push(clean);
    else errors.push(`${label}：第 ${i + 1} 个计算快照无法识别，已丢弃（不影响公式本体）`);
  });
  return out;
}

/**
 * 解析并校验导入文件；id 冲突自动重新生成，不覆盖现有笔记。
 * 兼容 v1（无 version 或 version=1）与 v2 文件。
 */
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
          // v1 文件没有 uncertainty 字段 → undefined，界面显示为空（未声明），旧结果照算
          vars[k] = {
            value: String(vv.value ?? ""),
            unit: String(vv.unit ?? ""),
            uncertainty: typeof vv.uncertainty === "string" ? vv.uncertainty : undefined,
          };
        }
      }
    }
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      correlations: parseCorrelations((f as Partial<ExportFormula>).correlations, label, errors),
      snapshots: parseSnapshots((f as Partial<ExportFormula>).snapshots, label, errors),
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    });
  });

  return { formulas, errors };
}
