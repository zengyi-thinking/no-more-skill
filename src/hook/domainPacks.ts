import type { DomainPack, SessionRecord } from "../types.js";

export const DEFAULT_DOMAIN_PACKS: DomainPack[] = [
  {
    domain: "coding",
    skills: {
      "分析类": ["PRD分析", "代码分析"],
      "生成类": ["UI生成", "代码生成"],
      "优化类": ["Prompt优化", "性能优化"],
      "调试类": ["Debug"],
      "设计类": ["架构设计"]
    },
    workflow_templates: [["PRD分析", "代码分析", "代码生成", "Debug"]],
    style_signals: [{ name: "结构化推进", patterns: ["先", "再", "最后", "测试"] }]
  },
  {
    domain: "writing",
    skills: {
      "分析类": ["选题分析", "读者分析"],
      "生成类": ["大纲生成", "草稿生成"],
      "优化类": ["标题优化", "结构优化"],
      "发布类": ["平台适配", "发布复盘"]
    },
    workflow_templates: [["选题分析", "大纲生成", "草稿生成", "结构优化", "发布复盘"]],
    style_signals: [{ name: "结构化表达", patterns: ["先", "再", "最后", "分步骤"] }]
  },
  {
    domain: "research",
    skills: {
      "分析类": ["问题定义", "资料收集"],
      "验证类": ["交叉验证", "来源评估"],
      "生成类": ["结论归纳", "研究报告"]
    },
    workflow_templates: [["问题定义", "资料收集", "交叉验证", "结论归纳"]],
    style_signals: [{ name: "证据优先", patterns: ["来源", "证据", "验证", "引用"] }]
  },
  {
    domain: "learning",
    skills: {
      "规划类": ["学习目标", "资料选择"],
      "执行类": ["练习", "反馈"],
      "复盘类": ["学习复盘"]
    },
    workflow_templates: [["学习目标", "资料选择", "练习", "反馈", "学习复盘"]],
    style_signals: [{ name: "迭代学习", patterns: ["练习", "反馈", "复盘"] }]
  },
  {
    domain: "product",
    skills: {
      "分析类": ["需求分析", "用户分析"],
      "设计类": ["原型设计", "文案设计"],
      "发布类": ["演示", "推广"]
    },
    workflow_templates: [["需求分析", "用户分析", "原型设计", "演示", "推广"]],
    style_signals: [{ name: "产品交付", patterns: ["用户", "场景", "推广", "演示"] }]
  },
  {
    domain: "content",
    skills: {
      "创作类": ["口播", "分镜"],
      "视觉类": ["页面", "图片"],
      "发布类": ["发布", "复盘"]
    },
    workflow_templates: [["口播", "分镜", "页面", "图片", "发布"]],
    style_signals: [{ name: "内容生产", patterns: ["口播", "分镜", "视频", "发布"] }]
  }
];

export function allDomainSkills(packs: DomainPack[]): string[] {
  return [...new Set(packs.flatMap((pack) => Object.values(pack.skills).flat()))];
}

export function categoryForSkill(skill: string, packs: DomainPack[]): string {
  for (const pack of packs) {
    for (const [category, skills] of Object.entries(pack.skills)) {
      if (skills.includes(skill)) return category;
    }
  }
  return "unknown";
}

export function domainPackFor(domain: string, packs: DomainPack[]): DomainPack {
  return packs.find((pack) => pack.domain === domain) ?? packs.find((pack) => pack.domain === "coding") ?? DEFAULT_DOMAIN_PACKS[0];
}

export function detectDomainFromText(
  text: string,
  packs: DomainPack[]
): { domain: string; confidence: number; evidence: string[] } {
  const scores = packs.map((pack) => {
    const skillHits = Object.values(pack.skills)
      .flat()
      .filter((skill) => text.includes(skill));
    const signalHits = pack.style_signals.flatMap((signal) =>
      signal.patterns.filter((pattern) => text.includes(pattern)).map((pattern) => `${signal.name}:${pattern}`)
    );
    const templateHits = pack.workflow_templates.flatMap((template) =>
      template.filter((step) => text.includes(step)).map((step) => `workflow:${step}`)
    );
    const evidence = [...new Set([...skillHits, ...signalHits, ...templateHits])];
    return {
      domain: pack.domain,
      score: skillHits.length * 3 + templateHits.length * 2 + signalHits.length,
      evidence
    };
  });
  const top = scores.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score <= 0) {
    return { domain: "coding", confidence: 0, evidence: [] };
  }
  const maxScore = Math.max(4, top.evidence.length * 3);
  return {
    domain: top.domain,
    confidence: Number(Math.min(1, top.score / maxScore).toFixed(3)),
    evidence: top.evidence.slice(0, 8)
  };
}

export function detectSessionDomain(session: SessionRecord, packs: DomainPack[]): string {
  if (session.domain) return session.domain;
  return detectDomainFromText(`${session.compressed_text}\n${session.conversation}`, packs).domain;
}
