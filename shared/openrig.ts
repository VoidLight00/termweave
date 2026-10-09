export interface OpenRigTeam { rigId: string; name: string; rigName: string; nodeCount: number; runningCount: number; status: string; isArchived: boolean }
export interface OpenRigOverview { connected: true; checkedAt: string; teams: OpenRigTeam[]; views: {rigs: string[]; saved: {id: string; name?: string}[]}; provider: {available: boolean; alive: boolean; version?: string} }
export type OpenRigRecord = Record<string, unknown>;
export interface OpenRigItems {items: OpenRigRecord[]; limit: number; truncated: boolean}
export interface OpenRigTeamDetail {rigId: string; nodes: OpenRigRecord[]; queue: OpenRigItems; attention: OpenRigItems; snapshots: OpenRigRecord[]; checkedAt: string}
export interface OpenRigAbsent {seat: string; host: string | null; reason: string}
export interface OpenRigPreview {provider: 'herdr'; view: string; planId: string; opened: {seat: string; label: string; runtime?: string; readOnly: boolean}[]; absent: OpenRigAbsent[]; degraded: OpenRigAbsent[]; pages: number; available: boolean}
export interface OpenRigOpenResult {
  terminalIdentities?:OpenRigTerminalIdentity[];ok: boolean; opened: string[]; absent: OpenRigAbsent[]; degraded: OpenRigAbsent[]; pages: number; code?: string; outcome: 'complete' | 'partial' | 'failed'}
export interface OpenRigReadiness {checkedAt:string;ready:boolean;providers:{runtime:'claude-code'|'codex';authenticated:boolean;permissionsSupported:boolean;reason:string}[];blockers:string[]}
export interface OpenRigStarterPlan {planId:string;expiresAt:string;input:{projectPath:string;source:'official-starter';teamName:string};status:'planned';stages:{stage:string;status:string}[];warnings:string[];permissions:{seat:string;posture:'floor';mode:string;verified:boolean}[];readiness:OpenRigReadiness}
export interface OpenRigStarterLaunch {status:string;rigId?:string;outcome:'started'|'attention'|'failed';checkedAt:string}
export interface OpenRigQueueCreate {notify?:boolean;rigId:string;destinationSession:string;summary:string;body:string;requestId:string}
export interface OpenRigQueueResult {item:OpenRigRecord;actor:'human@kernel';provenance:'claimed:v1';delivery:'recorded_without_nudge'|'notification_requested'|'notification_failed'}
export interface OpenRigQueueDetail {item:OpenRigRecord;transitions:OpenRigRecord[];checkedAt:string}
export interface OpenRigRecoveryPlan {planId:string;rigId:string;expiresAt:string;snapshot:{id:string;kind:string;createdAt:string}|null;nodes:OpenRigRecord[];canRestore:boolean;blockers:string[]}
export interface OpenRigRestoreStarted {status:'started';rigId:string;attemptId:number}
export interface OpenRigRestoreStatus {status:'running'|'completed';rigId:string;attemptId:number;verdict?:string;nodes:OpenRigRecord[]}
export interface OpenRigQueueHandoff {rigId:string;qitemId:string;toSession:string;expectedState:string;expectedUpdatedAt:string;requestId:string;summary:string}
export interface OpenRigQueueHandoffResult {closed:OpenRigRecord;created:OpenRigRecord;actor:'human@kernel';provenance:'claimed:v1';delivery:'recorded_without_nudge'}

export interface OpenRigTerminalIdentity {seat:string;paneId:string;terminalId:string;workspaceId:string;tabId:string;generation:string;paneNumber:number}
