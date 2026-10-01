// 计算快照：把当前分析结论（普通结果 + 不确定度 + 原式/代入式）固化为可持久化对象
import type {
  AnalysisResult, AnalysisSnapshot, Formula,
  UncertaintyContributor, UncertaintyCorrelationTerm, UncertaintyResult,
} from "../engine/types";
import { newId } from "./db";

export function buildSnapshot(formula: Formula, result: AnalysisResult): AnalysisSnapshot {
  return {
    id: newId(),
    savedAt: Date.now(),
    latex: formula.latex,
    source: result.source,
    substituted: result.substituted,
    originalTex: result.originalTex,
    substitutedTex: result.substitutedTex,
    status: result.status,
    summary: result.summary,
    value: result.value,
    resultUnit: result.resultUnit,
    targetValue: result.targetValue,
    targetUnit: result.targetUnit,
    uncertainty: result.uncertainty,
  };
}

const fin = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const finField = (o: Record<string, unknown>, k: string): number | undefined => fin(o[k]);

function sanitizeUncertainty(raw: unknown): UncertaintyResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const status = u.status;
  if (status !== "propagated" && status !== "undeclared" && status !== "none" && status !== "unverified") {
    return undefined;
  }
  let contributors: UncertaintyContributor[] | undefined;
  if (Array.isArray(u.contributors)) {
    contributors = [];
    for (const cRaw of u.contributors) {
      if (!cRaw || typeof cRaw !== "object") return undefined;
      const c = cRaw as Record<string, unknown>;
      if (typeof c.variable !== "string" || typeof c.variance !== "number" || typeof c.share !== "number") return undefined;
      contributors.push({ variable: c.variable, variance: c.variance, share: c.share });
    }
  }
  let correlationTerms: UncertaintyCorrelationTerm[] | undefined;
  if (Array.isArray(u.correlationTerms)) {
    correlationTerms = [];
    for (const tRaw of u.correlationTerms) {
      if (!tRaw || typeof tRaw !== "object") return undefined;
      const t = tRaw as Record<string, unknown>;
      if (typeof t.a !== "string" || typeof t.b !== "string" || typeof t.rho !== "number"
        || typeof t.variance !== "number" || typeof t.share !== "number") return undefined;
      correlationTerms.push({
        a: t.a, b: t.b, rho: t.rho, variance: t.variance, share: t.share, source: str(t.source),
      });
    }
  }
  return {
    status,
    standardUncertainty: finField(u, "standardUncertainty"),
    relativeUncertainty: finField(u, "relativeUncertainty"),
    targetStandardUncertainty: finField(u, "targetStandardUncertainty"),
    contributors,
    correlationTerms,
    assumption: str(u.assumption),
    issues: Array.isArray(u.issues) && u.issues.every((x) => typeof x === "string") ? (u.issues as string[]) : [],
  };
}

/** 持久化/导入后对快照做最小防御性校验；不合法则丢弃（不影响公式本体） */
export function sanitizeSnapshot(raw: unknown): AnalysisSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<AnalysisSnapshot>;
  if (typeof s.id !== "string" || typeof s.savedAt !== "number" || typeof s.latex !== "string") {
    return null;
  }
  const status = s.status;
  if (status !== "ok" && status !== "unverified" && status !== "error" && status !== "empty") return null;
  return {
    id: s.id,
    savedAt: s.savedAt,
    latex: s.latex,
    source: str(s.source),
    substituted: str(s.substituted),
    originalTex: str(s.originalTex),
    substitutedTex: str(s.substitutedTex),
    status,
    summary: str(s.summary),
    value: fin(s.value),
    resultUnit: str(s.resultUnit),
    targetValue: fin(s.targetValue),
    targetUnit: str(s.targetUnit),
    uncertainty: sanitizeUncertainty(s.uncertainty),
  };
}
