export interface SkillStep {
  tool: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  trigger: string | { scheduler: string };
  steps: SkillStep[];
}
