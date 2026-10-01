// 量纲检查引擎的公共类型定义

/**
 * 变量：数值文本 + 单位文本（单位留空表示纯数）
 * - uncertainty：标准不确定度 u（与 value 同一输入单位，留空 = 该量无不确定度声明）
 * - source：共同来源名；同名来源的变量默认视为同源（默认相关系数 1），
 *   可被 correlations 中显式给出的系数覆盖。
 */
export interface VariableDef {
  value: string;
  unit: string;
  /** 标准不确定度文本（与数值同单位；留空表示未声明不确定度） */
  uncertainty?: string;
  /** 共同测量来源名（如同一台仪器/同一个基准）；空 = 独立来源 */
  source?: string;
}

/**
 * 两个变量之间的显式相关系数声明（按变量名字典序保存，a < b）。
 * 不完整（仅给出半边）、不对称或越界（|rho|>1）都在分析阶段判为未验证，
 * 绝不静默按独立量处理。
 */
export interface Correlation {
  a: string;
  b: string;
  rho: string;
}

/**
 * 计算快照：某次成功分析的持久化结论。
 * kind = auto 为最近一次可验证计算，手动快照 kind = manual。
 * 原式/代入式直接保存高亮后的 TeX，刷新或导入后无需重算即可展示。
 */
export interface CalcSnapshot {
  at: number;
  kind: "auto" | "manual";
  /** 生成快照时的原式 LaTeX */
  latex: string;
  /** 生成快照时的中缀表达式 */
  source: string;
  /** 代入后的计算式（mathjs 中缀，便于备份查看） */
  substituted: string;
  /** 原式的高亮 TeX（持久化展示用） */
  originalTex: string;
  /** 代入式的高亮 TeX（持久化展示用） */
  substitutedTex: string;
  /** 生成快照时的变量赋值（含不确定度/来源） */
  variables: Record<string, VariableDef>;
  targetUnit: string;
  status: AnalysisStatus;
  value?: number;
  resultUnit?: string;
  targetValue?: number;
  targetUnitConverted?: string;
  /** 不确定度结论（原样保存，便于刷新/导入后复查） */
  uncertainty?: UncertaintyResult;
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
  /** 变量间显式相关系数（可选；未声明时同源变量默认 ρ=1，其余视为独立） */
  correlations?: Correlation[];
  /** 历史计算快照（[0] 为最近一次自动快照，manual 快照按时间追加其后） */
  snapshots?: CalcSnapshot[];
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
 * 不确定度声明状态：
 * - declared：至少一个变量声明了标准不确定度（或给出相关关系）
 * - undeclared：旧笔记/未填写 —— 普通结果照常，仅明确“不确定度未声明”
 * - none：公式无变量（常量表达式），不存在传播问题
 */
export type UncertaintyStatus = "declared" | "undeclared" | "none";

/** 一个主要贡献项（单变量直接项或两变量相关交叉项） */
export interface UncertaintyContribution {
  /** 单变量 "x"；相关交叉项 "x,y" */
  variable: string;
  kind: "direct" | "cross";
  /** 该项对结果标准不确定度的贡献（结果单位；交叉项可正可负） */
  amount: number;
  /** 占总方差的百分比（交叉项可为负；直接项 ≥ 0） */
  share: number;
  /** 说明文字，如 “x 直接项” 或 “x 与 y 相关（ρ=0.8）交叉项” */
  label: string;
}

/** 不确定度结论中的一条说明：blocking=true 会把公式标为未验证 */
export interface UncertaintyNote {
  message: string;
  blocking: boolean;
}

/** 不确定度传播结果（一阶 GUM 传播，SI 基准值上求偏导） */
export interface UncertaintyResult {
  status: UncertaintyStatus;
  /** 原始结果单位下的合成标准不确定度（方差平方根，已判非负） */
  std?: number;
  resultUnit?: string;
  /** 相对合成标准不确定度 std/|value|（value=0 或带偏移温标读数时不给出） */
  relative?: number;
  /** 目标单位下的合成标准不确定度（做了目标单位换算时） */
  targetStd?: number;
  targetUnit?: string;
  /** 方差为负（相关矩阵非正定）时给出原始方差，结果标记未验证且不给 std */
  variance?: number;
  /** 主要贡献项（按 |share| 降序） */
  contributions: UncertaintyContribution[];
  /** 相关假设说明，如 “m、a 视为独立量” */
  assumption: string;
  /**
   * 阻塞/提示信息（摄氏不支持运算、非正定、声明问题等），为空表示可验证。
   * blocking=true 的条目会把整条公式标为未验证；
   * blocking=false 仅为说明（如某变量未声明 u，按精确量处理）。
   */
  notes: UncertaintyNote[];
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
  /** 测量不确定度传播结论（旧笔记为 undeclared，普通结果不受影响） */
  uncertainty?: UncertaintyResult;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
}
