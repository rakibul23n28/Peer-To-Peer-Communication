import { apiRequest } from "../session"
import {
  sharedFolderRecordSchema,
  type SharedFolderRecord,
} from "../../shared/sharedFolders"

export async function createSharedFolder(
  conversationId: string,
  input: Pick<SharedFolderRecord, "id" | "ciphertext" | "iv" | "formatVersion" | "compressed">,
): Promise<SharedFolderRecord> {
  const record = await apiRequest<unknown>(`/conversations/${encodeURIComponent(conversationId)}/shared-folders`, {
    method: "POST",
    body: JSON.stringify(input),
  })
  return sharedFolderRecordSchema.parse(record)
}

export async function listSharedFolders(conversationId: string): Promise<SharedFolderRecord[]> {
  const records = await apiRequest<unknown>(`/conversations/${encodeURIComponent(conversationId)}/shared-folders`)
  return sharedFolderRecordSchema.array().parse(records)
}

export async function getSharedFolder(id: string): Promise<SharedFolderRecord> {
  const record = await apiRequest<unknown>(`/shared-folders/${encodeURIComponent(id)}`)
  return sharedFolderRecordSchema.parse(record)
}

export function revokeSharedFolder(id: string): Promise<{ id: string; conversationId: string }> {
  return apiRequest<{ id: string; conversationId: string }>(`/shared-folders/${encodeURIComponent(id)}`, { method: "DELETE" })
}
