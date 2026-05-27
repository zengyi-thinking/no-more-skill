import type { AgentContext, BirthdayWishMemory } from "./types.js";

export function deriveWishType(wishText: string): "growth" | "focus" | "repair" | "explore" {
  if (/(修|补|止损|恢复|fix|repair|reduce|减少|纠正)/i.test(wishText)) return "repair";
  if (/(聚焦|收敛|稳定|focus|stabil|沉淀)/i.test(wishText)) return "focus";
  if (/(探索|尝试|试试|experiment|explore)/i.test(wishText)) return "explore";
  return "growth";
}

export function buildDefaultWishText(context: AgentContext, birthday?: BirthdayWishMemory | AgentContext["birthday_memory"]): string {
  if (birthday && "wish_text" in birthday) return birthday.wish_text;
  if (context.data_quality.sample_count === 0) {
    return "先积累至少 5 条真实行为样本，让 Agent 不再靠猜理解我。";
  }
  if (context.data_quality.warnings.some((warning) => warning.includes("陈旧") || warning.includes("stale"))) {
    return "用下一阶段的真实任务把 .nms 刷新到足够新鲜，让 Agent 的理解不过时。";
  }
  if (context.data_quality.confidence < 0.6) {
    const topWorkflow = context.relevant_workflows[0]?.name;
    return topWorkflow
      ? `把「${topWorkflow}」收敛成稳定的 Agent 工作流，减少任务切换。`
      : "把当前最常用的工作方式收敛成稳定流程，让 Agent 更懂我。";
  }
  const topDomain = context.relevant_domains[0]?.name ?? "当前主领域";
  const topWorkflow = context.relevant_workflows[0]?.name;
  return topWorkflow
    ? `把「${topWorkflow}」在 ${topDomain} 场景里继续固化成可复用的 Agent 协作方式。`
    : `围绕 ${topDomain} 持续沉淀可复用的 Agent 工作方式。`;
}

export function alignmentScore(wishText: string, context: AgentContext): { score: number; hits: string[] } {
  const hits: string[] = [];
  let domainHitCount = 0;
  let workflowHitCount = 0;
  let stepHitCount = 0;
  for (const domain of context.relevant_domains) {
    if (wishText.includes(domain.name)) {
      hits.push(`domain:${domain.name}`);
      domainHitCount += 1;
    }
  }
  for (const workflow of context.relevant_workflows) {
    if (wishText.includes(workflow.name)) {
      hits.push(`workflow:${workflow.name}`);
      workflowHitCount += 1;
    }
    for (const step of workflow.steps) {
      if (wishText.includes(step)) {
        hits.push(`step:${step}`);
        stepHitCount += 1;
      }
    }
  }
  if (context.birthday_memory) {
    if (wishText.includes(context.birthday_memory.north_star)) hits.push("north_star");
    for (const target of context.birthday_memory.next_year_targets) {
      if (wishText.includes(target)) hits.push(`target:${target}`);
    }
  }
  const uniqueHits = [...new Set(hits)];
  const hitScore = Math.min(35, uniqueHits.length * 8);
  const sampleScore = Math.min(25, context.data_quality.sample_count * 5);
  const confidenceScore = Math.round(context.data_quality.confidence * 25);
  const domainWorkflowBonus = domainHitCount > 0 || workflowHitCount > 0 ? 10 : 0;
  const stepOnlyPenalty = domainHitCount === 0 && workflowHitCount === 0 && stepHitCount > 0 ? 12 : 0;
  const lowConfidencePenalty = context.data_quality.confidence < 0.6 ? 18 : 0;
  const lowSamplePenalty = context.data_quality.sample_count < 5 ? 14 : 0;
  const stalePenalty = context.data_quality.warnings.some((warning) => warning.includes("陈旧") || warning.includes("stale")) ? 12 : 0;
  const score = Math.max(
    0,
    Math.min(
      100,
      sampleScore + hitScore + confidenceScore + domainWorkflowBonus - stepOnlyPenalty - lowConfidencePenalty - lowSamplePenalty - stalePenalty
    )
  );
  return { score, hits: uniqueHits };
}

export function groundednessLevel(score: number): "high" | "medium" | "low" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function candidateWishOptions(context: AgentContext): string[] {
  const candidates = [
    buildDefaultWishText(context, context.birthday_memory),
    context.relevant_workflows[0]
      ? `把「${context.relevant_workflows[0].name}」练成 Agent 和我之间最稳定的默认配合。`
      : undefined,
    context.data_quality.warnings.some((warning) => warning.includes("陈旧") || warning.includes("stale"))
      ? "先刷新最近真实任务样本，再让 Agent 做强判断。"
      : undefined
  ].filter((item): item is string => Boolean(item));
  return [...new Set(candidates)].slice(0, 3);
}

export function defaultWishExecutionContract(
  context: AgentContext,
  wishType: "growth" | "focus" | "repair" | "explore"
): {
  keep: string[];
  stop: string[];
  start: string[];
} {
  return {
    keep: context.birthday_memory?.retained_commitments.slice(0, 3)
      ?? ["保留真实 .nms 数据优先，不要靠想象定义自己。"],
    stop: [
      ...(context.birthday_memory?.risks_to_watch.slice(0, 2) ?? []),
      ...(context.data_quality.warnings.length > 0 ? [context.data_quality.warnings[0]] : [])
    ].filter(Boolean).slice(0, 3),
    start: [
      wishType === "focus"
        ? "把愿望拆成 30 天内可被行为验证的工作动作。"
        : "让接下来的真实任务尽量对齐这个愿望，而不是停留在口号层。",
      context.relevant_workflows[0]
        ? `优先复用 ${context.relevant_workflows[0].name}，观察它是否支持这个愿望。`
        : "先积累稳定 workflow，再谈长期升级。"
    ].slice(0, 3)
  };
}
