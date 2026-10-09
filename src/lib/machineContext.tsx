import { createContext, useContext, useMemo } from "react";
import * as api from "./api.ts";
export const MachineContext = createContext("local");
export const useMachineId = () => useContext(MachineContext);
/** Bound functions retain their owner across an async upload or a fast PC switch. */
export function useMachineApi() {
  const id = useMachineId();
  return useMemo(() => ({
    fetchPaneTranscript: (pane: string, lines: number) => api.fetchPaneTranscript(pane, lines, id),
    fetchPaneConversation: (pane: string, page?: api.ConversationPageQuery) => api.fetchPaneConversation(pane, id, page),
    fetchPanePrompt: (pane: string) => api.fetchPanePrompt(pane, id),
    fetchPanePromptState: (pane: string) => api.fetchPanePromptState(pane, id),
    answerPanePrompt: (answer: Parameters<typeof api.answerPanePrompt>[0]) => api.answerPanePrompt(answer, id),
    uploadPaneImage: (pane: string, image: Blob) => api.uploadPaneImage(pane, image, id),
    fetchPaneCommands: (pane: string) => api.fetchPaneCommands(pane, id),
    fetchPaneFiles: (pane: string, query: string, limit = 20) => api.fetchPaneFiles(pane, query, limit, id),
    fetchPaneOmoActivity: (pane: string) => api.fetchPaneOmoActivity(pane, id),
    closePane: (pane: string) => api.closePane(pane, id),
    closeWorkspace: (workspace: string) => api.closeWorkspace(workspace, id),
    renamePane: (pane: string, label: string) => api.renamePane(pane, label, id),
    renameWorkspace: (workspace: string, label: string) => api.renameWorkspace(workspace, label, id),
    moveWorkspace: (workspace: string, index: number) => api.moveWorkspace(workspace, index, id),
    fetchAgentKinds: () => api.fetchAgentKinds(id),
    fetchDirectories: (path: string, hidden: boolean, files = false, pane: string | null = null) => api.fetchDirectories(path, hidden, id, files, pane),
    fetchFileInfo: (path: string, pane: string | null) => api.fetchFileInfo(path, pane, id),
    fileUrl: (path: string, pane: string | null, download = false) => api.fileUrl(path, pane, id, download),
    createWorkspace: (request: api.CreateWorkspaceRequest) => api.createWorkspace(request, id),
  }), [id]);
}
