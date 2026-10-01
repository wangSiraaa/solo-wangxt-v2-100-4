// 量纲检查引擎的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
  /** 标准不确定度 u(x) 的文本（与数值同单位）；缺省/空串 = 未声明，绝不默认为 0 */
  uncertainty?: string;
}

/**
 * 两个变量之间的相关关系（有向条目）。
 * 只填写一个方向时视为对称（ρ_ba = ρ_ab）；两个方向都填且数值不同即“不对称”，
 * 该公式的不确定度会被标记为未验证。
 */
export interface CorrelationEntry {
  a: string;
  b: string;
  /** 相关系数文本（-1 ~ 1）；留空表示该条目未填写完整 */
  rho: string;
  /** 可选：共同来源说明（如“同一台测力传感器”），仅用于展示与溯源 */
  source?: string;
}

/** 一条公式 */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  /** 备注 */
  note: string;
  variables: Record<string, VariableDef>;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  /** 变量两两之间的相关关系声明（可缺省 = 全部按独立处理） */
  correlations?: CorrelationEntry[];
  /** 用户手动保存的计算快照（结论持久化，不再随后续编辑变化） */
  snapshots?: AnalysisSnapshot[];
  createdAt: number;
}

/** 问题严重级别：error = 明确错误；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

export type AnalysisStatus = "ok" | "unverified" | "error" | "empty";

/**
 * 测量不确定度结论状态：
 * - propagated：所有参与变量的标准不确定度均已声明，一阶传播完成
 * - undeclared：变量未声明任何不确定度（旧笔记本/未填写），按原结果工作
 * - none：公式不含变量（常量公式），无传播可言
 * - unverified：相关关系非法、声明不完整、表达式无法传播等，禁止给出数值结论
 */
export type UncertaintyStatus = "propagated" | "undeclared" | "none" | "unverified";

/** 单个变量对合成方差的独立贡献项（方差份额） */
export interface UncertaintyContributor {
  variable: string;
  /** 该项方差（结果单位的平方量纲，仅用于相对比较与份额） */
  variance: number;
  /** 占总方差的份额（可负：与相关项合并展示时可能为负） */
  share: number;
}

/** 一对相关变量带来的交叉项 2·s_a·s_b·u_a·u_b·ρ_ab */
export interface UncertaintyCorrelationTerm {
  a: string;
  b: string;
  rho: number;
  variance: number;
  /** 占总方差的份额（带符号） */
  share: number;
  source?: string;
}

export interface UncertaintyResult {
  status: UncertaintyStatus;
  /** 合成标准不确定度（结果原始单位）；仅 propagated 时有数值 */
  standardUncertainty?: number;
  /** 相对标准不确定度 u/|y|（无量纲比值） */
  relativeUncertainty?: number;
  /** 目标单位下的合成标准不确定度（换算成功时） */
  targetStandardUncertainty?: number;
  /** 各变量的独立贡献，按方差绝对值降序 */
  contributors?: UncertaintyContributor[];
  /** 相关交叉项，按方差绝对值降序 */
  correlationTerms?: UncertaintyCorrelationTerm[];
  /** 传播所采用的假设说明（如“未声明相关性，按相互独立处理”） */
  assumption?: string;
  /** 未验证原因 / 提示信息（全部为可读文本，不产出 NaN） */
  issues: string[];
}

/** 计算快照：保存时刻的完整结论，与原式、代入式一起持久化 */
export interface AnalysisSnapshot {
  id: string;
  savedAt: number;
  latex: string;
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（保存时可能带高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX */
  substitutedTex?: string;
  status: AnalysisStatus;
  summary?: string;
  value?: number;
  resultUnit?: string;
  targetValue?: number;
  targetUnit?: string;
  /** 保存时刻的不确定度结论（旧快照可能没有，即“未声明”） */
  uncertainty?: UncertaintyResult;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量） */
  variables: string[];
  /** 所有问题（错误 + 未验证警告） */
  issues: Issue[];
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（带问题节点高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX（带问题节点高亮） */
  substitutedTex?: string;
  /** 结果数值（原始单位） */
  value?: number;
  /** 结果单位字符串，无量纲时为 "" */
  resultUnit?: string;
  /** 换算后的结果数值 */
  targetValue?: number;
  /** 换算后的结果单位 */
  targetUnit?: string;
  /** 测量不确定度分析结论（求值被错误/未验证阻塞时缺省） */
  uncertainty?: UncertaintyResult;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
}
