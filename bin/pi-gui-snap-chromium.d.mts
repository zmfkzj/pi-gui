// Types of bin/pi-gui-snap-chromium.mjs (plain JavaScript: it runs as a program on worker desktops, outside Pi).

export const SNAP_BIN: string;
export const SNAP_COMMAND: string;
export const SNAP_ROOT: string;
export const SYSTEMD_RUN: string;
export const BROWSER_PROGRAM: RegExp;
export const LAUNCH_PREFIX: string;
export const STAGE_ENV: string;
export const MARKER_ENV: string;
export const LOG_ENV: string;
export const PROFILE_ENV: string;
export const PROFILES_DIR: string;
export const PROFILE_NAME: RegExp;
export const REFUSED_EXIT: number;
export const LAUNCH_SUBDIRS: string[];
export function profileOf(dir: string): string;
export const VERIFIED_CHAINS: Set<string>;
export const BROWSER_FLAGS: string[];
export function inSnapScript(options?: { program?: string; dirPrefix?: string }): string;

export interface SnapCheckFs { exists(path: string): boolean; read(path: string): string; list(path: string): string[] }
export function commandChain(snapYaml: string): string[];
export function chainReason(root: string, read?: (path: string) => string, list?: (path: string) => string[]): string | undefined;
export function policyReason(fs: Pick<SnapCheckFs, "read" | "list">): string | undefined;
export function currentRevision(resolve?: (path: string) => string): string | undefined;
export function snapChromiumReason(options?: { fs?: Partial<SnapCheckFs>; revision?: () => string | undefined }): string | undefined;
type Statfs = (path: string) => { bavail: number | bigint; bsize: number | bigint; ffree: number | bigint; files: number | bigint };
export function runtimeSpaceReason(path: string, options?: { statfs?: Statfs }): string | undefined;

export interface PrivateDesktop {
  runtime: string; marker: string; display: string; uid: number; userRuntime: string;
  sockets: { wayland: string; bus: string; atspi: string };
}
export function privateDesktop(env: NodeJS.ProcessEnv, options?: { uid?: number; userRuntime?: string }): PrivateDesktop | { error: string };
export const DESKTOPS_DIR: string;
export function snapRuntimeDir(desktop: PrivateDesktop): string;
export function launchDir(snapDir: string, options?: { uid?: number }): string;
export interface AgentProfilePaths { root: string; config: string; profile: string }
export function agentProfilePaths(name: string, home?: string): AgentProfilePaths;
export function prepareAgentProfile(name: string, options?: { uid?: number; home?: string }): AgentProfilePaths;
export function profileLockName(name: string, uid?: number): string;
export function lockAgentProfile(name: string, uid?: number): Promise<import("node:net").Server | undefined>;
/** A launch record (owner.json); agent-profile launches also name the profile, their desktop and its view tag. */
export interface LaunchRecord { pid: number; runtime: string; profile: string; agentProfile?: string; display?: string; tag?: string; [key: string]: unknown }
export type AgentProfileUse = { owner: LaunchRecord; dir: string } | { lock: true } | { pid: number };
export function agentProfileUse(name: string, options?: {
  uid?: number; proc?: string; cgroupRoot?: string; snapDir?: string; netUnix?: string; home?: string; profile?: string; program?: RegExp; ownLock?: boolean;
}): AgentProfileUse | undefined;
export function browserEnvironment(env: NodeJS.ProcessEnv, desktop: PrivateDesktop, dir: string): Record<string, string | undefined>;
export function browserArguments(urls: string[]): string[];
export function launchCommand(unit: string, revision: string, dir: string, args: string[], profileName?: string): [string, string[]];
export function snapCommand(revision: string, dir: string, args: string[], script?: string, profileName?: string): [string, string[]];
export function processInfo(pid: number, proc?: string): { ppid: number; start: string; state: string } | undefined;
export function findBrowser(rootPid: number, proc?: string, program?: RegExp): { pid: number; start: string; profiles: string[] } | undefined;
export const SCOPE_PREFIX: string;
export function scopeOf(pid: number, unit: string, proc?: string): string | undefined;
export function scopeProcs(path: string, cgroupRoot?: string): number[];
export function removeLaunchDir(dir: string): boolean;
export function readRecord(dir: string): Record<string, unknown> | undefined;
export function sweepStale(snapDir: string, proc?: string, log?: (line: string) => void, cgroupRoot?: string): void;

export interface SuperviseOptions {
  env?: NodeJS.ProcessEnv; urls?: string[]; snapBin?: string; revision?: string; inSnap?: { program?: string; dirPrefix?: string }; browserProgram?: RegExp;
  proc?: string; cgroupRoot?: string; uid?: number; userRuntime?: string; home?: string; profileName?: string;
  log?: (line: string) => void; pollMs?: number; startTimeoutMs?: number; stopTimeoutMs?: number; skipSnapCheck?: boolean; statfs?: Statfs;
  stdio?: "ignore" | "inherit" | number; onState?: (state: Record<string, unknown> & { dir: string }) => void;
}
export function supervise(options: SuperviseOptions): Promise<number>;
