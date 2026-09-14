import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BanditConfig, GitHubConfig, SandboxConfig } from '@dovsky/protocol';
import { CHARTER_NAME, EVALUATION_LEVELS, TIERS, type ProjectConfig, type Provider, type ReviewConfig, type WorkflowConfig } from "@dovsky/protocol";
import type { CommandReleaseAdapterConfig } from "./releases.js";
import { parseFontAssetApprovals, type FontAssetApproval } from "./font-assets.js";

export interface ProviderCommandConfig {
  argv: string[];
  reviewArgv?: string[];
  sandbox?: Partial<SandboxConfig>;
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000;
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface RuntimeWorkflowConfig extends WorkflowConfig {
  sandbox?: Partial<SandboxConfig>;
  fontAssets?: FontAssetApproval[];
  providers: Partial<Record<Provider, ProviderCommandConfig>>;
}

export interface RuntimeProjectConfig extends Omit<ProjectConfig, "workflows"> {
  sandbox?: Partial<SandboxConfig>;
  github?: GitHubConfig;
  workflows: RuntimeWorkflowConfig[];
}

export interface DaemonConfig {
  sandbox?: Partial<SandboxConfig>;
  routing?: {bandit?: Partial<BanditConfig>};
  maxQueuedJobs?: number;
  releaseAdapters?: CommandReleaseAdapterConfig[];
  socketPath: string;
  databasePath: string;
  artifactDirectory: string;
  maxActive: number;
  projects: RuntimeProjectConfig[];
}

interface ConfigFile extends Partial<Omit<DaemonConfig, "projects">> {
  projects?: RuntimeProjectConfig[];
}

export interface RuntimePathDefaults {
  home: string;
  socketPath?: string;
}

export function runtimePathDefaults(environment: NodeJS.ProcessEnv = process.env): RuntimePathDefaults {
  return {
    home: environment.DOVSKY_HOME ? resolve(environment.DOVSKY_HOME) : resolve(homedir(), ".dovsky"),
    ...(environment.DOVSKY_SOCKET ? { socketPath: resolve(environment.DOVSKY_SOCKET) } : {}),
  };
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".config", "dovsky", "config.json");
}

