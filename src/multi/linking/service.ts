import type { LinkCodesRepo } from './repo.js'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5

export interface WorkspaceLinkView {
  id: string
  ownerTgId: number | null
  ownerMaxId: number | null
}

export interface WorkspaceLinkWriter {
  findById(id: string): Promise<WorkspaceLinkView | null>
  updateOwnerTg?(id: string, tgId: number): Promise<void>
  updateOwnerMax?(id: string, maxId: number): Promise<void>
}

export interface VerifyAndLinkInput {
  fromChannel: 'telegram' | 'max'
  newChannelUserId: number
}

export type VerifyAndLinkResult =
  | { success: true; workspaceId: string }
  | {
      success: false
      reason: 'invalid_or_expired' | 'workspace_gone' | 'channel_already_linked'
    }

export class LinkingService {
  constructor(
    private codes: LinkCodesRepo,
    private workspaces: WorkspaceLinkWriter,
  ) {}

  async generateCode(workspaceId: string): Promise<string> {
    const recent = await this.codes.countRecentForWorkspace(
      workspaceId,
      RATE_LIMIT_WINDOW_MS,
    )
    if (recent >= RATE_LIMIT_MAX) {
      throw new Error('rate limit: too many codes generated in the past hour')
    }
    const linkCode = await this.codes.create(workspaceId, CODE_TTL_MS)
    return linkCode.code
  }

  async verifyAndLink(
    code: string,
    input: VerifyAndLinkInput,
  ): Promise<VerifyAndLinkResult> {
    const consumed = await this.codes.consume(code)
    if (!consumed) {
      return { success: false, reason: 'invalid_or_expired' }
    }

    const workspace = await this.workspaces.findById(consumed.workspaceId)
    if (!workspace) {
      return { success: false, reason: 'workspace_gone' }
    }

    if (input.fromChannel === 'max') {
      if (
        workspace.ownerMaxId !== null &&
        workspace.ownerMaxId !== input.newChannelUserId
      ) {
        return { success: false, reason: 'channel_already_linked' }
      }
      if (this.workspaces.updateOwnerMax) {
        await this.workspaces.updateOwnerMax(workspace.id, input.newChannelUserId)
      }
    } else {
      if (
        workspace.ownerTgId !== null &&
        workspace.ownerTgId !== input.newChannelUserId
      ) {
        return { success: false, reason: 'channel_already_linked' }
      }
      if (this.workspaces.updateOwnerTg) {
        await this.workspaces.updateOwnerTg(workspace.id, input.newChannelUserId)
      }
    }

    return { success: true, workspaceId: workspace.id }
  }
}
