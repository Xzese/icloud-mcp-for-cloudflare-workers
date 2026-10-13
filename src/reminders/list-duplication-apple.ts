import { requireServiceReady, requireRemindersConnection } from "../auth/apple/services.ts";
import { servicePermissionFence } from "../services/permission-fence.ts";
import type { AppleConnectionService } from "../auth/service.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import type { ListDuplicationFacade } from "./list-duplication.ts";
import { AppError } from "../errors.ts";

export async function listDuplicationAppleFacade(env: RuntimeEnv, owner: string, apple: AppleConnectionService): Promise<ListDuplicationFacade> {
  requireAppleEnabled(env);
  const permissions = await servicePermissionFence(env, owner, "reminders.write", true);
  const requirePermission = permissions.assertCurrent;
  const binding = await new AppleSessionRepository(env, owner).load();
  requireRemindersConnection(binding.session);
  requireServiceReady(binding.session, binding.state, "reminders", binding.action);
  await requirePermission();
  return {
    owner, accountId: binding.session.connection.dsid, generation: binding.fence.generation,
    async assertCurrent(expectedGeneration, expectedAccountId) {
      await requirePermission();
      const current = await new AppleSessionRepository(env, owner).load();
      requireRemindersConnection(current.session);
      requireServiceReady(current.session, current.state, "reminders", current.action);
      if (current.fence.generation !== expectedGeneration || current.session.connection.dsid !== expectedAccountId)
        throw new AppError("CONFLICT", "The duplication belongs to a different Apple account or session.", 409);
      await requirePermission();
    },
    readDuplicationList: (generation, id, missing) => apple.readDuplicationList(generation, id, missing),
    readDuplicationPage: (generation, id, continuation, limit) => apple.readDuplicationPage(generation, id, continuation, limit),
    inspectDuplicationSource: (generation, listId, reminderId) => apple.inspectDuplicationSource(generation, listId, reminderId),
    observeDuplicationReminder: (generation, listId, reminderId) => apple.observeDuplicationReminder(generation, listId, reminderId),
    async createList(request) {
      const result = await apple.mutateList("create", request);
      if (!result.list.recordChangeTag) throw new AppError("PROTOCOL_CHANGED", "The destination creation omitted its version.", 503);
      return { generation: result.generation, listId: result.list.id, recordChangeTag: result.list.recordChangeTag };
    },
    async copyReminder(request) {
      const result = await apple.mutate({ action: "copy", listId: request.sourceListId, reminderId: request.sourceReminderId,
        recordChangeTag: request.sourceReminderRecordChangeTag, sourceListChangeTag: request.sourceListChangeTag,
        destinationListId: request.destinationListId, destinationListChangeTag: request.destinationListChangeTag,
        idempotencyKey: request.idempotencyKey, expectedGeneration: request.expectedGeneration }, undefined, request.expectedRelationshipVersions);
      if (!("listVersions" in result) || !result.listVersions || !result.record.recordChangeTag)
        throw new AppError("PROTOCOL_CHANGED", "The copy omitted its exact List or reminder version receipts.", 503);
      return { generation: result.generation, destinationReminderId: result.record.id,
        destinationReminderRecordChangeTag: result.record.recordChangeTag, listVersions: result.listVersions };
    },
  };
}