export function loadConfig(path: string, defaults?: RuntimePathDefaults): DaemonConfig {
  const configPath = resolve(path);
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFile;
  const base = resolve(configPath, "..");
  const requiredPath = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} must be a non-empty path`);
    }
    return isAbsolute(value) ? value : resolve(base, value);
  };
  const defaultBase = defaults ? resolve(defaults.home) : base;
  const defaultSocketPath = defaults?.socketPath ?? resolve(defaultBase, "run", "dovsky.sock");
  const projects = raw.projects ?? [];
  if (projects.length === 0) throw new Error("At least one project must be configured");
  const ids = new Set<string>();
  for (const project of projects) {
    if (!project.id || ids.has(project.id)) throw new Error(`Duplicate or empty project id: ${project.id}`);
    ids.add(project.id);
    project.path = realpathSync(requiredPath(project.path, `projects.${project.id}.path`));
    const workflowIds = new Set<string>();
    for (const workflow of project.workflows) {
      if (!workflow.id || workflowIds.has(workflow.id)) {
        throw new Error(`Duplicate or empty workflow id in ${project.id}: ${workflow.id}`);
      }
      workflowIds.add(workflow.id);
      for (const [name, value] of [["providerTimeoutMs", workflow.providerTimeoutMs], ["gateTimeoutMs", workflow.gateTimeoutMs]] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < MIN_COMMAND_TIMEOUT_MS || value > MAX_COMMAND_TIMEOUT_MS)) {
          throw new Error(`${name} in ${project.id}/${workflow.id} must be an integer from ${MIN_COMMAND_TIMEOUT_MS} to ${MAX_COMMAND_TIMEOUT_MS}`);
        }
      }
      if (workflow.fontAssets !== undefined) workflow.fontAssets = parseFontAssetApprovals(workflow.fontAssets);
      for (const [provider, command] of Object.entries(workflow.providers)) {
        if (provider !== "claude" && provider !== "codex") {
          throw new Error(`Unsupported provider in ${project.id}/${workflow.id}: ${provider}`);
        }
        if (!command || !Array.isArray(command.argv) || command.argv.length === 0) {
          throw new Error(`Provider ${provider} in ${project.id}/${workflow.id} needs a fixed argv`);
        }
      }
      for (const command of workflow.qualityCommands) {
        if (!Array.isArray(command) || command.length === 0) {
          throw new Error(`Quality commands in ${project.id}/${workflow.id} must be non-empty argv arrays`);
        }
      }
    }
    for (const workflow of project.workflows) {
      if (workflow.review) validateReview(project, workflow, workflow.review);
      const evaluation = workflow.evaluation;
      if (evaluation) {
        if (evaluation.dependencyRoots !== undefined && (!Array.isArray(evaluation.dependencyRoots) || evaluation.dependencyRoots.some((path) => typeof path !== "string" || isAbsolute(path) || path.split("/").includes("..") || !/(^|\/)node_modules$/.test(path)))) throw new Error(`Invalid evaluation dependency roots in ${project.id}/${workflow.id}`);
        if (typeof evaluation.enabled !== "boolean" || !EVALUATION_LEVELS.includes(evaluation.defaultLevel) || typeof evaluation.runner !== "string" || !evaluation.runner.endsWith(".mjs") || isAbsolute(evaluation.runner) || evaluation.runner.split("/").includes("..")) throw new Error(`Invalid evaluation policy in ${project.id}/${workflow.id}`);
        if (evaluation.enabled) {
          if (workflow.readOnly || !workflow.review?.enabled || !workflow.qualityCommands.length) throw new Error(`Evaluation in ${project.id}/${workflow.id} needs a change workflow with gates and review enabled`);
          readFileSync(resolve(project.path, evaluation.runner));
        }
      }
    }
  }

  const maxActive = raw.maxActive ?? 3;
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 16) {
    throw new Error("maxActive must be an integer from 1 to 16");
  }
  const config:DaemonConfig = {
    ...(raw.releaseAdapters === undefined ? {} : { releaseAdapters: raw.releaseAdapters }),
    socketPath: raw.socketPath === undefined ? defaultSocketPath : requiredPath(raw.socketPath, "socketPath"),
    databasePath: raw.databasePath === undefined ? resolve(defaultBase, "state", "dovsky.db") : requiredPath(raw.databasePath, "databasePath"),
    artifactDirectory: raw.artifactDirectory === undefined ? resolve(defaultBase, "artifacts") : requiredPath(raw.artifactDirectory, "artifactDirectory"),
    maxActive,
    maxQueuedJobs:raw.maxQueuedJobs ?? 200,
    ...(raw.sandbox === undefined ? {} : {sandbox:raw.sandbox}),
    ...(raw.routing === undefined ? {} : {routing:raw.routing}),
    projects,
  };
  if(!Number.isInteger(config.maxQueuedJobs)||config.maxQueuedJobs!<1||config.maxQueuedJobs!>10_000)throw new Error('maxQueuedJobs must be an integer from 1 to 10000');
  resolveBandit(config);
  resolveSandbox(config);
  for(const project of projects){
    if(project.github){
      const github=project.github;
      if(typeof github.enabled!=='boolean'||typeof github.draft!=='boolean'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repository)||!github.remote||github.remote.startsWith('-')||!github.baseBranch||github.baseBranch.startsWith('-')||![github.remote,github.baseBranch,github.commitName,github.commitEmail].every(value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\r\n\0]/.test(value)))throw new Error(`Invalid GitHub configuration in ${project.id}`);
    }
    resolveSandbox(config,project);
    for(const workflow of project.workflows){
      resolveSandbox(config,project,workflow);
      if(workflow.review?.maxRollouts!==undefined&&(!Number.isInteger(workflow.review.maxRollouts)||workflow.review.maxRollouts<1||workflow.review.maxRollouts>3))throw new Error('review.maxRollouts must be an integer from 1 to 3');
      if(workflow.review?.rolloutRankBy!==undefined&&workflow.review.rolloutRankBy!=='fewest-lines')throw new Error('review.rolloutRankBy must be fewest-lines');
      for(const provider of Object.values(workflow.providers)){
        if(!provider)continue;
        for(const argv of [provider.argv,provider.reviewArgv])if(argv!==undefined&&(!Array.isArray(argv)||!argv.length||argv.some(part=>typeof part!=='string'||!part||part.includes('\0'))))throw new Error('Provider argv must contain nonempty strings');
        if(workflow.readOnly&&[provider.argv,provider.reviewArgv??[]].some(argv=>argv.some(part=>['workspace-write','danger-full-access','--dangerously-bypass-approvals-and-sandbox','--yolo'].includes(part)||/^--sandbox=(workspace-write|danger-full-access)$/.test(part))))throw new Error('Read-only workflows cannot configure writable provider sandbox argv');
        resolveSandbox(config,project,workflow,provider);
      }
    }
  }
  return config;
}

export function resolveBandit(config:DaemonConfig):BanditConfig {
  const input=config.routing?.bandit;
  const value:BanditConfig={enabled:true,costPenalty:0.15,costWeights:{quick:1,routine:2,hard:5,frontier:12},explorationCap:0.15,decay:0.995,widenSingleRungLadders:true,recentWindow:100,...input};
  if(typeof value.enabled!=='boolean'||typeof value.widenSingleRungLadders!=='boolean'||![value.costPenalty,value.explorationCap].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||!Number.isFinite(value.decay)||value.decay<=0||value.decay>1||!Number.isInteger(value.recentWindow)||value.recentWindow<1||value.recentWindow>100_000||!value.costWeights||!TIERS.every(tier=>Number.isFinite(value.costWeights[tier])&&value.costWeights[tier]>0))throw new Error('Invalid routing.bandit configuration');
  return value;
}

export function resolveSandbox(config:DaemonConfig,project?:RuntimeProjectConfig,workflow?:RuntimeWorkflowConfig,provider?:ProviderCommandConfig):SandboxConfig {
  const value:SandboxConfig={enabled:true,backend:'bwrap',network:true,memoryMax:'8G',cpuQuota:'400%',tasksMax:512,homePaths:[],runtimePaths:[],dependencyRoots:[],...config.sandbox,...project?.sandbox,...workflow?.sandbox,...provider?.sandbox};
  if(value.enabled!==true||value.backend!=='bwrap')throw new Error('Production execution requires the bwrap sandbox; no disabled or fallback backend is permitted');
  if(typeof value.network!=='boolean'||!/^\d+(?:\.\d+)?[KMGT]?$/.test(value.memoryMax)||parseFloat(value.memoryMax)<=0||!/^\d+%$/.test(value.cpuQuota)||parseInt(value.cpuQuota)<=0||!Number.isInteger(value.tasksMax)||value.tasksMax<1||value.tasksMax>4096)throw new Error('Invalid finite sandbox resource limits');
  const inside=(a:string,b:string):boolean=>{const path=relative(a,b);return path===''||path!=='..'&&!path.startsWith('../')&&!isAbsolute(path);};
  const sensitive=[dirname(config.socketPath),dirname(config.databasePath),config.artifactDirectory].map(path=>resolve(path));
  for(const key of ['homePaths','runtimePaths','dependencyRoots'] as const){
    if(!Array.isArray(value[key]))throw new Error(`sandbox.${key} must be an array`);
    value[key]=value[key].map(path=>{
      if(typeof path!=='string'||path.split('/').includes('..'))throw new Error(`Unsafe sandbox.${key} path`);
      const expanded=path.startsWith('~/')?resolve(homedir(),path.slice(2)):path;
      if(!isAbsolute(expanded)||!existsSync(expanded))throw new Error(`sandbox.${key} paths must be existing absolute paths`);
      const actual=realpathSync(expanded);
      if(key==='homePaths'&&!inside(homedir(),actual))throw new Error('sandbox.homePaths must stay under the operator home');
      if(sensitive.some(secret=>inside(actual,secret)||inside(secret,actual)))throw new Error('Sandbox mounts cannot overlap administrative state');
      if(key==='dependencyRoots'&&project){
        const local=relative(project.path,actual);
        if(!local||isAbsolute(local)||local==='..'||local.startsWith('../')||local.split('/').at(-1)!=='node_modules')throw new Error('sandbox.dependencyRoots must name project-local node_modules directories');
      }else if(project&&inside(actual,project.path))throw new Error('Sandbox mounts cannot expose the canonical project');
      return actual;
    });
  }
  return value;
}

function validateReview(project: RuntimeProjectConfig, workflow: RuntimeWorkflowConfig, review: ReviewConfig): void {
  const where = `review in ${project.id}/${workflow.id}`;
  if (typeof review.enabled !== "boolean") throw new Error(`${where}: enabled must be a boolean`);
  if (review.provider !== "other" && review.provider !== "claude" && review.provider !== "codex") {
    throw new Error(`${where}: provider must be other, claude or codex`);
  }
  if (!TIERS.includes(review.tier)) throw new Error(`${where}: tier must be one of ${TIERS.join(", ")}`);
  if (!Number.isInteger(review.maxCorrections) || review.maxCorrections < 0 || review.maxCorrections > 2) {
    throw new Error(`${where}: maxCorrections must be an integer from 0 to 2`);
  }
  if (review.small === undefined) {
    review.small = { maxFiles: 3, maxLines: 150, tier: "routine" };
  } else if (review.small !== null) {
    if (!Number.isInteger(review.small.maxFiles) || review.small.maxFiles < 1) {
      throw new Error(`${where}: small.maxFiles must be an integer >= 1`);
    }
    if (!Number.isInteger(review.small.maxLines) || review.small.maxLines < 1) {
      throw new Error(`${where}: small.maxLines must be an integer >= 1`);
    }
    if (!TIERS.includes(review.small.tier)) throw new Error(`${where}: small.tier must be one of ${TIERS.join(", ")}`);
  }
  if (review.charter !== undefined && !CHARTER_NAME.test(review.charter)) throw new Error(`${where}: invalid charter name`);
  if (!reviewWorkflow(project, review)) throw new Error(`${where}: needs a read-only workflow in the same project`);
}

/** Workflow a reviewer runs under: the configured one, else the project's first read-only workflow. */
export function reviewWorkflow(project: RuntimeProjectConfig, review: ReviewConfig): RuntimeWorkflowConfig | null {
  const candidates = project.workflows.filter((candidate) => candidate.readOnly);
  if (review.workflowId === undefined) return candidates[0] ?? null;
  return candidates.find((candidate) => candidate.id === review.workflowId) ?? null;
}

export function findProject(config: DaemonConfig, projectId: string): RuntimeProjectConfig {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new DaemonError("PROJECT_NOT_ALLOWED", `Project is not configured: ${projectId}`);
  return project;
}

export function findWorkflow(project: RuntimeProjectConfig, workflowId: string): RuntimeWorkflowConfig {
  const workflow = project.workflows.find((candidate) => candidate.id === workflowId);
  if (!workflow) {
    throw new DaemonError(
      "WORKFLOW_NOT_ALLOWED",
      `Workflow is not configured for project ${project.id}: ${workflowId}`,
    );
  }
  return workflow;
}

export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}
